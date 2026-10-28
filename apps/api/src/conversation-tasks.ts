import { ORPCError } from "@orpc/server";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import type { Actor, ConversationTask, StoppedConversationRun } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
} from "@rakazo/db";
import type { QueueTarget } from "./thread-queue.js";
import { cancelQueuedEntry, lockQueueGroup, queueState } from "./thread-queue.js";

const conflict = () =>
  new ORPCError("CONFLICT", { message: "This work changed. Refresh and try again." });
const taskInclude = {
  bot: { select: { name: true } },
  thread: {
    include: {
      runs: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
      messages: {
        where: { role: "user" },
        orderBy: { seq: "asc" },
        take: 1,
        select: { blocks: true },
      },
    },
  },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function userText(blocks: unknown, fallback: string): string {
  if (!Array.isArray(blocks)) return fallback;
  const text = blocks
    .flatMap((block) =>
      block && typeof block === "object" && block.kind === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  return text || fallback;
}

type Origin = Pick<ConversationTask, "originBotId" | "originGroupId" | "originTaskId">;
const originSelect = {
  id: true,
  botId: true,
  groupId: true,
  taskBotId: true,
  tasks: { where: { conversation: true }, select: { id: true }, take: 1 },
} satisfies Prisma.ThreadSelect;
function originView(row: Prisma.ThreadGetPayload<{ select: typeof originSelect }> | null): Origin {
  if (!row) return {};
  return row.groupId
    ? { originGroupId: row.groupId }
    : row.taskBotId
      ? { originBotId: row.taskBotId, ...(row.tasks[0] ? { originTaskId: row.tasks[0].id } : {}) }
      : row.botId
        ? { originBotId: row.botId }
        : {};
}
async function originOf(tx: Prisma.TransactionClient, actor: Actor, threadId: string | null) {
  return threadId
    ? originView(
        await tx.thread.findFirst({
          where: { id: threadId, spaceId: actor.spaceId, userId: actor.userId },
          select: originSelect,
        }),
      )
    : {};
}

function taskView(row: TaskRow, origin: Origin = {}): ConversationTask {
  const run = row.thread.runs[0];
  if (!run) throw new IsolationError("Task conversation has no execution");
  return {
    ...origin,
    id: row.id,
    threadId: row.threadId,
    botId: row.botId,
    botName: row.bot.name,
    prompt: userText(row.thread.messages[0]?.blocks, row.prompt),
    writeSubdirectory: row.writeSubdirectory,
    status: run.status as ConversationTask["status"],
    runId: run.id,
    originThreadId: row.originThreadId,
    recoveryOfRunId: row.recoveryOfRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function replay(
  tx: Prisma.TransactionClient,
  actor: Actor,
  clientNonce: string,
  botId: string,
) {
  const existing = await tx.task.findUnique({
    where: { spaceId_clientNonce: { spaceId: actor.spaceId, clientNonce } },
    include: taskInclude,
  });
  if (!existing) return null;
  if (existing.userId !== actor.userId || !existing.conversation || existing.botId !== botId)
    throw conflict();
  return taskView(existing, await originOf(tx, actor, existing.originThreadId));
}

/** Serialize request receipts across origins, without relying on a unique-violation retry. */
async function lockReceipt(tx: Prisma.TransactionClient, actor: Actor, nonce: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.spaceId}:${nonce}`}, 0))`;
}

async function createInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: {
    botId: string;
    text: string;
    prompt?: string;
    clientNonce: string;
    originThreadId: string;
    recoveryOfRunId?: string;
    sourceQueuedInputId?: string;
    writeSubdirectory?: string;
  },
) {
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, runtimeKind: true, runtimePermission: true, projectPath: true },
  });
  if (!bot) throw new IsolationError();
  if (input.writeSubdirectory && (bot.runtimeKind !== "codex" || bot.runtimePermission !== "workspace" || !bot.projectPath))
    throw new ORPCError("BAD_REQUEST", { message: "Task write scopes require Codex Workspace." });
  // botId remains reserved for the one direct conversation. Execution still uses
  // this bot's existing lease, computer, credentials and permission policy.
  const thread = await tx.thread.create({
    data: { spaceId: actor.spaceId, userId: actor.userId, taskBotId: bot.id },
  });
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      threadId: thread.id,
      prompt: input.prompt ?? input.text,
      status: "queued",
      conversation: true,
      writeSubdirectory: input.writeSubdirectory,
      originThreadId: input.originThreadId,
      recoveryOfRunId: input.recoveryOfRunId,
      sourceQueuedInputId: input.sourceQueuedInputId,
      clientNonce: input.clientNonce,
    },
  });
  const blocks = [{ kind: "text" as const, text: input.text }];
  const message = await createThreadMessageInTransaction(tx, {
    threadId: thread.id,
    role: "user",
    blocks,
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      threadId: thread.id,
      taskId: task.id,
      status: "queued",
      trigger: "user",
      sourceMessageId: message.id,
      clientNonce: `conversation-task:${task.id}`,
    },
  });
  await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
  const event = await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId: thread.id,
    botId: bot.id,
    runId: run.id,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "user", blocks },
  });
  const originEvent = await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId: input.originThreadId,
    botId: bot.id,
    type: "thread.tasks.updated",
    payload: { taskId: task.id, recoveryOfRunId: input.recoveryOfRunId },
  });
  const row = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  return {
    task: taskView(row, await originOf(tx, actor, row.originThreadId)),
    eventSeq: event.seq,
    originEventSeq: originEvent.seq,
    continuationRunId: null as string | null,
  };
}

