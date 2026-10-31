import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  FakeSandboxProvider,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInput,
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  loadRunHistoryMessages,
  pauseRunForInput,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeExecutionReservation,
  releaseNativeExecutionReservation,
  renewNativeExecutionReservation,
} from "../../../packages/adapters/src/native-execution-reservation.js";
import {
  createConversationTask,
  listConversationTasks,
  recoverConversationRun,
  startQueuedConversationTask,
  stoppedConversationRuns,
} from "./conversation-tasks.js";
import { mutateThreadQueue } from "./thread-queue.js";
import {
  clearThreadMessageHistory,
  resolveThreadTarget,
  stopThreadRuns,
  threadSnapshot,
} from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
describePostgres("separate task conversations and deliberate recovery (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let otherBotId: string;
  let threadId: string;
  const address = `task-${randomUUID()}@example.invalid`;
  const owner = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    pool = db.pool;
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("task fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "task-test", address },
        { signupsEnabled: "true", signupAllowlist: undefined },
      ),
    );
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: address,
      isDeploymentOwner: false,
    };
    botId = identity.botId;
    threadId = identity.threadId;
    const other = await owner(() =>
      createRepos(prisma).createBot(actor, {
        name: "Task recipient",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    otherBotId = other.id;
  });
  beforeEach(async () => {
    await system.computerExecutionLease.deleteMany({
      where: { botId: { in: [botId, otherBotId] } },
    });
    await system.thread.deleteMany({ where: { taskBotId: { in: [botId, otherBotId] } } });
    await system.message.deleteMany({ where: { threadId } });
    await system.run.deleteMany({ where: { threadId } });
    await system.task.deleteMany({ where: { threadId } });
  });
  afterAll(async () => {
    try {
      if (actor) {
        await system.messagingIdentity.deleteMany({ where: { provider: "task-test", address } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });
  const create = (clientNonce: string, text = "bounded task") =>
    owner(() =>
      createConversationTask(prisma, actor, { botId, text, clientNonce, originThreadId: threadId }),
    );
  it("admits disjoint native task leases across computers and fences collisions, expiry and stale owners", async () => {
    await system.bot.update({
      where: { id: botId },
      data: {
        runtimeKind: "codex",
        runtimePermission: "workspace",
        projectPath: "/fixture/project",
      },
    });
    const hostKey = `test-host:${randomUUID()}`;
    const rows: string[] = [];
    try {
      const tasks = await Promise.all(
        ["left", "right", "left/child"].map((writeSubdirectory) =>
          owner(() =>
            createConversationTask(prisma, actor, {
              botId,
              text: "bounded scoped work",
              originThreadId: threadId,
              clientNonce: randomUUID(),
              writeSubdirectory,
            }),
          ),
        ),
      );
      expect(tasks.map((row) => row.task.writeSubdirectory)).toEqual([
        "left",
        "right",
        "left/child",
      ]);
      const regular = await create(randomUUID(), "ordinary compatible work");
      const legacy = await pool.connect();
      try {
        await legacy.query("BEGIN");
        await legacy.query(
          "SELECT set_config('app.space_id', $1, true), set_config('app.user_id', $2, true), set_config('app.rls_version', '2', true)",
          [actor.spaceId, actor.userId],
        );
        for (const bypass of ["off", "on"]) {
          await legacy.query("SELECT set_config('app.rls_bypass', $1, true)", [bypass]);
          const visible = await legacy.query("SELECT id FROM runs WHERE id = ANY($1::text[])", [
            [tasks[0]!.task.runId, regular.task.runId],
          ]);
          expect(visible.rows).toEqual([{ id: regular.task.runId }]);
          const claimed = await legacy.query("UPDATE runs SET status = 'leased' WHERE id = $1", [
            tasks[0]!.task.runId,
          ]);
          expect(claimed.rowCount).toBe(0);
        }
        await legacy.query("SELECT set_config('app.rls_version', '3', true)");
        const current = await legacy.query("SELECT id FROM runs WHERE id = $1", [
          tasks[0]!.task.runId,
        ]);
        expect(current.rows).toEqual([{ id: tasks[0]!.task.runId }]);
      } finally {
        await legacy.query("ROLLBACK");
        legacy.release();
      }
      for (const task of tasks) {
        rows.push(task.task.runId);
        await system.run.update({
          where: { id: task.task.runId },
          data: {
            status: "running",
            leaseOwner: "scope-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      }
      const reservation = (index: number) => ({
        runId: tasks[index]!.task.runId,
        ownerFence: 1,
        hostKey,
        writeRoot: `/fixture/project/${tasks[index]!.task.writeSubdirectory}`,
      });
      await Promise.all([
        acquireNativeExecutionReservation(prisma, reservation(0)),
        acquireNativeExecutionReservation(prisma, reservation(1)),
      ]);
      expect(await system.nativeExecutionReservation.count({ where: { hostKey } })).toBe(2);
      await expect(
        acquireNativeExecutionReservation(prisma, reservation(2)),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await expect(
        acquireNativeExecutionReservation(prisma, { ...reservation(2), writeRoot: null }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await owner(() => releaseNativeExecutionReservation(prisma, reservation(0).runId, 0));
      expect(await system.nativeExecutionReservation.count({ where: { hostKey } })).toBe(2);
      await system.nativeExecutionReservation.update({
        where: { runId: reservation(0).runId },
        data: { expiresAt: new Date(0) },
      });
      expect(await renewNativeExecutionReservation(prisma, reservation(0).runId, 1)).toBe(false);
      await acquireNativeExecutionReservation(prisma, reservation(2));
      await system.run.update({ where: { id: reservation(2).runId }, data: { leaseFence: 2 } });
      await expect(
        acquireNativeExecutionReservation(prisma, reservation(2)),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await system.run.update({
        where: { id: reservation(1).runId },
        data: { status: "waiting_input" },
      });
      await owner(() => releaseNativeExecutionReservation(prisma, reservation(1).runId, 1));
      expect(
        await system.nativeExecutionReservation.findUnique({
          where: { runId: reservation(1).runId },
        }),
      ).not.toBeNull();
      await system.run.update({
        where: { id: reservation(1).runId },
        data: { status: "cancelled" },
      });
      await system.nativeExecutionReservation.update({
        where: { runId: reservation(1).runId },
        data: {
          active: true,
          computerId: "original-computer",
          computerKey: "original-computer-key",
          hostId: "original-host",
        },
      });
      await owner(() => releaseNativeExecutionReservation(prisma, reservation(1).runId, 1));
      expect(
        await system.nativeExecutionReservation.findUnique({
          where: { runId: reservation(1).runId },
        }),
      ).not.toBeNull();
      await expect(
        owner(() =>
          releaseNativeExecutionReservation(prisma, reservation(1).runId, 1, async () => {
            throw new Error("Host cleanup unavailable");
          }),
        ),
      ).rejects.toThrow("Host cleanup unavailable");
      const cleanup = vi.fn(async () => undefined);
      await owner(() =>
        releaseNativeExecutionReservation(prisma, reservation(1).runId, 1, cleanup),
      );
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: reservation(1).runId,
          nativeRunId: reservation(1).runId,
          computerId: "original-computer",
          computerKey: "original-computer-key",
          hostId: "original-host",
        }),
      );
      expect(
        await system.nativeExecutionReservation.findUnique({
          where: { runId: reservation(1).runId },
        }),
      ).toBeNull();
    } finally {
      await system.nativeExecutionReservation.deleteMany({ where: { runId: { in: rows } } });
      await system.bot.update({
        where: { id: botId },
        data: { runtimeKind: "pi", runtimePermission: "workspace", projectPath: null },
      });
    }
  });
  async function stopped(status = "failed") {
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        prompt: "inspect the project and publish only after approval",
        status,
      },
    });
    return system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        threadId,
        taskId: task.id,
        status,
        trigger: "user",
        checkpoint: "uncertain-native-start",
        completedAt: new Date(),
      },
    });
  }

  it("creates two conversations without another bot and replays one concurrent request once", async () => {
    const [first, replay] = await Promise.all([create("same"), create("same")]);
    expect(replay.task.id).toBe(first.task.id);
    const second = await create("second");
    expect(first.task.threadId).not.toBe(second.task.threadId);
    const bot = await system.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { thread: true },
    });
    expect(bot.thread!.id).toBe(threadId);
    expect(
      await system.task.count({
        where: { spaceId: actor.spaceId, userId: actor.userId, conversation: true },
      }),
    ).toBe(2);
    const tasks = await owner(() => listConversationTasks(prisma, actor, { botId }));
    expect(tasks.tasks.map((task) => task.id).sort()).toEqual(
      [first.task.id, second.task.id].sort(),
    );
    const target = await owner(() => resolveThreadTarget(prisma, actor, { taskId: first.task.id }));
    const snapshot = await owner(() => threadSnapshot({ prisma }, target));
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.run?.id).toBe(first.task.runId);
    expect(snapshot.activeRuns?.some((run) => run.id === second.task.runId)).toBe(false);
  });

  it("keeps stop and clear scoped to one task conversation", async () => {
    const first = await create("first");
    const second = await create("second");
    const target = await owner(() => resolveThreadTarget(prisma, actor, { taskId: first.task.id }));
    const deps = { prisma, sandbox: new FakeSandboxProvider(), events: createThreadEvents(prisma) };
    await owner(() => stopThreadRuns(deps, actor, target));
    expect((await system.run.findUniqueOrThrow({ where: { id: first.task.runId } })).status).toBe(
      "cancelled",
    );
    expect((await system.run.findUniqueOrThrow({ where: { id: second.task.runId } })).status).toBe(
      "queued",
    );
    await owner(() => clearThreadMessageHistory(deps, actor, target));
    expect(await system.message.count({ where: { threadId: first.task.threadId } })).toBe(0);
    expect(await system.message.count({ where: { threadId: second.task.threadId } })).toBe(1);
  });

  it("answers an approval only in the task that owns its run and ask", async () => {
    const first = await create("approval-first");
    const second = await create("approval-second");
    const asks: string[] = [];
    for (const task of [first.task, second.task]) {
      await system.run.update({
        where: { id: task.runId },
        data: { status: "running", leaseOwner: "test-worker", leaseFence: 1 },
      });
      const attempt = await system.attempt.create({
        data: { runId: task.runId, fence: 1, status: "running" },
      });
      const effect = await system.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: task.runId,
          kind: "native_approval",
          status: "intended",
          idempotencyKey: `approval:${task.id}`,
          request: { command: "reviewed command" },
        },
      });
      await owner(() =>
        pauseRunForInput(prisma, {
          spaceId: actor.spaceId,
          threadId: task.threadId,
          botId,
          runId: task.runId,
          attemptId: attempt.id,
          leaseOwner: "test-worker",
          leaseFence: 1,
          blocks: [
            {
              kind: "ask",
              text: "Approve?",
              status: "pending",
              approvalEffectId: effect.id,
              actions: [
                { id: "allow", label: "Approve" },
                { id: "deny", label: "Reject" },
              ],
            },
          ],
        }),
      );
      asks.push(
        (await system.message.findFirstOrThrow({ where: { runId: task.runId, role: "bot" } })).id,
      );
    }
    const answer = (thread: string) =>
      owner(() =>
        answerRunInput(prisma, {
          spaceId: actor.spaceId,
          threadId: thread,
          runId: first.task.runId,
          messageId: asks[0]!,
          answeredByUserId: actor.userId,
          answer: "allow",
        }),
      );
    expect(await answer(second.task.threadId)).toBe(false);
    expect(await answer(first.task.threadId)).toBe(true);
    expect((await system.run.findUniqueOrThrow({ where: { id: second.task.runId } })).status).toBe(
      "waiting_input",
    );
    expect(
      (
        await system.externalEffect.findFirstOrThrow({
          where: { runId: second.task.runId, kind: "native_approval" },
        })
      ).status,
    ).toBe("intended");
  });

  it("reassigns stopped work once into a fresh execution with durable provenance", async () => {
    const source = await stopped();
    await system.externalEffect.create({
      data: {
        spaceId: actor.spaceId,
        runId: source.id,
        kind: "deployment",
        idempotencyKey: `effect:${source.id}`,
        status: "unknown",
        request: { fake: true },
      },
    });
    const results = await Promise.all(
      ["one", "two"].map((clientNonce) =>
        owner(() =>
          recoverConversationRun(prisma, actor, {
            runId: source.id,
            botId: otherBotId,
            clientNonce,
            text: "Inspect changes before continuing",
          }),
        ),
      ),
    );
    expect(results[0]!.task.id).toBe(results[1]!.task.id);
    const task = results[0]!.task;
    expect(task).toMatchObject({
      botId: otherBotId,
      recoveryOfRunId: source.id,
      originThreadId: threadId,
      originBotId: botId,
      prompt: "Inspect changes before continuing",
    });
    const next = await system.run.findUniqueOrThrow({ where: { id: task.runId } });
    expect(next.id).not.toBe(source.id);
    expect(next.checkpoint).toBeNull();
    expect(await system.externalEffect.count({ where: { runId: next.id } })).toBe(0);
    expect((await system.run.findUniqueOrThrow({ where: { id: source.id } })).checkpoint).toBe(
      "uncertain-native-start",
    );
    expect(
      await system.externalEffect.count({ where: { runId: source.id, status: "unknown" } }),
    ).toBe(1);
    const stoppedRows = await owner(() => stoppedConversationRuns(prisma, actor, threadId));
    expect(stoppedRows[0]!.recoveredTaskId).toBe(task.id);
  });

  it("rejects recovery until the source is terminal and its execution ownership is released", async () => {
    const source = await stopped("running");
    const recover = () =>
      owner(() =>
        recoverConversationRun(prisma, actor, { runId: source.id, botId, clientNonce: "recover" }),
      );
    await expect(recover()).rejects.toMatchObject({ code: "CONFLICT" });
    await system.run.update({ where: { id: source.id }, data: { status: "cancelled" } });
    const bot = await system.bot.findUniqueOrThrow({ where: { id: botId } });
    await system.computerExecutionLease.create({
      data: {
        computerId: bot.computerId!,
        botId,
        runId: source.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(recover()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await system.task.count({
        where: { conversation: true, spaceId: actor.spaceId, userId: actor.userId },
      }),
    ).toBe(0);
  });

  it("requires acknowledged native cleanup using the pinned original binding", async () => {
    const source = await stopped();
    const bot = await system.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { computer: true },
    });
    const computer = await system.computer.update({
      where: { id: bot.computerId! },
      data: { providerRef: "fake-native-provider" },
    });
    await system.run.update({
      where: { id: source.id },
      data: {
        nativeExecutionRunId: "original-native-run",
        nativeComputerId: computer.id,
        nativeComputerKey: computer.homeKey,
      },
    });
    const cancelRunWork = vi
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValue(undefined);
    const sandbox = { cancelRunWork } as unknown as SandboxProvider;
    const request = { runId: source.id, botId: otherBotId, clientNonce: "native-recovery" };
    await expect(
      owner(() => recoverConversationRun(prisma, actor, request, sandbox)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await system.task.count({
        where: { conversation: true, spaceId: actor.spaceId, userId: actor.userId },
      }),
    ).toBe(0);
    const result = await owner(() => recoverConversationRun(prisma, actor, request, sandbox));
    expect(result.task.recoveryOfRunId).toBe(source.id);
    expect(cancelRunWork).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: computer.homeKey }),
      computer.id,
      "original-native-run",
      // The request uses the durable Rakazo run to resolve its registered host;
      // the positional target remains the original native process being stopped.
      expect.objectContaining({ requireRunCleanup: true, runId: source.id }),
    );
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: result.task.runId } }))
        .nativeExecutionRunId,
    ).toBeNull();
  });

  it("moves a pending queued item into exactly one task without leaving executable input", async () => {
    const original = await stopped("running");
    const target = await owner(() => resolveThreadTarget(prisma, actor, { botId }));
    if (target.kind !== "bot") throw new Error("fixture target");
    const queued = await owner(() =>
      mutateThreadQueue(prisma, actor, target, { kind: "enqueue", text: "queued task" }),
    );
    const entry = queued.snapshot.entries[0]!;
    const request = { id: entry.id, revision: queued.snapshot.revision, clientNonce: "move" };
    const result = await owner(() => startQueuedConversationTask(prisma, actor, target, request));
    expect(
      (await owner(() => startQueuedConversationTask(prisma, actor, target, request))).task.id,
    ).toBe(result.task.id);
    expect(
      (await system.steeringMessage.findUniqueOrThrow({ where: { id: entry.id } })).cancelledAt,
    ).not.toBeNull();
    expect(
      (await system.task.findUniqueOrThrow({ where: { id: result.task.id } })).sourceQueuedInputId,
    ).toBe(entry.id);
    expect(
      await owner(() => loadRunHistoryMessages(prisma, { id: original.id, botId, threadId }, 100)),
    ).toEqual([]);
    await expect(
      owner(() =>
        startQueuedConversationTask(prisma, actor, target, { ...request, id: "different-entry" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      owner(() =>
        startQueuedConversationTask(prisma, actor, target, { ...request, clientNonce: "stale" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cancels an untouched queue continuation when its only input becomes a task", async () => {
    const target = await owner(() => resolveThreadTarget(prisma, actor, { botId }));
    if (target.kind !== "bot") throw new Error("fixture target");
    const queued = await owner(() =>
      mutateThreadQueue(prisma, actor, target, { kind: "enqueue", text: "single task" }),
    );
    await owner(() =>
      startQueuedConversationTask(prisma, actor, target, {
        id: queued.snapshot.entries[0]!.id,
        revision: queued.snapshot.revision,
        clientNonce: "move-idle",
      }),
    );
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: queued.continuationRunId! } })).status,
    ).toBe("cancelled");
  });

  it("keeps the existing same-bot computer lease exclusive across separate task sessions", async () => {
    const first = await create("first");
    const second = await create("second");
    const bot = await system.bot.findUniqueOrThrow({ where: { id: botId } });
    await system.computer.update({ where: { id: bot.computerId! }, data: { scope: "team" } });
    await owner(() =>
      acquireComputerExecutionLease(prisma, {
        computerId: bot.computerId!,
        botId,
        runId: first.task.runId,
      }),
    );
    await expect(
      owner(() =>
        acquireComputerExecutionLease(prisma, {
          computerId: bot.computerId!,
          botId,
          runId: second.task.runId,
        }),
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("does not resolve another user's task or a regular turn task", async () => {
    const task = await create("private");
    const normal = await stopped();
    await expect(
      owner(() =>
        resolveThreadTarget(
          prisma,
          { ...actor, userId: "different-user" },
          { taskId: task.task.id },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      owner(() => resolveThreadTarget(prisma, actor, { taskId: normal.taskId })),
    ).rejects.toThrow();
  });
});
