import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  claimSteering,
  createDb,
  createPendingSteeringRun,
  createRepos,
  createThreadMessage,
  loadRunHistoryMessages,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueueMutation, QueueTarget } from "./thread-queue.js";
import { mutateThreadQueue, readThreadQueue, resolveQueueTarget } from "./thread-queue.js";
import type { ThreadTarget } from "./thread-target.js";
import { resolveThreadTarget } from "./thread-target.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
describePostgres("editable thread queue (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  let target: QueueTarget;
  const address = `queue-${randomUUID()}@example.invalid`;
  const owner = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
  const queue = () => owner(() => readThreadQueue(prisma, actor, target));
  const mutate = (input: QueueMutation) =>
    owner(() => mutateThreadQueue(prisma, actor, target, input));
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("queue test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "queue-test", address },
        { signupsEnabled: "true", signupAllowlist: undefined },
      ),
    );
    actor = { userId: identity.userId, spaceId: identity.spaceId } as Actor;
    botId = identity.botId;
    threadId = identity.threadId;
  });
  beforeEach(async () => {
    await system.message.deleteMany({ where: { threadId } });
    await system.run.deleteMany({ where: { threadId } });
    await system.task.deleteMany({ where: { threadId } });
    target = await owner(async () =>
      resolveQueueTarget(prisma, actor, await resolveThreadTarget(prisma, actor, { botId })),
    );
  });
  afterAll(async () => {
    try {
      if (actor) {
        await system.messagingIdentity.deleteMany({ where: { provider: "queue-test", address } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });
  async function busy(status = "running") {
    const task = await system.task.create({
      data: { ...actor, botId, threadId, prompt: "original work", status },
    });
    return system.run.create({
      data: {
        ...actor,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status,
        leaseOwner: "queue-worker",
        leaseFence: 1,
      },
    });
  }
  const claim = (runId: string, initial = true) =>
    owner(() =>
      claimSteering(prisma, {
        threadId,
        botId,
        runId,
        leaseOwner: "queue-worker",
        leaseFence: 1,
        seenIds: [],
        initial,
      }),
    );
  async function start(runId: string) {
    await system.run.update({
      where: { id: runId },
      data: { status: "running", leaseOwner: "queue-worker", leaseFence: 1 },
    });
  }

  it("defers explicit input, edits, cancels, orders claims and permanently suppresses cancelled history", async () => {
    const original = await busy();
    await mutate({ kind: "enqueue", text: "first", clientNonce: "first" });
    const added = await mutate({ kind: "enqueue", text: "second", clientNonce: "second" });
    const [first, second] = added.snapshot.entries;
    expect(await claim(original.id)).toEqual([]);
    expect(
      await owner(() => loadRunHistoryMessages(prisma, { id: original.id, threadId, botId }, 100)),
    ).toEqual([]);
    const edited = await mutate({
      kind: "edit",
      id: first!.id,
      revision: added.snapshot.revision,
      text: "edited first",
    });
    await expect(
      mutate({ kind: "cancel", id: second!.id, revision: added.snapshot.revision }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const reordered = await mutate({
      kind: "reorder",
      ids: [second!.id, first!.id],
      revision: edited.snapshot.revision,
    });
    expect(reordered.snapshot.entries.map((entry) => entry.text)).toEqual([
      "second",
      "edited first",
    ]);
    const cancelled = await mutate({
      kind: "cancel",
      id: second!.id,
      revision: reordered.snapshot.revision,
    });
    expect(cancelled.snapshot.entries.map((entry) => entry.text)).toEqual(["edited first"]);
    await system.run.update({ where: { id: original.id }, data: { status: "completed" } });
    const continuation = await owner(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        return createPendingSteeringRun(tx, { spaceId: actor.spaceId, threadId, botId });
      }),
    );
    await start(continuation!);
    const consumed = await claim(continuation!);
    expect(consumed.map((entry) => entry.text)).toEqual(["edited first"]);
    const fresh = await queue();
    expect(fresh.entries).toEqual([]);
    await expect(
      mutate({ kind: "edit", id: first!.id, revision: fresh.revision, text: "too late" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const history = await owner(() =>
      loadRunHistoryMessages(prisma, { id: continuation!, threadId, botId }, 100),
    );
    expect(history.map((message) => message.id)).toEqual([first!.messageId]);
    expect(await system.steeringMessage.findUnique({ where: { id: second!.id } })).toMatchObject({
      cancelledAt: expect.any(Date),
    });
  });

  it("honors reorder when one input already has a scheduled continuation", async () => {
    const first = await mutate({ kind: "enqueue", text: "first" });
    const second = await mutate({ kind: "enqueue", text: "second" });
    await mutate({
      kind: "reorder",
      ids: second.snapshot.entries.map((entry) => entry.id).reverse(),
      revision: second.snapshot.revision,
    });
    await start(first.continuationRunId!);
    const consumed = await claim(first.continuationRunId!);
    expect(consumed.map((entry) => entry.text)).toEqual(["second", "first"]);
    expect(
      (await system.run.findUnique({ where: { id: first.continuationRunId! } }))?.sourceMessageId,
    ).toBe(second.snapshot.entries[1]!.messageId);
    await mutate({ kind: "enqueue", text: "next turn" });
    // A native no-checkpoint retry must keep the original accepted prompt.
    expect((await claim(first.continuationRunId!, true)).map((entry) => entry.text)).toEqual([
      "second",
      "first",
    ]);
    expect(
      await owner(() =>
        claimSteering(prisma, {
          threadId,
          botId,
          runId: first.continuationRunId!,
          leaseOwner: "queue-worker",
          leaseFence: 1,
          initial: false,
          seenIds: consumed.map((entry) => entry.id),
        }),
      ),
    ).toEqual([]);
  });

  it("serializes concurrent editors, isolates tenants and rejects incomplete reorder", async () => {
    await busy();
    const added = await mutate({ kind: "enqueue", text: "original" });
    const id = added.snapshot.entries[0]!.id;
    const results = await Promise.allSettled([
      mutate({ kind: "edit", id, revision: added.snapshot.revision, text: "one" }),
      mutate({ kind: "edit", id, revision: added.snapshot.revision, text: "two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await queue();
    await expect(
      mutate({ kind: "reorder", ids: [], revision: current.revision }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const stranger = { ...actor, userId: `stranger-${randomUUID()}` };
    await expect(
      runAsTenant(stranger, () => readThreadQueue(prisma, stranger, target)),
    ).rejects.toThrow("Resource not found");
    await expect(
      runAsTenant(stranger, () =>
        mutateThreadQueue(prisma, stranger, target, {
          kind: "cancel",
          id,
          revision: current.revision,
        }),
      ),
    ).rejects.toThrow("Resource not found");
  });

  it("holds explicit queue through approval while ordinary steering remains separate", async () => {
    const waiting = await busy("waiting_input");
    const added = await mutate({ kind: "enqueue", text: "after approval" });
    expect(added.continuationRunId).toBeNull();
    expect(added.snapshot.waitingReason).toBe("approval");
    expect(await system.run.count({ where: { threadId } })).toBe(1);
    await system.run.update({ where: { id: waiting.id }, data: { status: "running" } });
    expect(await claim(waiting.id)).toEqual([]);
  });

  it("retains idempotency and delivers explicit native live steering", async () => {
    const active = await busy();
    await mutate({ kind: "enqueue", text: "queued", clientNonce: "same" });
    const replay = await mutate({ kind: "enqueue", text: "queued", clientNonce: "same" });
    expect(replay.snapshot.entries).toHaveLength(1);
    const native = {
      ...target,
      bot: { ...(target as Extract<ThreadTarget, { kind: "bot" }>).bot, runtimeKind: "codex" },
    } as QueueTarget;
    const snapshot = await owner(() => readThreadQueue(prisma, actor, native));
    expect(snapshot.canSteer).toBe(true);
    await owner(() =>
      mutateThreadQueue(prisma, actor, native, {
        kind: "steer",
        id: snapshot.entries[0]!.id,
        revision: snapshot.revision,
      }),
    );
    expect((await claim(active.id, false)).map((message) => message.text)).toEqual(["queued"]);
    await system.steeringMessage.delete({ where: { id: snapshot.entries[0]!.id } });
    expect(
      (await mutate({ kind: "enqueue", text: "queued", clientNonce: "same" })).snapshot.entries,
    ).toEqual([]);
    expect(await system.message.count({ where: { threadId } })).toBe(1);
  });

  it("cancels an empty scheduled continuation and schedules the next pending input", async () => {
    const first = await mutate({ kind: "enqueue", text: "cancel this" });
    const second = await mutate({ kind: "enqueue", text: "keep this" });
    const cancelled = await mutate({
      kind: "cancel",
      id: first.snapshot.entries[0]!.id,
      revision: second.snapshot.revision,
    });
    expect((await system.run.findUnique({ where: { id: first.continuationRunId! } }))?.status).toBe(
      "cancelled",
    );
    expect(cancelled.continuationRunId).toBeTruthy();
    await start(cancelled.continuationRunId!);
    expect((await claim(cancelled.continuationRunId!)).map((entry) => entry.text)).toEqual([
      "keep this",
    ]);
  });

  it("masks queued reply targets and can explicitly steer supported running work", async () => {
    const active = await busy();
    const added = await mutate({ kind: "enqueue", text: "private pending instruction" });
    const entry = added.snapshot.entries[0]!;
    await owner(() =>
      createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "visible reply" }],
        replyToMessageId: entry.messageId,
        replyQuote: "private pending instruction",
      }),
    );
    const history = await owner(() =>
      loadRunHistoryMessages(prisma, { id: active.id, threadId, botId }, 100),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ replyTo: null, replyQuote: null });
    const snapshot = await queue();
    expect(snapshot.entries[0]!.canSteer).toBe(true);
    await mutate({ kind: "steer", id: entry.id, revision: snapshot.revision });
    expect((await claim(active.id, false)).map((item) => item.text)).toEqual([
      "private pending instruction",
    ]);
  });
  it("requires an explicit current group member and keeps recipient queues independent", async () => {
    const peer = await owner(() =>
      createRepos(prisma).createBot(actor, {
        name: "Queue peer",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const group = await system.chatGroup.create({
      data: {
        ...actor,
        name: "Queue group",
        members: { create: [{ botId }, { botId: peer.id }] },
        thread: { create: { ...actor } },
      },
      include: { thread: true },
    });
    try {
      const groupTarget = await owner(() =>
        resolveThreadTarget(prisma, actor, { groupId: group.id }),
      );
      await expect(
        owner(() => resolveQueueTarget(prisma, actor, groupTarget)),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        owner(() => resolveQueueTarget(prisma, actor, groupTarget, "not-a-member")),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const a = await owner(() => resolveQueueTarget(prisma, actor, groupTarget, botId));
      const b = await owner(() => resolveQueueTarget(prisma, actor, groupTarget, peer.id));
      const first = await owner(() =>
        mutateThreadQueue(prisma, actor, a, {
          kind: "enqueue",
          text: "Only first bot",
          clientNonce: "same",
        }),
      );
      const second = await owner(() =>
        mutateThreadQueue(prisma, actor, b, {
          kind: "enqueue",
          text: "Only second bot",
          clientNonce: "same",
        }),
      );
      expect(first.snapshot.entries.map((entry) => entry.botId)).toEqual([botId]);
      const peerHistory = () =>
        owner(() =>
          loadRunHistoryMessages(
            prisma,
            { id: second.continuationRunId!, threadId: group.thread!.id, botId: peer.id },
            100,
          ),
        );
      expect(await peerHistory()).toEqual([]);
      await owner(() =>
        createThreadMessage(prisma, {
          threadId: group.thread!.id,
          role: "user",
          blocks: [{ kind: "text", text: "visible reply" }],
          replyToMessageId: first.snapshot.entries[0]!.messageId,
          replyQuote: "Only first bot",
        }),
      );
      expect(await peerHistory()).toEqual([
        expect.objectContaining({ replyTo: null, replyQuote: null }),
      ]);

      expect(second.snapshot.entries.map((entry) => entry.text)).toEqual(["Only second bot"]);
      await expect(
        owner(() =>
          mutateThreadQueue(prisma, actor, b, {
            kind: "cancel",
            id: first.snapshot.entries[0]!.id,
            revision: second.snapshot.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const latest = await owner(() => readThreadQueue(prisma, actor, a));
      await owner(() =>
        mutateThreadQueue(prisma, actor, a, {
          kind: "cancel",
          id: first.snapshot.entries[0]!.id,
          revision: latest.revision,
        }),
      );
      expect(await peerHistory()).toEqual([
        expect.objectContaining({ replyTo: null, replyQuote: null }),
      ]);
      await system.chatGroupMember.deleteMany({ where: { groupId: group.id, botId } });
      // Reject a target resolved before membership changed, inside the write transaction.
      await expect(
        owner(() => mutateThreadQueue(prisma, actor, a, { kind: "enqueue", text: "stale member" })),
      ).rejects.toBeInstanceOf(Error);
      expect(await system.message.count({ where: { threadId: group.thread!.id } })).toBe(3);
    } finally {
      await system.chatGroup.delete({ where: { id: group.id } });
    }
  });
});
