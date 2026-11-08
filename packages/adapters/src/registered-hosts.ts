import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { isCloudMetadataHost, isLinkLocalAddress, isLoopbackHost } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";

/** Registration is explicit trust in an execution host, never an execution-time URL. */
export function registeredHostEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    isCloudMetadataHost(url.hostname) ||
    isLinkLocalAddress(url.hostname) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
  )
    throw new Error("Use an HTTPS host origin, or HTTP on loopback");
  return url.origin;
}

export function createHostComputerTransport(options: {
  prisma: PrismaClient;
  secrets: SecretStore;
  hostComputerUrl?: string;
  hostComputerToken?: string;
}): HostComputerSandbox {
  return new HostComputerSandbox(async (input: HostComputerRequest, context: AdapterContext) => {
    const scope = { spaceId: context.spaceId, userId: context.userId };
    let hostId: string | null = null;
    let resolvedComputerId: string | undefined;
    let validateBrowser: (() => Promise<void>) | undefined;
    if (input.method === "browserRevokeScope")
      throw new Error("Browser revocation requires the private cleanup transport");
    if (
      (input.method.startsWith("codex") &&
        input.method !== "codexStatus" &&
        input.method !== "codexModels") ||
      (input.method === "cancelRunWork" && context.requireRunCleanup)
    ) {
      if (!context.runId) throw new Error("Native host execution requires a pinned run");
      if (
        "config" in input &&
        "applicationRunId" in input.config &&
        input.config.applicationRunId !== undefined &&
        input.config.applicationRunId !== context.runId
      )
        throw new Error("Native application owner binding mismatch");
      const run = await options.prisma.run.findFirst({
        where: { id: context.runId, ...scope },
        select: { nativeHostId: true, nativeComputerId: true, modelProvider: true },
      });
      if (!run) throw new Error("Host execution is unavailable");
      if (input.method.startsWith("codex")) {
        const requested = "nativeKind" in input ? (input.nativeKind ?? "codex") : "codex";
        const expected = run.modelProvider?.endsWith("-native")
          ? run.modelProvider.slice(0, -7)
          : "codex";
        if (requested !== expected) throw new Error("Native runtime identity changed");
      }
      const native = !!run.nativeComputerId;
      let computerId = run.nativeComputerId;
      if (!computerId && input.method === "cancelRunWork") {
        const lease = await options.prisma.computerExecutionLease.findFirst({
          where: { runId: context.runId },
          select: { computerId: true },
        });
        computerId = lease?.computerId ?? null;
      }
      if (!computerId) throw new Error("Native host execution is not pinned");
      const computer = await options.prisma.computer.findFirst({
        where: { id: computerId, ...scope },
      });
      if (
        !computer ||
        (native && computer.registeredHostId !== run.nativeHostId) ||
        (input.method === "cancelRunWork" && computer.homeKey !== input.botId) ||
        (input.method === "codexRetire" && computer.homeKey !== input.computerKey)
      )
        throw new Error("Native host identity changed");
      resolvedComputerId = computerId;
      hostId = computer.registeredHostId;
    } else if (input.method === "codexStatus" || input.method === "codexModels") {
      const bot = await options.prisma.bot.findFirst({
        where: { id: input.botId, ...scope },
        select: { registeredHostId: true, runtimeKind: true, projectPath: true },
      });
      if (!bot) throw new Error("Host is unavailable");
      const requested = "nativeKind" in input ? (input.nativeKind ?? "codex") : "codex";
      if (bot.runtimeKind !== "pi" && requested !== bot.runtimeKind)
        throw new Error("Native runtime identity changed");
      if (
        input.method === "codexModels" &&
        (bot.runtimeKind !== "codex" || input.projectPath !== bot.projectPath)
      )
        throw new Error("Native project identity changed");
      hostId = bot.registeredHostId;
    } else if (input.method.startsWith("browser") && "scope" in input) {
      if (
        input.scope.spaceId !== context.spaceId ||
        input.scope.userId !== context.userId ||
        input.scope.botId !== context.botId
      )
        throw new Error("Host browser identity mismatch");
      const computer = await options.prisma.computer.findFirst({
        where: { homeKey: input.botId, ...scope },
        select: { id: true, registeredHostId: true, scope: true },
      });
      if (
        !computer ||
        computer.scope !== input.scope.mode ||
        (computer.registeredHostId ?? null) !== (input.scope.registrationId ?? null)
      )
        throw new Error("Host browser computer is unavailable");
      const actingBot = input.scope.botId;
      const computerId = computer.id;
      const check = async () => {
        const bot = await options.prisma.bot.count({
          where: { id: actingBot, ...scope, computerId, archivedAt: null },
        });
        if (bot !== 1) throw new Error("Host browser placement changed");
        if (
          (input.method === "browserControl" || input.method === "browserScreen") &&
          input.interactive
        ) {
          if (
            !input.controlToken ||
            !(await options.prisma.computer.count({
              where: {
                id: computerId,
                ...scope,
                controlHolder: "user",
                controlBotId: actingBot,
                controlLeaseId: input.controlToken,
                controlLeaseExpiresAt: { gt: new Date() },
              },
            }))
          )
            throw new Error("Host browser control lease changed");
        }
      };
      await check();
      validateBrowser = check;
      resolvedComputerId = computer.id;
      hostId = computer.registeredHostId;
    } else {
      const computer = await options.prisma.computer.findFirst({
        where: { homeKey: input.botId, ...scope },
        select: { id: true, registeredHostId: true },
      });
      if (!computer) throw new Error("Host computer is unavailable");
      resolvedComputerId = computer.id;
      hostId = computer.registeredHostId;
    }
    if (!hostId)
      return {
        url: options.hostComputerUrl ?? "",
        token: options.hostComputerToken ?? "",
        ...(validateBrowser ? { validate: validateBrowser } : {}),
      };
    const host = await options.prisma.registeredHost.findFirst({
      where: { id: hostId, ...scope },
    });
    if (!host) throw new Error("Registered host access is revoked or unavailable");
    if (host.revokedAt) {
      // Completed revocation permits only teardown of the exact persisted computer.
      // This does not reopen execution, reads, writes, setup, or native session traffic.
      let cleanupAllowed =
        !host.revocationPending &&
        !!resolvedComputerId &&
        (input.method === "stop" || input.method === "destroy");
      if (input.method === "cancelRunWork" && context.requireRunCleanup) {
        cleanupAllowed =
          !host.revocationPending &&
          !!(await options.prisma.registeredHostCleanup.findFirst({
            where: {
              hostId: host.id,
              ...scope,
              runId: context.runId,
              computerId: resolvedComputerId,
              computerKey: input.botId,
              targetRunId: input.targetRunId,
              completedAt: { not: null },
            },
            select: { id: true },
          }));
      }
      if (!cleanupAllowed) throw new Error("Registered host access is revoked or unavailable");
      return {
        url: registeredHostEndpoint(host.endpoint),
        token: await options.secrets.load(host.ciphertext, host.id),
      };
    }
    return {
      url: registeredHostEndpoint(host.endpoint),
      token: await options.secrets.load(host.ciphertext, host.id),
      validate: async () => {
        await validateBrowser?.();
        const active = await options.prisma.registeredHost.count({
          where: { id: host.id, ...scope, revokedAt: null },
        });
        if (!active) throw new Error("Registered host access is revoked");
      },
    };
  });
}
