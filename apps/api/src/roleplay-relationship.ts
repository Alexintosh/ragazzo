import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  Actor,
  RoleplayCharacter,
  RoleplayRelationship,
  RoleplayRelationshipDebug,
} from "@rakazo/contracts";
import {
  RoleplayContinuitySchema,
  RoleplayRelationshipSchema,
  TimeZoneSchema,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, roleplayRelationshipState, roleplayStoryState } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { IsolationError, isRoleplayEnabled } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type Story = {
  id: string;
  roleplayState: unknown;
  historyCompactionGeneration: number;
  nextMessageSeq: number;
};

export async function assertRoleplaySpontaneousTimezone(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  character: RoleplayCharacter | null | undefined,
): Promise<void> {
  if (character?.conversationStyle !== "chat" || !character.spontaneous?.enabled) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { timezone: true },
  });
  if (!TimeZoneSchema.safeParse(owner?.timezone).success)
    throw new ORPCError("BAD_REQUEST", {
      message: "Set your time zone in settings before enabling spontaneous messages.",
    });
}

function snapshot(thread: Story, botId: string): RoleplayRelationshipDebug {
  const state = roleplayStoryState(thread.roleplayState, {
    threadId: thread.id,
    botId,
    historyGeneration: thread.historyCompactionGeneration,
  });
  return {
    relationship: roleplayRelationshipState(state.continuity?.relationshipState),
    historyGeneration: thread.historyCompactionGeneration,
    revision: createHash("sha256")
      .update(
        JSON.stringify([
          thread.roleplayState,
          thread.historyCompactionGeneration,
          thread.nextMessageSeq,
        ]),
      )
      .digest("hex"),
  };
}

export async function loadRoleplayRelationship(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  botId: string,
): Promise<RoleplayRelationshipDebug> {
  if (!(await isRoleplayEnabled(deps.prisma, actor.userId)))
    throw new ORPCError("FORBIDDEN", { message: "Roleplay is not enabled" });
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { thread: true },
  });
  if (!bot) throw new IsolationError();
  if (
    bot.botKind !== "roleplay" ||
    !bot.thread ||
    bot.thread.groupId ||
    bot.thread.externalConversationId ||
    bot.thread.spaceId !== actor.spaceId ||
    bot.thread.userId !== actor.userId
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "Relationship state requires a direct roleplay conversation",
    });
  return snapshot(bot.thread, bot.id);
}

export async function updateRoleplayRelationship(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  input: {
    botId: string;
    relationship: RoleplayRelationship;
    historyGeneration: number;
    expectedRevision: string;
  },
): Promise<RoleplayRelationshipDebug> {
  if (!(await isRoleplayEnabled(deps.prisma, actor.userId)))
    throw new ORPCError("FORBIDDEN", { message: "Roleplay is not enabled" });
  const relationship = RoleplayRelationshipSchema.parse(input.relationship);
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new IsolationError();
  return deps.prisma.$transaction(
    async (tx) => {
      // Same lock order as conversation finalization and spontaneous delivery.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread!.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
      const current = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        include: { thread: true },
      });
      if (!current) throw new IsolationError();
      const thread = current.thread;
      if (
        current.botKind !== "roleplay" ||
        !thread ||
        thread.id !== bot.thread!.id ||
        thread.groupId ||
        thread.externalConversationId ||
        thread.spaceId !== actor.spaceId ||
        thread.userId !== actor.userId
      )
        throw new ORPCError("BAD_REQUEST", {
          message: "Relationship state requires a direct roleplay conversation",
        });
      const before = snapshot(thread, current.id);
      if (
        before.historyGeneration !== input.historyGeneration ||
        before.revision !== input.expectedRevision
      )
        throw new ORPCError("CONFLICT", {
          message: "The conversation changed. Reload relationship state before saving.",
        });
      const active = await tx.run.findFirst({
        where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (active)
        throw new ORPCError("CONFLICT", {
          message: "Wait for the current reply before changing relationship state.",
        });
      const state = roleplayStoryState(thread.roleplayState, {
        threadId: thread.id,
        botId: current.id,
        historyGeneration: thread.historyCompactionGeneration,
      });
      const continuity = RoleplayContinuitySchema.safeParse({
        scene: "",
        relationship: "",
        sharedDetails: [],
        openThreads: [],
        callbacks: [],
        ...state.continuity,
        relationshipState: relationship,
      });
      if (!continuity.success)
        throw new ORPCError("BAD_REQUEST", { message: "Story memory exceeds the memory limit" });
      state.continuity = continuity.data;
      const updated = await tx.thread.update({
        where: { id: thread.id },
        data: { roleplayState: state as unknown as Prisma.InputJsonValue },
      });
      return snapshot(updated, current.id);
    },
    { maxWait: 5_000, timeout: 20_000 },
  );
}
