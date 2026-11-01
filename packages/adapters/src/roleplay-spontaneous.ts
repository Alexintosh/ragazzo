import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  isRoleplayEnabled,
  lockRoleplaySpontaneousPreferences,
  ROLEPLAY_SPONTANEOUS_TRIGGER,
  roleplaySpontaneousSnapshot,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";

/** A bounded round-robin over owners, then bots. The elected job reconciler owns this cursor. */
export function createRoleplaySpontaneousReconciler(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  options: { batchSize?: number; now?: () => Date } = {},
) {
  let ownerCursor: string | undefined;
  const botCursors = new Map<string, string>();
  return async () => {
    const batchSize = options.batchSize ?? 20;
    const owners = await runAsSystem("discover roleplay initiative owners", () =>
      deps.prisma.user.findMany({
        where: {
          roleplayEnabled: true,
          nativeSetupDisabledAt: null,
          ...(ownerCursor ? { id: { gt: ownerCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: { id: true },
      }),
    );
    ownerCursor = owners.length === batchSize ? owners.at(-1)!.id : undefined;
    for (const { id: userId } of owners) {
      const cursor = botCursors.get(userId);
      const bots = await runAsSystem("discover roleplay initiative owner bots", () =>
        deps.prisma.bot.findMany({
          where: {
            userId,
            botKind: "roleplay",
            archivedAt: null,
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: "asc" },
          take: 5,
          select: { id: true, userId: true, spaceId: true, thread: { select: { id: true } } },
        }),
      );
      if (bots.length === 5) botCursors.set(userId, bots.at(-1)!.id);
      else botCursors.delete(userId);
      for (const bot of bots) {
        if (!bot.thread) continue;
        const identity = { userId, spaceId: bot.spaceId, botId: bot.id, threadId: bot.thread.id };
        const run = await runAsTenant(identity, () =>
          deps.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${identity.threadId} FOR UPDATE`;
            await lockRoleplaySpontaneousPreferences(tx, identity);
            if (!(await isRoleplayEnabled(tx, userId))) return null;
            const now = options.now?.() ?? new Date();
            const snapshot = await roleplaySpontaneousSnapshot(tx, identity, now, undefined, true);
            if (!snapshot) return null;
            // A stable attempt bucket plus the user's real message prevents double scheduling.
            const nonce = `rp-spontaneous:${identity.threadId}:${snapshot.guard.historyGeneration}:${snapshot.guard.sourceMessageId}:${Math.floor(now.getTime() / 3_600_000)}`;
            const existing = await tx.task.findUnique({
              where: { spaceId_clientNonce: { spaceId: identity.spaceId, clientNonce: nonce } },
              select: { id: true },
            });
            if (existing) return null;
            const task = await tx.task.create({
              data: {
                ...identity,
                clientNonce: nonce,
                prompt: JSON.stringify(snapshot.guard),
                status: "queued",
              },
            });
            return tx.run.create({
              data: {
                ...identity,
                taskId: task.id,
                clientNonce: nonce,
                sourceMessageId: snapshot.guard.sourceMessageId,
                trigger: ROLEPLAY_SPONTANEOUS_TRIGGER,
                status: "queued",
              },
            });
          }),
        );
        if (run) {
          await deps.jobs.enqueue(runContinueJob(run.id));
          break;
        }
      }
    }
    // Owners removed from the product must not leave an unbounded cursor cache.
    if (!ownerCursor && botCursors.size > 10_000) botCursors.clear();
  };
}
