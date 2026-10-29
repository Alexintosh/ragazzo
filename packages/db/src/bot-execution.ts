import { isAbsolute } from "node:path";
import type { Actor, SetBotExecutionInput } from "@rakazo/contracts";
import { RuntimeKindSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class BotExecutionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotExecutionSettingsError";
  }
}

/** Validate implemented combinations without silently broadening a runtime's permissions. */
export function validateBotExecution(
  input: SetBotExecutionInput,
  botKind: "agent" | "roleplay" = "agent",
): void {
  if (
    botKind === "roleplay" &&
    (input.runtimeKind !== "pi" ||
      input.executionTarget !== "docker" ||
      input.runtimePermission !== "workspace" ||
      input.projectPath != null ||
      input.registeredHostId != null)
  )
    throw new BotExecutionSettingsError("Roleplay bots require the internal runtime in Docker");
  if (!RuntimeKindSchema.safeParse(input.runtimeKind).success)
    throw new BotExecutionSettingsError("Unsupported agent runtime");
  if (input.registeredHostId && input.executionTarget !== "host")
    throw new BotExecutionSettingsError("Registered hosts require host execution");
  if (input.runtimeKind !== "pi") {
    if (input.executionTarget !== "host") {
      throw new BotExecutionSettingsError("Codex requires a host computer");
    }
    if (input.runtimeKind !== "codex" && input.runtimePermission !== "full")
      throw new BotExecutionSettingsError("This runtime requires explicit full host access");
    if (!input.projectPath || !isAbsolute(input.projectPath) || input.projectPath.includes("\0")) {
      throw new BotExecutionSettingsError("Choose an absolute host project path");
    }
  } else if (input.runtimePermission !== "workspace" || input.projectPath !== null) {
    throw new BotExecutionSettingsError("Pi uses its computer workspace and tool permissions");
  }
}

/**
 * Settings and placement commit together. Keep every old computer and its files: choosing a
 * target selects a distinct dedicated computer, never converts a shared Team Computer.
 * Lock the thread before the bot, matching message/event writers; the bot lock also fences
 * new run foreign-key inserts until the new configuration is committed.
 */
export async function setBotExecution(
  prisma: PrismaClient,
  actor: Actor,
  input: SetBotExecutionInput,
): Promise<{ threadId: string; seq: number }> {
  validateBotExecution(input);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await tx.thread.findFirst({
        where: { botId: input.botId, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true },
      });
      if (!thread) throw new IsolationError();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        include: { computer: true },
      });
      if (bot?.conversationEngine === "eros")
        throw new BotExecutionSettingsError("Eros manages its execution environment");
      if (!bot?.computer) throw new IsolationError();
      validateBotExecution(input, bot.botKind === "roleplay" ? "roleplay" : "agent");
      const active = await tx.run.findFirst({
        where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (active)
        throw new BotExecutionSettingsError("Stop the bot before changing execution settings");
      await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
      const current = await tx.computer.findUniqueOrThrow({ where: { id: bot.computerId! } });
      const lease = await tx.computerExecutionLease.findFirst({
        where: { computerId: current.id, botId: bot.id, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (
        bot.computerSwitching ||
        current.maintenanceId ||
        lease ||
        ["booting", "suspending"].includes(current.state) ||
        (current.controlBotId === bot.id &&
          current.controlLeaseId &&
          (!current.controlLeaseExpiresAt || current.controlLeaseExpiresAt > new Date()))
      )
        throw new BotExecutionSettingsError(
          "Release the computer before changing execution settings",
        );

      if (input.registeredHostId) {
        const host = await tx.registeredHost.findFirst({
          where: {
            id: input.registeredHostId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            revokedAt: null,
          },
        });
        if (!host) throw new BotExecutionSettingsError("Registered host is unavailable");
      }
      const targetChanged =
        input.executionTarget !== (bot.executionTarget ?? "default") ||
        (input.registeredHostId ?? null) !== (bot.registeredHostId ?? null);
      const runtimeChanged =
        input.runtimeKind !== (bot.runtimeKind ?? "pi") ||
        targetChanged ||
        input.projectPath !== (bot.projectPath ?? null) ||
        input.runtimePermission !== (bot.runtimePermission ?? "workspace");
      let computerId = bot.computerId!;
      if (targetChanged) {
        // Stopping/checkpointing remains an explicit computer operation. Never switch a live disk.
        if (current.scope === "dedicated" && current.state === "running") {
          throw new BotExecutionSettingsError(
            "Stop the computer before changing its execution target",
          );
        }
        const target = input.executionTarget;
        const deployment =
          target === "default"
            ? await tx.deploymentSettings.findUnique({ where: { id: "default" } })
            : null;
        const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
        const defaultKind =
          envKind === "docker" && deployment?.computerHost === "this-mac" ? "desktop" : envKind;
        const computer = await ensureComputerRecord(tx, {
          mode: target === "default" ? "team" : "dedicated",
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          kind: target === "host" ? "desktop" : target === "docker" ? "docker" : defaultKind,
          executionTarget: target,
          registeredHostId: input.registeredHostId,
        });
        computerId = computer.id;
      }
      await tx.bot.update({
        where: { id: bot.id },
        data: {
          runtimeKind: input.runtimeKind,
          executionTarget: input.executionTarget,
          registeredHostId: input.registeredHostId ?? null,
          runtimePermission: input.runtimePermission,
          projectPath: input.projectPath,
          ...(input.runtimeKind !== (bot.runtimeKind ?? "pi")
            ? { modelProvider: null, modelId: null, thinkingLevel: null }
            : {}),
          ...(runtimeChanged ? { runtimeGeneration: { increment: 1 } } : {}),
          computerId,
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
