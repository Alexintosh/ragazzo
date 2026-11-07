import type { Actor } from "@rakazo/contracts";
import {
  FarmingControlPortfolioInputSchema,
  FarmingControlRiskSchema,
  MessageBlock,
} from "@rakazo/contracts";
import { farmingControlOutsideBlocks } from "@rakazo/core";
import * as z from "zod";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  FARMING_CONTROL_GRANTS,
  FARMING_CONTROL_ROLES,
  FARMING_CONTROL_SAFE_TOOLS,
  FARMING_CONTROL_TOOL_SECTIONS,
  farmingControlBotId,
  farmingControlGroupId,
  farmingControlRole,
  isFarmingControlSpecialist,
} from "./farming-control-team-policy.js";
import type { ToolHandler } from "./run-tool-gate.js";

const riskInput = z.object({ exposureId: z.string().trim().min(1).max(200).optional() }).strict();
const DENIED = "This capability is not granted to this Farming Control specialist.";

/** Defense in depth: profile edits, hidden calls, and connector aliases cannot expand the grant. */
export function farmingControlToolDenied(
  bot: { id: string; spaceId: string; spawnKey?: string | null },
  name: string,
  args: Record<string, unknown>,
  groupId: string | null,
): boolean {
  const section = FARMING_CONTROL_TOOL_SECTIONS.get(name);
  const role = farmingControlRole(bot);
  if (!isFarmingControlSpecialist(bot)) return Boolean(section);
  if (!role) return true;
  if (section) {
    if (!FARMING_CONTROL_GRANTS[role].includes(section)) return true;
    if (section === "portfolio") return !FarmingControlPortfolioInputSchema.safeParse(args).success;
    if (section === "risk") return !riskInput.safeParse(args).success;
    return Object.keys(args).length !== 0;
  }
  if (!FARMING_CONTROL_SAFE_TOOLS.has(name)) return true;
  if (name !== "handoff_to_bot") return false;
  const targetGroup = args.group_id ?? groupId;
  return (
    groupId !== farmingControlGroupId(bot.spaceId) ||
    targetGroup !== farmingControlGroupId(bot.spaceId) ||
    typeof args.bot_id !== "string" ||
    !FARMING_CONTROL_ROLES.some(
      (target) => args.bot_id === farmingControlBotId(bot.spaceId, target),
    )
  );
}

export const farmingControlReadTool: ToolHandler = async (ctx, call) => {
  const section = FARMING_CONTROL_TOOL_SECTIONS.get(call.name);
  if (!section || farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl) return { error: "Farming Control is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot);
    if (section === "risk") {
      const { exposureId } = riskInput.parse(call.args);
      const result = await ctx.deps.farmingControl.read(actor, section);
      if (!exposureId) return result;
      // Match only against evidence returned by the current authorized, wallet-scoped read.
      const risk = FarmingControlRiskSchema.parse(result);
      return {
        exposureId,
        exposure: risk.exposures.find((card) => card.id === exposureId) ?? null,
        exposureScope: risk.exposureScope,
        fetchedAtMs: risk.fetchedAtMs,
        sources: risk.sources,
        issues: risk.issues,
      };
    }
    return section === "portfolio"
      ? await ctx.deps.farmingControl.read(
          actor,
          section,
          FarmingControlPortfolioInputSchema.parse(call.args),
        )
      : await ctx.deps.farmingControl.read(actor, section);
  } catch {
    // Source and auth errors must not leak deployment URLs, account identifiers, or credentials.
    return {
      error:
        "The Farming Control read is unavailable or this run is no longer authorized. No fresh evidence was returned.",
    };
  }
};

/**
 * A private read needs a surviving owner-authored app turn. A group handoff keeps
 * its parent run on the source message; follow that chain rather than trusting
 * a bot-owned run's userId as evidence of who requested the work.
 */
