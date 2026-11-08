import { ORPCError } from "@orpc/server";
import type { Actor, ThreadQueue } from "@rakazo/contracts";
import { NativeRuntimeCapabilities } from "@rakazo/contracts";
import {
  isConversationalRun,
  QUEUE_HOLDING_RUN_STATUSES,
  STEERING_CONTINUATION_PROMPT,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createPendingSteeringRun,
  createRepos,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";

export type QueueTarget = Extract<ThreadTarget, { kind: "bot" }> & { queueGroupId?: string };
type DirectTarget = QueueTarget;
export type QueueMutation =
  | { kind: "enqueue"; text: string; clientNonce?: string }
  | { kind: "edit"; id: string; revision: number; text: string }
  | { kind: "cancel"; id: string; revision: number }
  | { kind: "reorder"; ids: string[]; revision: number }
  | { kind: "steer"; id: string; revision: number };

export async function resolveQueueTarget(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  recipientBotId?: string,
): Promise<QueueTarget> {
  if (target.kind === "bot") return target;
  if (!recipientBotId || !target.memberBotIds.includes(recipientBotId))
    throw new ORPCError("BAD_REQUEST", { message: "Choose a member of this conversation." });
  const bot = await createRepos(prisma).getBot(actor, recipientBotId);
  return {
    kind: "bot",
    botId: bot.id,
    bot,
    threadId: target.threadId,
    queueGroupId: target.groupId,
  };
}

export async function lockQueueGroup(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: QueueTarget,
) {
  if (!target.queueGroupId) return;
  // Match group send/membership mutation lock order, then validate inside the transaction.
  await lockOwnedGroup(tx, actor, target.queueGroupId);
  const member = await tx.chatGroupMember.findFirst({
    where: { groupId: target.queueGroupId, botId: target.botId },
  });
  if (!member) throw new IsolationError();
}
const conflict = () =>
  new ORPCError("CONFLICT", { message: "The queue changed. Refresh and try again." });

export async function queueState(tx: Prisma.TransactionClient, actor: Actor, target: DirectTarget) {
  const thread = await tx.thread.findFirst({
    where: { id: target.threadId, spaceId: actor.spaceId, userId: actor.userId },
    select: { nextEventSeq: true },
  });
  if (!thread) throw new IsolationError();
  const [rows, active, changed] = await Promise.all([
    tx.steeringMessage.findMany({
      where: {
        botId: target.botId,
        userId: actor.userId,
        claimedAt: null,
        cancelledAt: null,
        originTrigger: null,
        message: { threadId: target.threadId, role: "user" },
      },
      include: { message: { select: { id: true, seq: true, blocks: true } } },
    }),
    tx.run.findFirst({
      where: {
        threadId: target.threadId,
        botId: target.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        status: { in: [...QUEUE_HOLDING_RUN_STATUSES, "waiting_input"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    tx.event.findFirst({
      where: {
        threadId: target.threadId,
        OR: [
          {
            type: {
              in: [
                "thread.queue.updated",
                "thread.cleared",
                "thread.ask",
                "thread.choice",
                "thread.computer",
                "run.queue.started",
                "run.steering.claimed",
                "run.started",
                "run.waiting_input",
                "run.completed",
                "run.failed",
                "run.cancelled",
                "computer.takeover.requested",
                "computer.takeover.released",
              ],
            },
          },
          { type: "thread.message.created", payload: { path: ["role"], equals: "user" } },
        ],
      },
      orderBy: { seq: "desc" },
      select: { seq: true },
    }),
  ]);
  rows.sort(
    (a, b) =>
      (a.queuePosition ?? a.message.seq) - (b.queuePosition ?? b.message.seq) ||
      a.id.localeCompare(b.id),
  );
  const runtimeKind = target.bot.runtimeKind;
  const supportsSteering =
    !runtimeKind ||
    runtimeKind === "pi" ||
    NativeRuntimeCapabilities[runtimeKind as keyof typeof NativeRuntimeCapabilities]?.steering ===
      true;
  const canSteer =
    supportsSteering && active?.status === "running" && isConversationalRun(active.trigger);
  const snapshot: ThreadQueue = {
    revision: changed ? changed.seq + 1 : 0,
    entries: rows.map((row) => ({
      id: row.id,
      messageId: row.messageId,
      botId: row.botId,
      botName: target.bot.name,
      text: (row.message.blocks as Array<{ kind: string; text?: string }>)
        .filter((block) => block.kind === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      position: row.queuePosition ?? row.message.seq,
      canSteer: Boolean(canSteer && row.deliveryMode === "queue"),
    })),
    canSteer: Boolean(canSteer),
    waitingReason:
      active?.status === "waiting_input"
        ? "approval"
        : active?.status === "waiting_takeover"
          ? "computer"
          : active
            ? "running"
            : "ready",
  };
  return { rows, active, snapshot };
}

export async function readThreadQueue(
  prisma: PrismaClient,
  actor: Actor,
  target: QueueTarget,
): Promise<ThreadQueue> {
  return prisma.$transaction(async (tx) => {
    await lockQueueGroup(tx, actor, target);
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
    return (await queueState(tx, actor, target)).snapshot;
  });
}

export async function mutateThreadQueue(
  prisma: PrismaClient,
  actor: Actor,
  target: QueueTarget,
  mutation: QueueMutation,
) {
  return prisma.$transaction(async (tx) => {
    await lockQueueGroup(tx, actor, target);
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const current = await queueState(tx, actor, target);
    if (mutation.kind !== "enqueue" && mutation.revision !== current.snapshot.revision)
      throw conflict();
    let continuationRunId: string | null = null;
    if (mutation.kind === "enqueue") {
      const clientNonce = mutation.clientNonce
        ? `queue:${target.botId}:${mutation.clientNonce}`
        : undefined;
      if (clientNonce) {
        const replay = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: target.threadId, clientNonce } },
        });
        if (replay) {
          return { snapshot: current.snapshot, continuationRunId, eventSeq: null };
        }
      }
      if (current.rows.length >= 200)
        throw new ORPCError("BAD_REQUEST", { message: "The queue is full." });
      const blocks = [{ kind: "text" as const, text: mutation.text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks,
        clientNonce,
      });
      await tx.steeringMessage.create({
        data: {
          messageId: message.id,
          botId: target.botId,
          userId: actor.userId,
          deliveryMode: "queue",
        },
      });
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "user", blocks },
      });
      continuationRunId = await createPendingSteeringRun(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
      });
    } else if (mutation.kind === "reorder") {
      if (
        new Set(mutation.ids).size !== mutation.ids.length ||
        mutation.ids.length !== current.rows.length ||
        mutation.ids.some((id) => !current.rows.some((row) => row.id === id))
      )
        throw conflict();
      // Reuse the occupied message positions, so older writers still append naturally.
      const positions = current.rows.map((row) => row.message.seq).sort((a, b) => a - b);
      for (const [index, id] of mutation.ids.entries())
        await tx.steeringMessage.update({
          where: { id },
          data: { queuePosition: positions[index] },
        });
    } else {
      const entry = current.rows.find((row) => row.id === mutation.id);
      if (!entry) throw conflict();
      if (mutation.kind === "edit") {
        const previous = entry.message.blocks as Array<{ kind: string; text?: string }>;
        const blocks = [
          { kind: "text", text: mutation.text },
          ...previous.filter((block) => block.kind !== "text"),
        ];
        await tx.message.update({
          where: { id: entry.messageId },
          data: { blocks: blocks as Prisma.InputJsonValue },
        });
        await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          type: "thread.message.updated",
          payload: { messageId: entry.messageId, role: "user", blocks },
        });
      } else if (mutation.kind === "cancel") {
        continuationRunId = await cancelQueuedEntry(tx, actor, target, entry);
      } else {
        if (
          !current.snapshot.entries.find((item) => item.id === entry.id)?.canSteer ||
          !current.active
        )
          throw new ORPCError("BAD_REQUEST", {
            message: "This runtime cannot steer the active turn.",
          });
        await tx.steeringMessage.update({
          where: { id: entry.id },
          data: { deliveryMode: "steer", runId: current.active.id },
        });
      }
    }
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.queue.updated",
      payload: {},
    });
    return {
      snapshot: (await queueState(tx, actor, target)).snapshot,
      continuationRunId,
      eventSeq: event.seq,
    };
  });
}

