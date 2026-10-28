import type { Actor, ThinkingLevel } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { BotExecutionSettingsError } from "./bot-execution.js";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Fence configuration discovery against placement changes and queued/running turns. */
export async function setBotRuntimeModel(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; modelId: string | null; thinkingLevel: ThinkingLevel | null },
  expected: {
    runtimeKind: string;
    runtimeGeneration: number;
    registeredHostId: string | null;
    projectPath: string | null;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockSpaceForContentCreation(tx, actor);
      const thread = await tx.thread.findFirst({
        where: { botId: input.botId, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true },
      });
      if (!thread) throw new IsolationError();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      });
      if (!bot) throw new IsolationError();
      if (
        bot.runtimeKind !== "codex" ||
        bot.executionTarget !== "host" ||
        bot.runtimeKind !== expected.runtimeKind ||
        bot.runtimeGeneration !== expected.runtimeGeneration ||
        bot.registeredHostId !== expected.registeredHostId ||
        bot.projectPath !== expected.projectPath
      )
        throw new BotExecutionSettingsError("Execution settings changed. Try again");
      if (
        bot.registeredHostId &&
        !(await tx.registeredHost.findFirst({
          where: {
            id: bot.registeredHostId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            revokedAt: null,
          },
          select: { id: true },
        }))
      )
        throw new BotExecutionSettingsError("Registered host is unavailable");
      if (
        await tx.run.findFirst({
          where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
          select: { id: true },
        })
      )
        throw new BotExecutionSettingsError("Stop the bot before changing its model");
      await tx.bot.update({
        where: { id: bot.id },
        data: {
          modelProvider: input.modelId ? "codex-native" : null,
          modelId: input.modelId,
          thinkingLevel: input.thinkingLevel,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "bot.updated",
        payload: { botId: bot.id, name: bot.name, title: bot.title, description: bot.description },
      });
      return { threadId: thread.id, seq: event.seq };
    }),
  );
}
