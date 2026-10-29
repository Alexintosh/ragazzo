import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoleplayScheduling } from "./roleplay-schedule-tools.js";
import type { ExecutorDeps } from "./executor-deps.js";

const identity = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "character-1",
  threadId: "story-1",
  id: "run-1",
  trigger: "user",
};
const signal = () => new AbortController().signal;
interface StoredEffect {
  id?: string;
  idempotencyKey: string;
  status: string;
  runId: string;
  spaceId: string;
  kind: string;
  request: unknown;
  result?: unknown;
}

function fixture(runTrigger = "user") {
  const effects = new Map<string, StoredEffect>();
  const row = {
    ...identity,
    id: "routine-1",
    name: "Later",
    prompt: "Write a message about our conversation.",
    crons: [ONCE_ROUTINE_CRON],
    timezone: "UTC",
    active: true,
    nextRunAt: new Date("2026-10-29T12:45:00Z"),
    watch: null,
  };
  const routine = {
    findMany: vi.fn(async () => [] as (typeof row)[]),
    findFirst: vi.fn(async () => row),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: row.id,
      ...data,
    })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const deps = {
    prisma: {
      routine,
      user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
      externalEffect: {
        findUnique: vi.fn(
          async ({ where }: { where: { idempotencyKey: string } }) =>
            effects.get(where.idempotencyKey) ?? null,
        ),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: StoredEffect }) => {
          const effect = { ...data, id: `effect-${effects.size}` };
          effects.set(effect.idempotencyKey, effect);
          return effect;
        }),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; status: string };
            data: { status: string; result?: unknown };
          }) => {
            const effect = [...effects.values()].find(
              (item) => item.id === where.id && item.status === where.status,
            );
            if (!effect) return { count: 0 };
            Object.assign(effect, data);
            return { count: 1 };
          },
        ),
      },
    },
    jobs: {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    },
    events: { append: vi.fn(async () => undefined) },
  };
  return {
    ...deps,
    row,
    routine,
    effects,
    scheduling: createRoleplayScheduling(deps as unknown as ExecutorDeps, {
      ...identity,
      trigger: runTrigger,
    }),
  };
}

