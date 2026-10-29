import { createHash } from "node:crypto";
import { RoleplayCharacterSchema } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  evaluateRoleplaySpontaneousEligibility,
  roleplayStoryState,
} from "@rakazo/core";
import type { Prisma } from "./client.js";
import { runAsSystem, runAsSystemInTransaction } from "./row-security.js";

export const ROLEPLAY_SPONTANEOUS_TRIGGER = "roleplay_spontaneous";
export interface RoleplaySpontaneousGuard {
  historyGeneration: number;
  nextMessageSeq: number;
  character: string;
  timezone: string;
  sourceMessageId: string;
  botUpdatedAt: string;
  userUpdatedAt: string;
}
type Reader = Pick<
  Prisma.TransactionClient,
  "bot" | "thread" | "user" | "run" | "message" | "$queryRaw"
>;

export function parseRoleplaySpontaneousGuard(text: string): RoleplaySpontaneousGuard | null {
  try {
    const value = JSON.parse(text);
    return value &&
      Number.isInteger(value.historyGeneration) &&
      Number.isInteger(value.nextMessageSeq) &&
      typeof value.character === "string" &&
      typeof value.timezone === "string" &&
      typeof value.sourceMessageId === "string" &&
      typeof value.botUpdatedAt === "string" &&
      typeof value.userUpdatedAt === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/** All transcript reads use the run owner's tenant and explicit ownership filters. */
export async function roleplaySpontaneousSnapshot(
  db: Reader,
  identity: { userId: string; spaceId: string; botId: string; threadId: string },
  now = new Date(),
  ignoreRunId?: string,
  inTransaction = false,
) {
  const { userId, spaceId, botId, threadId } = identity;
  const [bot, thread, user] = await Promise.all([
    db.bot.findFirst({
      where: { id: botId, userId, spaceId, archivedAt: null, conversationEngine: "internal" },
      select: { roleplayCharacter: true, botKind: true, updatedAt: true },
    }),
    db.thread.findFirst({
      where: { id: threadId, userId, spaceId, groupId: null, externalConversationId: null },
      select: {
        botId: true,
        taskBotId: true,
        historyCompactionGeneration: true,
        nextMessageSeq: true,
        roleplayState: true,
      },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { timezone: true, nativeSetupDisabledAt: true, updatedAt: true },
    }),
  ]);
  const character = RoleplayCharacterSchema.safeParse(bot?.roleplayCharacter);
  if (
    bot?.botKind !== "roleplay" ||
    !thread ||
    (thread.botId ?? thread.taskBotId) !== botId ||
    !user?.timezone ||
    user.nativeSetupDisabledAt ||
    !character.success ||
    character.data.conversationStyle !== "chat" ||
    !character.data.spontaneous?.enabled
  )
    return null;
  const readAttempts = () =>
    db.run.findMany({
      where: {
        userId,
        trigger: ROLEPLAY_SPONTANEOUS_TRIGGER,
        OR: [
          { createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
          { startedAt: { gte: new Date(now.getTime() - 86_400_000) } },
          { firstResponseAt: { gte: new Date(now.getTime() - 86_400_000) } },
        ],
        ...(ignoreRunId ? { id: { not: ignoreRunId } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        threadId: true,
        createdAt: true,
        status: true,
        firstResponseAt: true,
        startedAt: true,
      },
    });
  // Only rate metadata crosses Spaces; never read another Space's transcript or character.
  const attempts = inTransaction
    ? await runAsSystemInTransaction(
        db,
        "read owner-wide roleplay initiative rate metadata",
        readAttempts,
      )
    : await runAsSystem("read owner-wide roleplay initiative rate metadata", readAttempts);
  const [busy, lastUser, lastMessage, userCount, exchanges] = await Promise.all([
    db.run.findFirst({
      where: {
        threadId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        ...(ignoreRunId ? { id: { not: ignoreRunId } } : {}),
      },
      select: { id: true },
    }),
    db.message.findFirst({
      where: { threadId, role: "user" },
      orderBy: { seq: "desc" },
      select: { id: true, seq: true, createdAt: true },
    }),
    db.message.findFirst({
      where: { threadId },
      orderBy: { seq: "desc" },
      select: { createdAt: true },
    }),
    db.message.count({ where: { threadId, role: "user" } }),
    db.message.findMany({
      where: { threadId, OR: [{ role: "user" }, { role: "bot", botId, runId: { not: null } }] },
      orderBy: { seq: "desc" },
      take: 100,
      select: { role: true },
    }),
  ]);
  if (busy || !lastUser) return null;
  const recentRuns = attempts;
  // A proactive turn remains unanswered even after the rolling rate window passes.
  const proactiveAfterUser = await db.run.findFirst({
    where: {
      threadId,
      trigger: ROLEPLAY_SPONTANEOUS_TRIGGER,
      createdAt: { gte: lastUser.createdAt },
      ...(ignoreRunId ? { id: { not: ignoreRunId } } : {}),
      status: "completed",
      firstResponseAt: { not: null },
    },
    select: { id: true },
  });
  const reciprocalReplies = exchanges.reduce(
    (count, message, index) =>
      count + (message.role === "user" && exchanges[index + 1]?.role === "bot" ? 1 : 0),
    0,
  );
  const state = roleplayStoryState(thread.roleplayState, {
    threadId,
    botId,
    historyGeneration: thread.historyCompactionGeneration,
  });
  const eligibility = evaluateRoleplaySpontaneousEligibility({
    character: character.data,
    now: now.toISOString(),
    timezone: user.timezone,
    lastUserMessageAt: lastUser.createdAt.toISOString(),
    lastInteractionAt: lastMessage?.createdAt.toISOString(),
    realUserMessageCount: userCount,
    reciprocalUserReplyCount: reciprocalReplies,
    unansweredSpontaneousCount: proactiveAfterUser ? 1 : 0,
    spontaneousSentAt: recentRuns
      .filter((run) => run.status === "completed" && run.firstResponseAt)
      .map((run) => run.firstResponseAt!.toISOString()),
    attemptedAt: recentRuns.map((run) => (run.startedAt ?? run.createdAt).toISOString()),
    warmth: state.continuity?.relationshipState?.warmth,
  });
  if (!eligibility.eligible) return null;
  return {
    character: character.data,
    lastInteractionAt: lastMessage?.createdAt.toISOString(),
    guard: {
      historyGeneration: thread.historyCompactionGeneration,
      nextMessageSeq: thread.nextMessageSeq,
      character: createHash("sha256").update(JSON.stringify(character.data)).digest("hex"),
      timezone: user.timezone,
      sourceMessageId: lastUser.id,
      botUpdatedAt: bot.updatedAt.toISOString(),
      userUpdatedAt: user.updatedAt.toISOString(),
    } satisfies RoleplaySpontaneousGuard,
  };
}

export function sameRoleplaySpontaneousGuard(
  a: RoleplaySpontaneousGuard,
  b: RoleplaySpontaneousGuard,
): boolean {
  return (
    a.historyGeneration === b.historyGeneration &&
    a.nextMessageSeq === b.nextMessageSeq &&
    a.character === b.character &&
    a.timezone === b.timezone &&
    a.sourceMessageId === b.sourceMessageId &&
    a.botUpdatedAt === b.botUpdatedAt &&
    a.userUpdatedAt === b.userUpdatedAt
  );
}

export async function lockRoleplaySpontaneousPreferences(
  tx: Prisma.TransactionClient,
  identity: { botId: string; userId: string },
): Promise<void> {
  // The thread lock precedes these locks everywhere this helper is used. Updates and deletes
  // of preferences cannot commit between their final read and the message insert.
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${identity.botId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${identity.userId} FOR UPDATE`;
}