export async function getConversationTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  const row = await prisma.task.findFirst({
    where: {
      id: taskId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      conversation: true,
      bot: { archivedAt: null },
    },
    include: taskInclude,
  });
  if (!row) throw new IsolationError();
  return taskView(row, await originOf(prisma, actor, row.originThreadId));
}

export async function listConversationTasks(
  prisma: PrismaClient,
  actor: Actor,
  filter: { botId?: string; botThreadId?: string; originThreadId?: string; cursor?: string },
) {
  const where: Prisma.TaskWhereInput = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    conversation: true,
    bot: { archivedAt: null },
    ...(filter.botId
      ? {
          OR: [
            { botId: filter.botId },
            ...(filter.botThreadId ? [{ originThreadId: filter.botThreadId }] : []),
          ],
        }
      : {}),
    ...(filter.originThreadId ? { originThreadId: filter.originThreadId } : {}),
  };
  if (
    filter.cursor &&
    !(await prisma.task.findFirst({ where: { ...where, id: filter.cursor }, select: { id: true } }))
  )
    throw new IsolationError();
  const rows = await prisma.task.findMany({
    where,
    include: taskInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const origins = await prisma.thread.findMany({
    where: {
      id: { in: rows.flatMap((row) => (row.originThreadId ? [row.originThreadId] : [])) },
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
    select: originSelect,
  });
  const originById = new Map(origins.map((origin) => [origin.id, originView(origin)]));
  return {
    tasks: rows
      .slice(0, 100)
      .map((row) => taskView(row, row.originThreadId ? originById.get(row.originThreadId) : {})),
    nextCursor: rows.length > 100 ? rows[99]!.id : null,
  };
}

export async function stoppedConversationRuns(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<StoppedConversationRun[]> {
  const runs = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      threadId,
      status: { in: ["failed", "cancelled"] },
      bot: { archivedAt: null },
    },
    include: {
      task: { select: { prompt: true } },
      bot: { select: { name: true } },
      sourceMessage: { select: { blocks: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const successors = await prisma.task.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      recoveryOfRunId: { in: runs.map((run) => run.id) },
      conversation: true,
    },
    select: { id: true, recoveryOfRunId: true },
  });
  return runs.map((run) => ({
    runId: run.id,
    taskId: run.taskId,
    botId: run.botId,
    botName: run.bot.name,
    prompt: userText(run.sourceMessage?.blocks, run.task.prompt),
    status: run.status as "failed" | "cancelled",
    error: run.error,
    recoveredTaskId: successors.find((task) => task.recoveryOfRunId === run.id)?.id ?? null,
    createdAt: run.createdAt.toISOString(),
  }));
}

export async function createConversationTask(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; text: string; clientNonce: string; originThreadId: string; writeSubdirectory?: string },
) {
  return prisma.$transaction(async (tx) => {
    const nonce = `task:${input.clientNonce}`;
    await lockReceipt(tx, actor, nonce);
    const existing = await replay(tx, actor, nonce, input.botId);
    if (existing) {
      if (existing.originThreadId !== input.originThreadId || (existing.writeSubdirectory ?? undefined) !== input.writeSubdirectory) throw conflict();
      return { task: existing, eventSeq: null, originEventSeq: null, continuationRunId: null };
    }
    const originGroup = await tx.thread.findFirst({
      where: { id: input.originThreadId, spaceId: actor.spaceId, userId: actor.userId },
      select: { groupId: true },
    });
    if (originGroup?.groupId) {
      await lockOwnedGroup(tx, actor, originGroup.groupId);
      if (
        !(await tx.chatGroupMember.findFirst({
          where: { groupId: originGroup.groupId, botId: input.botId },
        }))
      )
        throw new IsolationError();
    }
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.originThreadId} FOR UPDATE`;
    const origin = await tx.thread.findFirst({
      where: { id: input.originThreadId, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (!origin) throw new IsolationError();
    return createInTransaction(tx, actor, { ...input, clientNonce: nonce });
  });
}

export function recoveryPrompt(input: {
  runId: string;
  botId: string;
  status: string;
  prompt: string;
  text?: string;
}) {
  return [
    `This is a deliberate new execution recovering stopped run ${input.runId} (assignee ${input.botId}, status ${input.status}).`,
    "The previous execution may have completed effects before it stopped. Inspect the current workspace and external state first. Do not repeat commands, payments, messages, deployments or other effects unless you have verified they did not occur or the user explicitly approves repeating them. Ask the user when the outcome is uncertain. Do not resume or attach to the previous native turn.",
    `Original request:\n${input.prompt}`,
    ...(input.text ? [`Recovery instructions:\n${input.text}`] : []),
  ].join("\n\n");
}

export async function recoverConversationRun(
  prisma: PrismaClient,
  actor: Actor,
  input: { runId: string; botId: string; clientNonce: string; text?: string },
  sandbox?: SandboxProvider,
  onRecovered?: (tx: Prisma.TransactionClient, task: ConversationTask) => Promise<void>,
) {
  return prisma.$transaction(
    async (tx) => {
      const result = await (async () => {
        const nonce = `recovery:${input.clientNonce}`;
        await lockReceipt(tx, actor, nonce);
        const existing = await replay(tx, actor, nonce, input.botId);
        if (existing) {
          if (existing.recoveryOfRunId !== input.runId) throw conflict();
          return { task: existing, eventSeq: null, originEventSeq: null, continuationRunId: null };
        }
        const source = await tx.run.findFirst({
          where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
          include: { task: true, bot: { select: { runtimeKind: true } } },
        });
        if (!source) throw new IsolationError();
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
        const stopped = await tx.run.findFirst({
          where: {
            id: source.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: { in: ["failed", "cancelled"] },
          },
        });
        if (!stopped) throw conflict();
        const successor = await tx.task.findUnique({
          where: { recoveryOfRunId: source.id },
          include: taskInclude,
        });
        if (successor)
          return {
            task: taskView(successor, await originOf(tx, actor, successor.originThreadId)),
            eventSeq: null,
            originEventSeq: null,
            continuationRunId: null,
          };
        // Teardown must release its durable ownership before a new execution is admitted.
        const lease = await tx.computerExecutionLease.findFirst({
          where: { runId: source.id, expiresAt: { gt: new Date() } },
        });
        if (lease)
          throw new ORPCError("CONFLICT", {
            message: "This execution is still stopping. Try again shortly.",
          });
        if (
          source.nativeExecutionRunId ||
          ["codex-native", "claude-native", "acp-native"].includes(source.modelProvider ?? "") ||
          ["codex", "claude", "acp"].includes(source.bot.runtimeKind ?? "pi")
        ) {
          const computer = source.nativeComputerId
            ? await tx.computer.findFirst({
                where: {
                  id: source.nativeComputerId,
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                },
              })
            : null;
          if (
            !computer?.providerRef ||
            !source.nativeExecutionRunId ||
            !source.nativeComputerKey ||
            computer.homeKey !== source.nativeComputerKey ||
            computer.registeredHostId !== source.nativeHostId ||
            !sandbox?.cancelRunWork
          )
            throw new ORPCError("CONFLICT", {
              message: "The previous native execution cannot be safely stopped.",
            });
          try {
            // Use the pinned original process and computer, including a continuation's
            // original run id. Lease expiry alone is not evidence that native work ended.
            await sandbox.cancelRunWork(
              toComputerRef(computer),
              computer.id,
              source.nativeExecutionRunId,
              {
                operationId: `recover:${source.id}`,
                traceId: `recover:${source.id}`,
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: source.botId,
                runId: source.id,
                requireRunCleanup: true,
                cancelRunWork: true,
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch {
            throw new ORPCError("CONFLICT", {
              message:
                "The previous native execution could not be stopped. Try again when its host is available.",
            });
          }
        }
        const sourceConversation = await tx.task.findFirst({
          where: { threadId: source.threadId, conversation: true },
          select: { writeSubdirectory: true },
        });
        return createInTransaction(tx, actor, {
          botId: input.botId,
          text: input.text ?? source.task.prompt,
          prompt: recoveryPrompt({
            ...input,
            botId: source.botId,
            status: stopped.status,
            prompt: source.task.prompt,
          }),
          clientNonce: nonce,
          originThreadId: source.threadId,
          recoveryOfRunId: source.id,
          ...(input.botId === source.botId && sourceConversation?.writeSubdirectory
            ? { writeSubdirectory: sourceConversation.writeSubdirectory } : {}),
        });
      })();
      await onRecovered?.(tx, result.task);
      return result;
    },
    { timeout: 25_000, maxWait: 5_000 },
  );
}

export async function startQueuedConversationTask(
  prisma: PrismaClient,
  actor: Actor,
  target: QueueTarget,
  input: { id: string; revision: number; clientNonce: string },
) {
  return prisma.$transaction(async (tx) => {
    const nonce = `queued-task:${input.clientNonce}`;
    await lockReceipt(tx, actor, nonce);
    const existing = await replay(tx, actor, nonce, target.botId);
    if (existing) {
      const receipt = await tx.task.findUniqueOrThrow({
        where: { id: existing.id },
        select: { sourceQueuedInputId: true },
      });
      if (receipt.sourceQueuedInputId !== input.id || existing.originThreadId !== target.threadId)
        throw conflict();
      return { task: existing, eventSeq: null, originEventSeq: null, continuationRunId: null };
    }
    await lockQueueGroup(tx, actor, target);
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const current = await queueState(tx, actor, target);
    if (input.revision !== current.snapshot.revision) throw conflict();
    const entry = current.rows.find((row) => row.id === input.id);
    const view = current.snapshot.entries.find((row) => row.id === input.id);
    if (!entry || !view) throw conflict();
    const continuationRunId = await cancelQueuedEntry(tx, actor, target, entry);
    const result = await createInTransaction(tx, actor, {
      botId: target.botId,
      text: view.text,
      clientNonce: nonce,
      originThreadId: target.threadId,
      sourceQueuedInputId: entry.id,
    });
    const queueEvent = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.queue.updated",
      payload: {},
    });
    return { ...result, originEventSeq: queueEvent.seq, continuationRunId };
  });
}
