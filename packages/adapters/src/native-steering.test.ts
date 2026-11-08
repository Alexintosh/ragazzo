import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferNativeSteering } from "./native-steering.js";

const event = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db", () => ({ appendEventInTransaction: event }));
describe("durable native steering deferral", () => {
  beforeEach(() => vi.clearAllMocks());
  function setup() {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findFirst: vi.fn().mockResolvedValue({ spaceId: "space" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    return { tx, prisma };
  }
  const lease = { threadId: "thread", botId: "bot", runId: "run", workerId: "worker", fence: 4 };
  it("returns only this leased run's explicitly unsubmitted claims to the continuation queue", async () => {
    const { tx, prisma } = setup();
    await deferNativeSteering(prisma, lease, ["late1", "late2"]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.run.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.run.findFirst).toHaveBeenCalledWith({
      where: {
        id: "run",
        threadId: "thread",
        botId: "bot",
        status: "running",
        leaseOwner: "worker",
        leaseFence: 4,
      },
      select: { spaceId: true },
    });
    expect(tx.steeringMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["late1", "late2"] },
        runId: "run",
        botId: "bot",
        claimedAt: { not: null },
        cancelledAt: null,
        message: { threadId: "thread" },
      },
      data: { runId: null, claimedAt: null, deliveryMode: "queue" },
    });
    expect(event).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "thread.queue.updated", runId: "run", threadId: "thread" }),
    );
    tx.steeringMessage.updateMany.mockResolvedValue({ count: 0 });
    event.mockClear();
    await deferNativeSteering(prisma, lease, ["late1", "late2"]);
    expect(event).not.toHaveBeenCalled();
  });
  it("preserves claims when the worker no longer owns the run", async () => {
    const { tx, prisma } = setup();
    tx.run.findFirst.mockResolvedValue(null);
    await expect(deferNativeSteering(prisma, lease, ["late"])).rejects.toThrow("lease expired");
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
  });
});
