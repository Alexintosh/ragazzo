import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ snapshot: vi.fn(), lock: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Database>()),
  roleplaySpontaneousSnapshot: (...args: unknown[]) => fake.snapshot(...args),
  lockRoleplaySpontaneousPreferences: (...args: unknown[]) => fake.lock(...args),
}));

import { createRoleplaySpontaneousReconciler } from "./roleplay-spontaneous.js";

function fixture() {
  const queued: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    task: {
      findUnique: vi.fn(async () => tasks[0] ?? null),
      create: vi.fn(async ({ data }) => {
        expect(currentDbContext()).toMatchObject({
          kind: "tenant",
          userId: "owner",
          spaceId: "space",
        });
        const task = { id: "task", ...data };
        tasks.push(task);
        return task;
      }),
    },
    run: {
      create: vi.fn(async ({ data }) => {
        const run = { id: "run", ...data };
        runs.push(run);
        return run;
      }),
    },
  };
  let pending = Promise.resolve();
  const prisma = {
    user: { findMany: vi.fn(async ({ where }) => (where.id ? [] : [{ id: "owner" }])) },
    bot: {
      findMany: vi.fn(async () => [
        { id: "aria", userId: "owner", spaceId: "space", thread: { id: "story" } },
      ]),
    },
    $transaction: vi.fn((fn) => {
      const next = pending.then(() => fn(tx));
      pending = next.then(() => undefined);
      return next;
    }),
  };
  const jobs = {
    enqueue: vi.fn(async (job) => {
      queued.push(job.payload.runId);
    }),
  };
  return {
    prisma,
    tx,
    tasks,
    runs,
    queued,
    jobs,
    deps: { prisma: prisma as unknown as PrismaClient, jobs: jobs as never },
  };
}
beforeEach(() => {
  fake.snapshot
    .mockReset()
    .mockResolvedValue({
      guard: {
        historyGeneration: 0,
        nextMessageSeq: 7,
        character: "{}",
        timezone: "UTC",
        sourceMessageId: "actual-user",
        botUpdatedAt: "revision",
        userUpdatedAt: "revision",
      },
    });
  fake.lock.mockClear();
});
describe("roleplay initiative reconciler", () => {
  it("does no scans while the worker feature is disabled", async () => {
    const f = fixture();
    await createRoleplaySpontaneousReconciler(f.deps, { enabled: false })();
    expect(f.prisma.user.findMany).not.toHaveBeenCalled();
  });
  it("creates only a durable task/run, under owner RLS, before enqueueing", async () => {
    const f = fixture();
    await createRoleplaySpontaneousReconciler(f.deps, {
      enabled: true,
      now: () => new Date("2026-10-29T12:00:00Z"),
    })();
    expect(f.tasks).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
    expect(f.queued).toEqual(["run"]);
    expect(f.runs[0]).toMatchObject({
      trigger: "roleplay_spontaneous",
      sourceMessageId: "actual-user",
      userId: "owner",
      spaceId: "space",
      threadId: "story",
      status: "queued",
    });
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(fake.lock).toHaveBeenCalledOnce();
    expect(fake.snapshot).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
      expect.any(Date),
      undefined,
      true,
    );
  });
  it("deduplicates concurrent schedulers using the locked durable nonce", async () => {
    const f = fixture();
    const options = { enabled: true, now: () => new Date("2026-10-29T12:00:00Z") };
    await Promise.all([
      createRoleplaySpontaneousReconciler(f.deps, options)(),
      createRoleplaySpontaneousReconciler(f.deps, options)(),
    ]);
    expect(f.tasks).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
    expect(f.queued).toEqual(["run"]);
  });
  it("retains durable work when enqueue fails, and never invents a second run", async () => {
    const f = fixture();
    f.jobs.enqueue.mockRejectedValueOnce(new Error("queue offline"));
    const reconcile = createRoleplaySpontaneousReconciler(f.deps, { enabled: true });
    await expect(reconcile()).rejects.toThrow("queue offline");
    await reconcile();
    expect(f.tasks).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
  });
  it("preserves the same durable attempt when the scheduler is recreated after a restart", async () => {
    const f = fixture();
    const options = { enabled: true, now: () => new Date("2026-10-29T12:00:00Z") };
    await createRoleplaySpontaneousReconciler(f.deps, options)();
    // A process restart loses its in-memory queue and cursors, not the persisted task/run.
    f.queued.length = 0;
    const restarted = createRoleplaySpontaneousReconciler(f.deps, options);
    await restarted();
    expect(f.tasks).toHaveLength(1);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ status: "queued", trigger: "roleplay_spontaneous" });
    // The general job reconciler recovers this queued run; the initiative scanner must not duplicate it.
    expect(f.queued).toEqual([]);
  });
  it("advances bounded owner cursors instead of repeatedly scanning the first owner", async () => {
    const f = fixture();
    fake.snapshot.mockResolvedValue(null);
    const reconcile = createRoleplaySpontaneousReconciler(f.deps, { enabled: true, batchSize: 1 });
    await reconcile();
    await reconcile();
    await reconcile();
    expect(f.prisma.user.findMany.mock.calls.map(([args]) => args.where.id)).toEqual([
      undefined,
      { gt: "owner" },
      undefined,
    ]);
    expect(f.runs).toHaveLength(0);
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
  });
});