/** Caller holds the group and thread locks, so removal and task creation can commit together. */
export async function cancelQueuedEntry(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: QueueTarget,
  entry: Awaited<ReturnType<typeof queueState>>["rows"][number],
) {
  await tx.steeringMessage.update({
    where: { id: entry.id },
    data: { cancelledAt: new Date() },
  });
  let hasRemainingInput = false;
  if (entry.runId) {
    const replacement = await tx.steeringMessage.findFirst({
      where: { runId: entry.runId, cancelledAt: null },
      orderBy: { message: { seq: "desc" } },
      select: { messageId: true },
    });
    hasRemainingInput = replacement !== null;
    await tx.run.updateMany({
      where: { id: entry.runId, sourceMessageId: entry.messageId },
      data: { sourceMessageId: replacement?.messageId ?? null },
    });
  }
  // An untouched continuation with no remaining input should never call a model.
  if (entry.runId && !hasRemainingInput) {
    const run = await tx.run.findFirst({
      where: {
        id: entry.runId,
        status: { in: ["queued", "leased"] },
        task: { prompt: STEERING_CONTINUATION_PROMPT },
        trigger: "follow_up",
      },
    });
    if (run) {
      await tx.run.update({
        where: { id: run.id },
        data: {
          status: "cancelled",
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: target.botId,
        runId: run.id,
        type: "run.cancelled",
        payload: {},
      });
    }
  }
  return createPendingSteeringRun(tx, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    botId: target.botId,
  });
}