export async function authorizeFarmingControlRun(
  deps: Pick<ExecutorDeps, "prisma" | "farmingControl">,
  run: { id: string; botId: string; userId: string; spaceId: string; threadId: string },
  expectedBot?: { id: string; spaceId: string; userId: string; spawnKey?: string | null },
): Promise<Actor> {
  if (!deps.farmingControl) throw new Error(DENIED);
  let nextRunId = run.id;
  let expectedBotId = run.botId;
  const visited = new Set<string>();
  let ownerTurn = false;
  for (let depth = 0; depth < 8; depth++) {
    if (visited.has(nextRunId)) throw new Error(DENIED);
    visited.add(nextRunId);
    const current = await deps.prisma.run.findFirst({
      where: {
        id: nextRunId,
        botId: expectedBotId,
        userId: run.userId,
        spaceId: run.spaceId,
        threadId: run.threadId,
        ...(depth === 0 ? { status: "running" } : {}),
      },
      select: {
        id: true,
        trigger: true,
        bot: {
          select: { id: true, spaceId: true, userId: true, spawnKey: true, archivedAt: true },
        },
        thread: {
          select: {
            id: true,
            userId: true,
            spaceId: true,
            botId: true,
            groupId: true,
            externalConversationId: true,
          },
        },
        sourceMessage: {
          select: { role: true, threadId: true, botId: true, runId: true, blocks: true },
        },
      },
    });
    if (
      !current ||
      current.bot.archivedAt ||
      !farmingControlRole(current.bot) ||
      current.bot.userId !== run.userId ||
      current.bot.spaceId !== run.spaceId ||
      current.thread.userId !== run.userId ||
      current.thread.spaceId !== run.spaceId ||
      current.thread.externalConversationId ||
      (current.thread.groupId
        ? current.thread.groupId !== farmingControlGroupId(run.spaceId)
        : current.thread.botId !== current.bot.id) ||
      (current.trigger !== "user" && current.trigger !== "follow_up")
    )
      throw new Error(DENIED);
    if (
      depth === 0 &&
      expectedBot &&
      (expectedBot.id !== current.bot.id ||
        expectedBot.userId !== current.bot.userId ||
        expectedBot.spaceId !== current.bot.spaceId ||
        farmingControlRole(expectedBot) !== farmingControlRole(current.bot))
    )
      throw new Error(DENIED);
    const outsideSteering = await deps.prisma.steeringMessage.findFirst({
      where: {
        runId: current.id,
        OR: [
          { originTrigger: { not: null } },
          { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          { message: { blocks: { array_contains: [{ kind: "bot_message_received" }] } } },
        ],
      },
      select: { id: true },
    });
    if (outsideSteering) throw new Error(DENIED);
    const source = current.sourceMessage;
    if (
      !source ||
      source.threadId !== current.thread.id ||
      farmingControlOutsideBlocks(source.blocks)
    )
      throw new Error(DENIED);
    if (source.role === "user") {
      ownerTurn = true;
      break;
    }
    if (
      current.trigger !== "follow_up" ||
      source.role !== "bot" ||
      !source.runId ||
      !source.botId ||
      current.thread.groupId !== farmingControlGroupId(run.spaceId)
    )
      throw new Error(DENIED);
    const parsed = MessageBlock.array().safeParse(source.blocks);
    const handoff = parsed.success
      ? parsed.data.find((block) => block.kind === "handoff")
      : undefined;
    if (
      handoff?.kind !== "handoff" ||
      handoff.fromBotId !== source.botId ||
      handoff.toBotId !== current.bot.id
    )
      throw new Error(DENIED);
    nextRunId = source.runId;
    expectedBotId = source.botId;
  }
  if (!ownerTurn) throw new Error(DENIED);
  const user = await deps.prisma.user.findUnique({
    where: { id: run.userId },
    select: { email: true },
  });
  if (!user) throw new Error(DENIED);
  const actor = {
    userId: run.userId,
    spaceId: run.spaceId,
    email: user.email,
    isDeploymentOwner: false,
  };
  await deps.farmingControl.authorize(actor);
  return actor;
}
