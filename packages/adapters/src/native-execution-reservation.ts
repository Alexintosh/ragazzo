import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { ComputerBusyError } from "./computer-lifecycle.js";
import { scopesOverlap, validWriteSubdirectory } from "./native-write-scope.js";

type Reservation = {
  runId: string;
  hostKey: string;
  writeRoot: string | null;
  ownerFence: number;
  computerId?: string;
  computerKey?: string;
  hostId?: string | null;
};
type CleanupBinding = {
  runId: string;
  nativeRunId: string;
  computerId: string;
  computerKey: string;
  hostId: string | null;
  botId: string;
  spaceId: string;
  userId: string;
};

export async function acquireNativeExecutionReservation(
  prisma: PrismaClient,
  input: Reservation,
): Promise<void> {
  await runAsSystem("coordinate native writers across computers on one host", () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-execution:${input.hostKey}`}, 0))`;
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM runs WHERE id = ${input.runId} AND "leaseFence" = ${input.ownerFence}
      AND status = 'running' AND "leaseExpiresAt" > ${new Date()} FOR UPDATE`;
      if (owned.length !== 1) throw new ComputerBusyError();
      const peers = await tx.nativeExecutionReservation.findMany({
        where: {
          hostKey: input.hostKey,
          runId: { not: input.runId },
          expiresAt: { gt: new Date() },
        },
      });
      if (peers.some((peer) => scopesOverlap(peer.writeRoot, input.writeRoot)))
        throw new ComputerBusyError();
      await tx.nativeExecutionReservation.upsert({
        where: { runId: input.runId },
        create: { ...input, expiresAt: new Date(Date.now() + 5 * 60_000) },
        update: { ...input, expiresAt: new Date(Date.now() + 5 * 60_000) },
      });
    }),
  );
}

export function declaredTaskWriteRoot(
  project: string,
  subdirectory?: string | null,
): string | null {
  if (!subdirectory) return null;
  if (!path.isAbsolute(project) || !validWriteSubdirectory(subdirectory))
    throw new Error("Invalid native task write scope");
  return path.join(project, subdirectory);
}

export async function renewNativeExecutionReservation(
  prisma: PrismaClient,
  runId: string,
  ownerFence: number,
): Promise<boolean> {
  const renewed = await runAsSystem("renew an owned host write reservation", () =>
    prisma.nativeExecutionReservation.updateMany({
      where: { runId, ownerFence, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date(Date.now() + 5 * 60_000) },
    }),
  );
  return renewed.count === 1;
}

export async function activateNativeExecutionReservation(
  prisma: PrismaClient,
  runId: string,
  ownerFence: number,
): Promise<void> {
  const active = await runAsSystem("fence host work before requesting it", () =>
    prisma.nativeExecutionReservation.updateMany({
      where: { runId, ownerFence, expiresAt: { gt: new Date() } },
      data: { active: true },
    }),
  );
  if (active.count !== 1) throw new Error("Host write reservation expired before execution");
}

export async function releaseNativeExecutionReservation(
  prisma: PrismaClient,
  runId: string,
  ownerFence: number,
  cleanup?: (binding: CleanupBinding) => Promise<void>,
): Promise<void> {
  // The authoritative host fence remains held while an approval keeps a process alive.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      status: true,
      nativeExecutionRunId: true,
      nativeComputerId: true,
      nativeComputerKey: true,
      nativeHostId: true,
      botId: true,
      spaceId: true,
      userId: true,
    },
  });
  if (!run) return;
  if (!["completed", "waiting_input", "waiting_takeover"].includes(run.status)) {
    const reservation = await runAsSystem("read an owned host reservation cleanup binding", () =>
      prisma.nativeExecutionReservation.findFirst({ where: { runId, ownerFence } }),
    );
    if (!reservation) return;
    if (reservation.active || run.nativeExecutionRunId) {
      const computerId = run.nativeComputerId ?? reservation.computerId;
      const computerKey = run.nativeComputerKey ?? reservation.computerKey;
      if (!cleanup || !computerId || !computerKey) return;
      await cleanup({
        runId,
        nativeRunId: run.nativeExecutionRunId ?? runId,
        computerId,
        computerKey,
        hostId: run.nativeExecutionRunId ? run.nativeHostId : reservation.hostId,
        botId: run.botId,
        spaceId: run.spaceId,
        userId: run.userId,
      });
    }
  }
  await runAsSystem("release an owned host write reservation", async () => {
    if (run?.status === "waiting_input" || run?.status === "waiting_takeover") {
      await prisma.nativeExecutionReservation.updateMany({
        where: { runId, ownerFence },
        data: { expiresAt: new Date(Date.now() + 30 * 60_000) },
      });
    } else await prisma.nativeExecutionReservation.deleteMany({ where: { runId, ownerFence } });
  });
}