describe("roleplay scheduling", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("persists and enqueues a 45-minute message using the ordinary one-shot scheduler", async () => {
    const f = fixture();
    const result = await f.scheduling.execute(
      "schedule_create",
      { name: "Later", prompt: "Ask how the walk went.", delayMinutes: 45 },
      signal(),
    );
    expect(result).toMatchObject({
      ok: true,
      routineId: "routine-1",
      oneShot: true,
      nextRunAt: "2026-10-29T12:45:00.000Z",
    });
    expect(f.routine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: identity.threadId,
        crons: [ONCE_ROUTINE_CRON],
        active: true,
        prompt: "Ask how the walk went.",
      }),
    });
    expect(f.jobs.enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: {
        routineId: "routine-1",
        scheduledFor: "2026-10-29T12:45:00.000Z",
      },
      availableAt: new Date("2026-10-29T12:45:00Z"),
      replaceKey: "routine:routine-1",
    });
  });

  it("keeps ordinary repeating timing and ignores blank unused timing fields", async () => {
    const f = fixture();
    expect(
      await f.scheduling.execute(
        "schedule_create",
        {
          name: "Morning",
          prompt: "Say good morning.",
          cron: "0 9 * * *",
          runAt: null,
        },
        signal(),
      ),
    ).toMatchObject({ ok: true, oneShot: false });
    expect(f.routine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ crons: ["0 9 * * *"] }),
    });
  });

  it("returns a completed mutation on replay without creating or enqueuing another timer", async () => {
    const f = fixture();
    const args = { name: "Later", prompt: "Say hello.", delayMinutes: 45 };
    const first = await f.scheduling.execute("schedule_create", args, signal());
    // A new adapter represents a fresh worker attempt with the same durable run.
    const restarted = createRoleplayScheduling(
      f as unknown as ExecutorDeps,
      identity,
    );
    expect(await restarted.execute("schedule_create", args, signal())).toEqual(
      first,
    );
    expect(f.routine.create).toHaveBeenCalledTimes(1);
    expect(f.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("stores and replays a compact update result even when its prompt contains large Unicode text", async () => {
    const f = fixture();
    const args = { routineId: "routine-1", prompt: "🙂".repeat(3_000) };
    const first = await f.scheduling.execute("schedule_update", args, signal());
    expect(first).toMatchObject({
      ok: true,
      routineId: "routine-1",
      active: true,
      oneShot: true,
      nextRunAt: "2026-10-29T12:45:00.000Z",
    });
    expect(first).not.toHaveProperty("prompt");
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(
      8_192,
    );
    const saved = [...f.effects.values()][0]!.result;
    expect(saved).toEqual(first);
    const restarted = createRoleplayScheduling(
      f as unknown as ExecutorDeps,
      identity,
    );
    expect(await restarted.execute("schedule_update", args, signal())).toEqual(
      first,
    );
    expect(f.routine.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an interrupted mutation whose result was never recorded", async () => {
    const f = fixture();
    const args = { name: "Later", prompt: "Say hello.", delayMinutes: 45 };
    // Simulate losing completion persistence after the routine mutation.
    f.prisma.externalEffect.updateMany
      .mockImplementationOnce(async ({ where, data }) => {
        const effect = [...f.effects.values()].find(
          (item) => item.id === where.id,
        );
        if (effect) Object.assign(effect, data);
        return { count: 1 };
      })
      .mockImplementationOnce(async () => {
        throw new Error("worker lost");
      });
    await expect(
      f.scheduling.execute("schedule_create", args, signal()),
    ).rejects.toThrow();
    const restarted = createRoleplayScheduling(
      f as unknown as ExecutorDeps,
      identity,
    );
    expect(
      await restarted.execute("schedule_create", args, signal()),
    ).toMatchObject({ uncertain: true });
    expect(f.routine.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { watch: { kind: "command", command: "echo unsafe" } },
    { target: { botId: "other", threadId: "other" } },
    { botId: "other" },
    { threadId: "other" },
    { userId: "other" },
    { prompt: "x".repeat(8_001) },
  ])(
    "rejects hidden capabilities, forged scope, or oversized arguments: %j",
    async (extra) => {
      const f = fixture();
      expect(
        await f.scheduling.execute(
          "schedule_create",
          { name: "Later", prompt: "Say hello.", delayMinutes: 45, ...extra },
          signal(),
        ),
      ).toHaveProperty("error");
      expect(f.routine.create).not.toHaveBeenCalled();
      expect(f.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("scopes list, update, and cancel to the current owner, character, and story", async () => {
    const f = fixture();
    const { id: _, trigger: __, ...scope } = identity;
    await f.scheduling.execute("schedule_list", {}, signal());
    expect(f.routine.findMany).toHaveBeenCalledWith({
      where: { ...scope, active: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 0,
      take: 11,
    });
    await f.scheduling.execute(
      "schedule_update",
      { routineId: "routine-1", active: false },
      signal(),
    );
    expect(f.routine.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ ...scope, id: "routine-1" }),
      data: expect.objectContaining({ active: false, nextRunAt: null }),
    });
    await f.scheduling.execute(
      "schedule_cancel",
      { routineId: "routine-1" },
      signal(),
    );
    expect(f.routine.deleteMany).toHaveBeenCalledWith({
      where: { ...scope, id: "routine-1" },
    });
    expect(f.jobs.cancel).toHaveBeenCalledWith("routine:routine-1");
  });

  it("pages compact active schedules without including prompts or oversized details", async () => {
    const f = fixture();
    f.routine.findMany.mockResolvedValueOnce(
      Array.from({ length: 11 }, (_, index) => ({
        ...f.row,
        id: `routine-${index}`,
        name: "🙂".repeat(1_000),
        prompt: "private long prompt".repeat(1_000),
      })),
    );
    const result = (await f.scheduling.execute(
      "schedule_list",
      {},
      signal(),
    )) as {
      routines: Record<string, unknown>[];
      nextPage: number | null;
    };
    expect(result.routines).toHaveLength(10);
    expect(result.nextPage).toBe(2);
    expect(
      new TextEncoder().encode(JSON.stringify(result)).length,
    ).toBeLessThan(8_192);
    for (const routine of result.routines) {
      expect(routine).not.toHaveProperty("prompt");
      expect(
        new TextEncoder().encode(String(routine.name)).length,
      ).toBeLessThanOrEqual(120);
    }
    await f.scheduling.execute(
      "schedule_list",
      { page: 2, includeInactive: true },
      signal(),
    );
    expect(f.routine.findMany).toHaveBeenLastCalledWith({
      where: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: identity.threadId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 10,
      take: 11,
    });
  });

  it("allows a new occurrence after creating and cancelling the same schedule", async () => {
    const f = fixture();
    const args = { name: "Later", prompt: "Say hello.", delayMinutes: 45 };
    await f.scheduling.execute("schedule_create", args, signal());
    await f.scheduling.execute(
      "schedule_cancel",
      { routineId: "routine-1" },
      signal(),
    );
    await f.scheduling.execute("schedule_create", args, signal());
    expect(f.routine.create).toHaveBeenCalledTimes(2);
    const restarted = createRoleplayScheduling(
      f as unknown as ExecutorDeps,
      identity,
    );
    await restarted.execute("schedule_create", args, signal());
    await restarted.execute(
      "schedule_cancel",
      { routineId: "routine-1" },
      signal(),
    );
    await restarted.execute("schedule_create", args, signal());
    expect(f.routine.create).toHaveBeenCalledTimes(2);
    expect(f.routine.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("aborts during the scheduler's pending read before it can create or enqueue a timer", async () => {
    const f = fixture();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.routine.findMany.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });
    const pending = f.scheduling.execute(
      "schedule_create",
      {
        name: "Later",
        prompt: "Say hello.",
        delayMinutes: 45,
      },
      controller.signal,
    );
    await waiting;
    controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    expect(f.routine.create).not.toHaveBeenCalled();
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each(["routine", "roleplay_spontaneous", "memory"])(
    "cannot create or update unattended work from a %s turn, even with a forged call",
    async (trigger) => {
      const f = fixture(trigger);
      expect(f.scheduling.tools.map((tool) => tool.name)).toEqual([
        "schedule_list",
        "schedule_cancel",
      ]);
      expect(
        await f.scheduling.execute(
          "schedule_create",
          { name: "Again", prompt: "Repeat.", delayMinutes: 45 },
          signal(),
        ),
      ).toHaveProperty("error");
      expect(
        await f.scheduling.execute(
          "schedule_update",
          { routineId: "routine-1", active: true },
          signal(),
        ),
      ).toHaveProperty("error");
      expect(f.routine.create).not.toHaveBeenCalled();
      expect(f.routine.updateMany).not.toHaveBeenCalled();
    },
  );

  it("exposes exactly four scheduling tools on user turns with closed schemas", () => {
    const f = fixture("follow_up");
    expect(f.scheduling.tools.map((tool) => tool.name)).toEqual([
      "schedule_create",
      "schedule_list",
      "schedule_update",
      "schedule_cancel",
    ]);
    for (const tool of f.scheduling.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("watch");
      expect(tool.inputSchema.properties).not.toHaveProperty("target");
    }
  });

  it("refuses unknown tools and checks cancellation before reading or writing", async () => {
    const f = fixture();
    expect(
      await f.scheduling.execute("shell", { command: "echo unsafe" }, signal()),
    ).toHaveProperty("error");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.scheduling.execute(
        "schedule_create",
        { name: "Later", prompt: "Hello.", delayMinutes: 45 },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(f.routine.findMany).not.toHaveBeenCalled();
    expect(f.routine.create).not.toHaveBeenCalled();
  });
});
