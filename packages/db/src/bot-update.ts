import { displayName } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { BotExecutionSettingsError } from "./bot-execution.js";
import { writeBotInstructions } from "./bot-instructions.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

type AppendEvent = typeof appendEventInTransaction;

/**
 * Persist a bot row. When profile labels or instructions change, write `bot.updated`
 * in the same transaction so clients can refresh after every successful write.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Omit<Prisma.BotUncheckedUpdateInput, "instructions"> & { instructions?: string };
    emitBotUpdated: boolean;
    expectedInstructions?: string;
    expectedRuntimeKind?: string;
    expectedModel?: {
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    };
    instructionRestore?: { versionId: string; undo?: boolean };
    reason?: string;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  if (typeof options.data.name === "string") {
    options = {
      ...options,
      data: { ...options.data, name: displayName(options.data.name, "") },
    };
  }
  if (
    !options.emitBotUpdated &&
    options.data.roleplayCharacter === undefined &&
    options.data.instructions === undefined &&
    !options.instructionRestore
  ) {
    return options.prisma.bot.update({
      where: {
        id: options.botId,
        ...options.expectedModel,
        ...(options.expectedRuntimeKind ? { runtimeKind: options.expectedRuntimeKind } : {}),
      },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  const { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(async (tx) => {
    // Event appends also lock the thread; all writers take it before the bot row.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR UPDATE`;
    if (data.roleplayCharacter !== undefined) {
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${options.botId} FOR UPDATE`;
      const bot = await tx.bot.findUniqueOrThrow({
        where: { id: options.botId },
        select: { botKind: true },
      });
      if (bot.botKind !== "roleplay")
        throw new BotExecutionSettingsError("Characters require a roleplay bot");
      const active = await tx.run.findFirst({
        where: {
          botId: options.botId,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
        select: { id: true },
      });
      if (active)
        throw new BotExecutionSettingsError("Stop the roleplay bot before replacing its character");
    }
    if (typeof instructions === "string" || options.instructionRestore) {
      await writeBotInstructions(tx, {
        botId: options.botId,
        instructions,
        reason: options.instructionRestore ? "Restore" : (options.reason ?? "Manual edit"),
        expectedInstructions: options.expectedInstructions,
        ...options.instructionRestore,
      });
    }
    const updated = await tx.bot.update({
      where: {
        id: options.botId,
        ...options.expectedModel,
        ...(options.expectedRuntimeKind ? { runtimeKind: options.expectedRuntimeKind } : {}),
      },
      data,
      select: { id: true, name: true, title: true, description: true },
    });
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        title: updated.title,
        description: updated.description,
      },
    });
    return { updated, seq: event.seq };
  });

  await options.notify(options.threadId, committed.seq).catch((error) => {
    getLogger().error("bot.updated realtime notification", error);
  });
  return committed.updated;
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  color?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.color !== undefined
  );
}
