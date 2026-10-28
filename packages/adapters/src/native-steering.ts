import type { PrismaClient } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";

/** Only provider-confirmed non-submissions may become editable queued input again. */
export async function deferNativeSteering(
  prisma: PrismaClient,
  lease: { threadId: string; botId: string; runId: string; workerId: string; fence: number },
  ids: string[],
) {
  if (!ids.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${lease.threadId} FOR UPDATE`;
    const owned = await tx.run.findFirst({
      where: {
        id: lease.runId,
        threadId: lease.threadId,
        botId: lease.botId,
        status: "running",
        leaseOwner: lease.workerId,
        leaseFence: lease.fence,
      },
      select: { spaceId: true },
    });
    if (!owned) throw new Error("Run lease expired before deferring native steering");
    const fenced = await tx.run.updateMany({
      where: {
        id: lease.runId,
        status: "running",
        leaseOwner: lease.workerId,
        leaseFence: lease.fence,
      },
      data: { leaseFence: lease.fence },
    });
    if (fenced.count !== 1) throw new Error("Run lease expired before deferring native steering");
    const released = await tx.steeringMessage.updateMany({
      where: {
        id: { in: ids },
        runId: lease.runId,
        botId: lease.botId,
        claimedAt: { not: null },
        cancelledAt: null,
        message: { threadId: lease.threadId },
      },
      data: { runId: null, claimedAt: null, deliveryMode: "queue" },
    });
    if (released.count)
      await appendEventInTransaction(tx, {
        spaceId: owned.spaceId,
        threadId: lease.threadId,
        botId: lease.botId,
        runId: lease.runId,
        type: "thread.queue.updated",
        payload: {},
      });
  });
}
