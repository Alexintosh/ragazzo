import { createHash } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { NativeSetupInput, NativeSetupView } from "@rakazo/contracts";
import { NativeSetupViewSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { HostComputerSandbox } from "./host-computer-sandbox.js";

type NativeSetupTransportOptions = {
  prisma: PrismaClient;
  secrets: SecretStore;
  hostComputerUrl?: string;
  hostComputerToken?: string;
};
export function nativeSetupScopeKey(spaceId: string, userId: string, hostId: string | null) {
  return createHash("sha256")
    .update(JSON.stringify([spaceId, userId, hostId]))
    .digest("hex");
}

/** Called by authorized deletion teardown before owner or registration rows disappear. */
export async function revokeNativeSetupScopes(
  options: NativeSetupTransportOptions,
  owners: Array<{ spaceId: string; userId: string }>,
) {
  if (!owners.length) return;
  if (owners.some((owner) => !owner.spaceId || !owner.userId))
    throw new Error("Setup revocation requires explicit owners");
  // One deadline for the entire batch, including retries across owner identities.
  const signal = AbortSignal.timeout(30_000);
  const uniqueOwners = [...new Map(owners.map((owner) => [JSON.stringify(owner), owner])).values()];
  const hosts = await options.prisma.registeredHost.findMany({
    where: {
      AND: [{ OR: uniqueOwners }, { OR: [{ revokedAt: null }, { revocationPending: true }] }],
    },
  });
  const targets = hosts.map((host) => ({
    spaceId: host.spaceId,
    userId: host.userId,
    hostId: host.id as string | null,
    url: host.endpoint,
    token: () => options.secrets.load(host.ciphertext, host.id),
  }));
  if (options.hostComputerUrl && options.hostComputerToken)
    for (const owner of uniqueOwners)
      targets.push({
        ...owner,
        hostId: null,
        url: options.hostComputerUrl,
        token: async () => options.hostComputerToken!,
      });
  for (const target of targets) {
    const transport = new HostComputerSandbox(async () => ({
      url: target.url,
      token: await target.token(),
    }));
    let acknowledged = false;
    for await (const value of transport.request<{ revoked: boolean }>(
      {
        method: "nativeSetupScopeRevoke",
        botId: "setup",
        scopeKey: nativeSetupScopeKey(target.spaceId, target.userId, target.hostId),
      },
      {
        spaceId: target.spaceId,
        userId: target.userId,
        operationId: "native-setup-scope-revoke",
        traceId: "native-setup-scope-revoke",
        signal,
      },
    ))
      acknowledged = value.revoked === true;
    if (!acknowledged) throw new Error("Runtime setup cleanup uncertain");
  }
}

/** Registry resolution is owned by the API, never by a client URL or provider command. */
export function createNativeSetupTransport(options: NativeSetupTransportOptions) {
  return async (input: NativeSetupInput, context: AdapterContext): Promise<NativeSetupView> => {
    const where = input.hostId
      ? { id: input.hostId, spaceId: context.spaceId, userId: context.userId, revokedAt: null }
      : undefined;
    const host = where ? await options.prisma.registeredHost.findFirst({ where }) : undefined;
    if (where && !host) throw new Error("Host setup unavailable");
    const transport = new HostComputerSandbox(async () => ({
      url: host?.endpoint ?? options.hostComputerUrl ?? "",
      token: host
        ? await options.secrets.load(host.ciphertext, host.id)
        : (options.hostComputerToken ?? ""),
      validate: async () => {
        if (where && !(await options.prisma.registeredHost.count({ where })))
          throw new Error("Host setup unavailable");
      },
    }));
    const scopeKey = nativeSetupScopeKey(context.spaceId, context.userId, input.hostId);
    let result: NativeSetupView | undefined;
    for await (const value of transport.request<NativeSetupView>(
      {
        method: "nativeSetup",
        botId: "setup",
        scopeKey,
        registrationId: input.hostId,
        kind: input.kind,
        action: input.action,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      { ...context, runId: undefined },
    ))
      result = NativeSetupViewSchema.parse(value);
    if (
      !result ||
      result.kind !== input.kind ||
      (input.sessionId && result.session?.id !== input.sessionId)
    )
      throw new Error("Host setup unavailable");
    // A revoked registration must not reveal a challenge from an in-flight response.
    if (where && !(await options.prisma.registeredHost.count({ where })))
      throw new Error("Host setup unavailable");
    return result;
  };
}
