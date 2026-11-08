import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  expireComputerExecutionLeases,
  IsolationError,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { registeredHostEndpoint } from "./registered-hosts.js";

type Deps = { prisma: PrismaClient; secrets: SecretStore };

/** Disable all normal traffic first. The retry marker commits before teardown can fail. */
export async function revokeRegisteredHost(deps: Deps, actor: Actor, hostId: string) {
  const where = { id: hostId, spaceId: actor.spaceId, userId: actor.userId };
  const host = await deps.prisma.registeredHost.findFirst({ where });
  if (!host) throw new IsolationError();
  await deps.prisma.registeredHost.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: new Date(), healthStatus: "revoked", revocationPending: true },
  });
  await finishRegisteredHostRevocation(deps, actor, hostId).catch(() => undefined);
  return deps.prisma.registeredHost.findFirstOrThrow({ where });
}

/** Only persisted, server-selected identities reach this private cleanup transport. */
export async function finishRegisteredHostRevocation(deps: Deps, actor: Actor, hostId: string) {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const host = await deps.prisma.registeredHost.findFirst({ where: { id: hostId, ...scope } });
  if (!host?.revokedAt || !host.revocationPending) return;
  await deps.prisma.registeredHost.updateMany({
    where: { id: host.id, ...scope, revocationPending: true },
    data: { revocationAttemptedAt: new Date() },
  });
  await deps.prisma.$transaction(async (tx) => {
    const computers = await tx.computer.findMany({
      where: { ...scope, registeredHostId: host.id },
    });
    const computerIds = computers.map((computer) => computer.id);
    const leases = await tx.computerExecutionLease.findMany({
      where: { computerId: { in: computerIds } },
    });
    const candidates = await tx.run.findMany({
      where: {
        ...scope,
        OR: [
          { nativeHostId: host.id, status: { not: "completed" } },
          { id: { in: leases.map((lease) => lease.runId) } },
          { bot: { computerId: { in: computerIds } }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        ],
      },
      select: { id: true, threadId: true },
    });
    for (const threadId of [...new Set(candidates.map((run) => run.threadId))].sort())
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    // Pin publication takes the run lock: read after acquiring it to capture an in-flight start.
    for (const runId of candidates.map((run) => run.id).sort())
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
    const runs = await tx.run.findMany({
      where: { id: { in: candidates.map((run) => run.id) }, ...scope },
    });
    for (const run of runs) {
      const native = run.nativeExecutionRunId !== null;
      const lease = leases.find((item) => item.runId === run.id);
      const computer = computers.find(
        (item) => item.id === (run.nativeComputerId ?? lease?.computerId),
      );
      if (
        native &&
        (run.nativeHostId !== host.id || !computer || computer.homeKey !== run.nativeComputerKey)
      )
        throw new Error("Revoked host execution identity is unavailable");
      if (!computer) continue; // Queued work has no host process to clean.
      await tx.registeredHostCleanup.upsert({
        where: {
          hostId_runId_computerId: { hostId: host.id, runId: run.id, computerId: computer.id },
        },
        create: {
          hostId: host.id,
          ...scope,
          runId: run.id,
          computerId: computer.id,
          computerKey: computer.homeKey,
          targetRunId: run.nativeExecutionRunId ?? run.id,
        },
        update: {},
      });
    }
    const active = runs.filter((run) =>
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
    );
    await cancelRunsInTransaction(tx, active, new Date());
    for (const run of active)
      await appendEventInTransaction(tx, {
        ...scope,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "run.cancelled",
        payload: {},
      });
    await tx.steeringMessage.updateMany({
      where: {
        message: { threadId: { in: candidates.map((run) => run.threadId) } },
        OR: [
          { runId: { in: candidates.map((run) => run.id) } },
          { runId: null, bot: { computerId: { in: computerIds } } },
        ],
        claimedAt: null,
        cancelledAt: null,
      },
      data: { cancelledAt: new Date() },
    });
  });
  // No public resolver bypass: the immutable registration supplies the endpoint and secret.
  // Revoked credentials may ONLY acknowledge the exact teardown journal here.
  const transport = new HostComputerSandbox(
    registeredHostEndpoint(host.endpoint),
    await deps.secrets.load(host.ciphertext, host.id),
  );
  let setupRevoked = false;
  let browserRevoked = false;
  try {
    for await (const result of transport.request<{ browserCleanupVerified: true }>(
      {
        method: "browserRevokeScope",
        botId: "setup",
        scope: { ...scope, registrationId: host.id },
      },
      {
        ...scope,
        operationId: `browser-revoke:${host.id}`,
        traceId: `host-revoke:${host.id}`,
        signal: AbortSignal.timeout(15_000),
      },
    ))
      browserRevoked = result.browserCleanupVerified === true;
  } catch {
    // Keep the durable retry marker: idle browsers need verified cleanup too.
  }
  try {
    for await (const result of transport.request<{ revoked: true }>(
      { method: "nativeSetupRevoke", botId: "setup", registrationId: host.id },
      {
        ...scope,
        operationId: `host-revoke:${host.id}`,
        traceId: `host-revoke:${host.id}`,
        signal: AbortSignal.timeout(15_000),
      },
    ))
      setupRevoked = result.revoked === true;
  } catch {
    // Native runs still need stopping if setup teardown is temporarily unavailable.
  }
  const pending = await deps.prisma.registeredHostCleanup.findMany({
    where: { hostId: host.id, ...scope, completedAt: null },
    orderBy: [{ attemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 4,
  });
  await Promise.allSettled(
    pending.map(async (job) => {
      await deps.prisma.registeredHostCleanup.updateMany({
        where: { id: job.id, ...scope },
        data: { attemptedAt: new Date() },
      });
      await transport.cancelRunWork(
        {
          id: job.computerId,
          botId: job.computerKey,
          kind: "desktop",
          providerRef: `host:${job.computerKey}`,
        },
        job.computerId,
        job.targetRunId,
        {
          ...scope,
          runId: job.runId,
          operationId: `host-revoke:${job.id}`,
          traceId: `host-revoke:${host.id}`,
          requireRunCleanup: true,
          cancelRunWork: true,
          signal: AbortSignal.timeout(15_000),
        },
      );
      await runAsSystem("release confirmed revoked-host execution", () =>
        deps.prisma.nativeExecutionReservation.deleteMany({ where: { runId: job.runId } }),
      );
      await deps.prisma.$transaction(async (tx) => {
        await tx.registeredHostCleanup.updateMany({
          where: { id: job.id, ...scope, completedAt: null },
          data: { completedAt: new Date() },
        });
        await expireComputerExecutionLeases(tx, { runId: job.runId });
        await tx.computer.updateMany({
          where: { id: job.computerId, ...scope, executionRunId: job.runId },
          data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
        });
      });
    }),
  );
  const remaining = await deps.prisma.registeredHostCleanup.count({
    where: { hostId: host.id, ...scope, completedAt: null },
  });
  if (!remaining && setupRevoked && browserRevoked)
    await deps.prisma.registeredHost.updateMany({
      where: { id: host.id, ...scope, revocationPending: true },
      data: { revocationPending: false },
    });
}

/** Called under the worker's audited system context; individual cleanup re-enters tenant scope. */
export async function reconcileRegisteredHostRevocations(deps: Deps) {
  const hosts = await deps.prisma.registeredHost.findMany({
    where: { revocationPending: true, revokedAt: { not: null } },
    orderBy: [{ revocationAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 20,
  });
  await Promise.allSettled(
    hosts.map((host) => {
      const actor: Actor = {
        spaceId: host.spaceId,
        userId: host.userId,
        email: "",
        isDeploymentOwner: false,
      };
      return runAsTenant(actor, () => finishRegisteredHostRevocation(deps, actor, host.id));
    }),
  );
}
