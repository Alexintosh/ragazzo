import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey } from "@rakazo/adapter-kit";
import type { RoleplayCharacter } from "@rakazo/contracts";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { unwrapJobPayload } from "@rakazo/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { createRoleplayScheduling } from "./roleplay-schedule-tools.js";
import { wakeRoutine } from "./run-routines.js";
import { GraphileJobPublisher } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const character: RoleplayCharacter = {
  name: "Aria",
  description: "Explorer",
  personality: "Curious",
  scenario: "",
  firstMessage: "Hello",
  exampleDialogue: "",
  alternateGreetings: [],
  systemPrompt: "",
  postHistoryInstructions: "",
  lorebook: null,
  conversationStyle: "chat",
  spontaneous: { enabled: false, frequency: "balanced", allowLateNight: false },
};

/** Owns one synthetic tenant; never starts a worker or changes another tenant's jobs. */
describePostgres("roleplay scheduled messages (PostgreSQL)", () => {
  const address = `roleplay-scheduling-${randomUUID()}`;
  const executionHeldUntil = new Date(Date.now() + 24 * 60 * 60_000);
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };

  const connect = () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    system = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool);
  };
  const dependencies = () =>
    ({
      prisma: db.prisma,
      jobs: {
        // Keep legacy Graphile workers from executing test continuations. The ordinary
        // RunWorkerHost is separately excluded by this fixture's live computer lease.
        enqueue: (job) =>
          jobs.enqueue(
            job.name === "run.continue" ? { ...job, availableAt: executionHeldUntil } : job,
          ),
        cancel: (key) => jobs.cancel(key),
        close: () => jobs.close(),
      } satisfies JobPublisher,
      events: createThreadEvents(db.prisma),
    }) as unknown as ExecutorDeps;

  beforeAll(async () => {
    connect();
    const provisioned = await runAsSystem("roleplay scheduling test fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    if (!provisioned.created) throw new Error("Scheduling fixture must own a new identity");
    identity = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
      threadId: provisioned.threadId,
    };
    const bot = await runAsTenant(identity, () =>
      createRepos(db.prisma).createBot(
        { ...identity, email: "fixture@example.test", isDeploymentOwner: false },
        {
          name: character.name,
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          botKind: "roleplay",
          roleplayCharacter: character,
        },
      ),
    );
    identity = { ...identity, botId: bot.id, threadId: bot.threadId };
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      if (identity) {
        // Graphile jobs have no tenant FK; remove only keys belonging to our fixture.
        const [routines, runs] = await Promise.all([
          system.routine.findMany({ where: { spaceId: identity.spaceId }, select: { id: true } }),
          system.run.findMany({ where: { spaceId: identity.spaceId }, select: { id: true } }),
        ]);
        for (const routine of routines) await jobs.cancel(routineJobKey(routine.id));
        for (const run of runs) await jobs.cancel(`run:${run.id}`);
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await jobs?.close();
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }
  });

  async function timerJob(routineId: string) {
    const result = await db.pool.query<{ payload: unknown; run_at: Date }>(
      "select payload, run_at from graphile_worker._private_jobs where key = $1",
      [routineJobKey(routineId)],
    );
    return result.rows;
  }

  it("survives a fresh scheduler, fires once when due, and respects cancellation", async () => {
    // Fake Date only: PostgreSQL pool and Graphile I/O keep their real timers.
    const startedAt = new Date();
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt });
    const prompt = "Ask how the walk went in this conversation.";
    const request = { name: "After the walk", prompt, delayMinutes: 45 };
    let sourceRunId = "";
    let routineId = "";
    const signal = new AbortController().signal;

    await runAsTenant(identity, async () => {
      const task = await db.prisma.task.create({
        data: { ...identity, prompt: "Write to me in 45 minutes.", status: "running" },
      });
      const source = await db.prisma.run.create({
        data: {
          ...identity,
          taskId: task.id,
          trigger: "user",
          status: "running",
          startedAt,
          leaseOwner: "roleplay-scheduling-fixture",
          leaseFence: 1,
          leaseExpiresAt: executionHeldUntil,
        },
      });
      sourceRunId = source.id;
      const bot = await db.prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
      if (!bot.computerId) throw new Error("Roleplay fixture must own a computer");
      await db.prisma.computerExecutionLease.create({
        data: {
          computerId: bot.computerId,
          botId: bot.id,
          runId: source.id,
          fence: 1,
          expiresAt: executionHeldUntil,
        },
      });
      const result = await createRoleplayScheduling(dependencies(), source).execute(
        "schedule_create",
        request,
        signal,
      );
      expect(result).toMatchObject({ ok: true, oneShot: true });
      routineId = (result as { routineId: string }).routineId;
      expect(await db.prisma.externalEffect.findMany({ where: { runId: sourceRunId } })).toEqual([
        expect.objectContaining({ kind: "schedule_create", status: "completed" }),
      ]);
    });

    const due = new Date(startedAt.getTime() + 45 * 60_000);
    const persisted = await system.routine.findUniqueOrThrow({ where: { id: routineId } });
    expect(persisted).toMatchObject({
      ...identity,
      crons: [ONCE_ROUTINE_CRON],
      active: true,
      nextRunAt: due,
      prompt,
      watch: null,
    });
    expect(await timerJob(routineId)).toEqual([expect.objectContaining({ run_at: due })]);

    await jobs.close();
    await db.prisma.$disconnect();
    await db.pool.end();
    connect();

    await runAsTenant(identity, async () => {
      const deps = dependencies();
      const scheduling = createRoleplayScheduling(deps, {
        ...identity,
        id: sourceRunId,
        trigger: "user",
      });
      // Replaying the model's tool completion after restart reuses the stored effect.
      expect(await scheduling.execute("schedule_create", request, signal)).toMatchObject({
        ok: true,
        routineId,
      });
      expect(await db.prisma.routine.count({ where: { botId: identity.botId } })).toBe(1);
      expect(
        (await db.prisma.routine.findUniqueOrThrow({ where: { id: routineId } })).nextRunAt,
      ).toEqual(due);
      const [timer] = await timerJob(routineId);
      expect(timer?.run_at).toEqual(due);
      const payload = unwrapJobPayload(timer!.payload).payload;
      expect(payload).toEqual({ routineId, scheduledFor: due.toISOString() });

      // An early delivery requeues the durable timer instead of generating a message.
      await wakeRoutine(deps, routineId, due.toISOString());
      expect(await db.prisma.run.count({ where: { routineId } })).toBe(0);
      expect(await timerJob(routineId)).toHaveLength(1);

      vi.setSystemTime(new Date(due.getTime() + 1_000));
      await Promise.all([
        wakeRoutine(deps, routineId, due.toISOString()),
        wakeRoutine(deps, routineId, due.toISOString()),
      ]);
      const runs = await db.prisma.run.findMany({ where: { routineId }, include: { task: true } });
      expect(runs).toEqual([
        expect.objectContaining({
          ...identity,
          routineId,
          trigger: "routine",
          status: "queued",
          task: expect.objectContaining({ ...identity, prompt, status: "queued" }),
        }),
      ]);
      expect(await db.prisma.task.count({ where: { botId: identity.botId, prompt } })).toBe(1);
      expect(await db.prisma.routine.findUniqueOrThrow({ where: { id: routineId } })).toMatchObject(
        {
          active: false,
          nextRunAt: null,
        },
      );
      expect(await timerJob(routineId)).toHaveLength(0);
      expect(
        await db.prisma.event.count({ where: { runId: runs[0]!.id, type: "routine.fired" } }),
      ).toBe(1);
      await wakeRoutine(deps, routineId, due.toISOString());
      expect(await db.prisma.run.count({ where: { routineId } })).toBe(1);

      const cancelled = await scheduling.execute(
        "schedule_create",
        { name: "Cancelled follow-up", prompt: "This message must never run.", delayMinutes: 45 },
        signal,
      );
      expect(cancelled).toMatchObject({ ok: true });
      const cancelledId = (cancelled as { routineId: string }).routineId;
      const cancelledDue = new Date(Date.now() + 45 * 60_000);
      expect(
        await scheduling.execute("schedule_cancel", { routineId: cancelledId }, signal),
      ).toMatchObject({ ok: true, routineId: cancelledId });
      expect(await timerJob(cancelledId)).toHaveLength(0);
      vi.setSystemTime(new Date(cancelledDue.getTime() + 1_000));
      await wakeRoutine(deps, cancelledId, cancelledDue.toISOString());
      expect(await db.prisma.run.count({ where: { routineId: cancelledId } })).toBe(0);
    });
  });
});
