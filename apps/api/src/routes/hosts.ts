import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  HostComputerSandbox,
  registeredHostEndpoint,
  revokeRegisteredHost,
} from "@rakazo/adapters";
import type { RegisteredHost } from "@rakazo/contracts";
import { assertNativeSetupAdmission } from "../native-setup-admission.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

function view(row: {
  id: string;
  name: string;
  endpoint: string;
  revokedAt: Date | null;
  revocationPending?: boolean;
  healthStatus: string;
  healthCheckedAt: Date | null;
}): RegisteredHost {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revocationPending: row.revocationPending ?? false,
    healthStatus: row.healthStatus as RegisteredHost["healthStatus"],
    healthCheckedAt: row.healthCheckedAt?.toISOString() ?? null,
  };
}
export function hostsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    hosts: {
      directories: authed.hosts.directories.handler(async ({ context, input }) => {
        if (!deps.hostDirectories) throw new ORPCError("NOT_FOUND");
        try {
          await deps.prisma.$transaction((tx) => assertNativeSetupAdmission(tx, context.actor));
          return await deps.hostDirectories(input, {
            ...computerContext(context.actor, "setup", "hosts.directories"),
            signal: context.signal
              ? AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000),
          });
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not browse folders. Check the selected host and local consent.",
          });
        }
      }),
      list: authed.hosts.list.handler(async ({ context }) => {
        const rows = await deps.prisma.registeredHost.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return rows.map(view);
      }),
      register: authed.hosts.register.handler(async ({ context, input }) => {
        let endpoint: string;
        try {
          endpoint = registeredHostEndpoint(input.endpoint);
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Use an HTTPS host origin, or HTTP on loopback",
          });
        }
        const id = randomUUID();
        const secret = await deps.secrets.put(
          input.token,
          computerContext(context.actor, "registry", "hosts.register"),
          { recordId: id },
        );
        const row = await deps.prisma.$transaction(async (tx) => {
          await assertNativeSetupAdmission(tx, context.actor);
          return tx.registeredHost.create({
            data: {
              id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              name: input.name,
              endpoint,
              ciphertext: secret.ciphertext,
            },
          });
        });
        return view(row);
      }),
      revoke: authed.hosts.revoke.handler(async ({ context, input }) => {
        const where = {
          id: input.hostId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        };
        const found = await deps.prisma.registeredHost.findFirst({ where });
        if (!found) throw new ORPCError("NOT_FOUND");
        return view(await revokeRegisteredHost(deps, context.actor, input.hostId));
      }),
      check: authed.hosts.check.handler(async ({ context, input }) => {
        const where = {
          id: input.hostId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        };
        const host = await deps.prisma.registeredHost.findFirst({ where });
        if (!host) throw new ORPCError("NOT_FOUND");
        if (host.revokedAt) return view(host);
        let available = false;
        try {
          const transport = new HostComputerSandbox(
            host.endpoint,
            await deps.secrets.load(host.ciphertext, host.id),
          );
          await transport.environment(
            { id: "registry", botId: "registry", kind: "desktop", providerRef: "registry" },
            {
              ...computerContext(context.actor, "registry", "hosts.check"),
              signal: AbortSignal.timeout(5000),
            },
          );
          available = true;
        } catch {
          /* Host errors and credentials must never enter the registry DTO or logs. */
        }
        await deps.prisma.registeredHost.updateMany({
          where: { ...where, revokedAt: null },
          data: {
            healthStatus: available ? "available" : "unavailable",
            healthCheckedAt: new Date(),
          },
        });
        return view(await deps.prisma.registeredHost.findFirstOrThrow({ where }));
      }),
    },
  };
}
