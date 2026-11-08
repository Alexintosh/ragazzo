import type { Actor, FarmingControlRisk, FarmingControlRiskExposure } from "@rakazo/contracts";
import {
  FarmingControlEntitySelectionSchema,
  FarmingControlIntelligenceInputSchema,
  FarmingControlPortfolioInputSchema,
  FarmingControlPositionHistoryInputSchema,
  FarmingControlRecommendationFeedbackInputSchema,
  FarmingControlRiskReviewInputSchema,
  FarmingControlRiskSchema,
  FarmingControlSourceRefreshInputSchema,
  MessageBlock,
} from "@rakazo/contracts";
import { farmingControlOutsideBlocks } from "@rakazo/core";
import * as z from "zod";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FarmingControlPrivateConsultation } from "./farming-control-consultation.js";
import { verifyFarmingControlPrivateConsultation } from "./farming-control-consultation.js";
import { FarmingControlOpportunityTriggerSchema } from "./farming-control-opportunity-automation.js";
import { opportunityPublicationInput } from "./farming-control-opportunity-publication.js";
import { positionHistoryForModel } from "./farming-control-position-history-model.js";
import type { FarmingControlRiskTrigger } from "./farming-control-risk-automation.js";
import { FarmingControlRiskTriggerSchema } from "./farming-control-risk-automation.js";
import {
  compactFarmingControlRiskResearch,
  compactFarmingControlRiskReview,
} from "./farming-control-risk-review-model.js";
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

const findInput = z
  .object({
    query: z
      .string()
      .trim()
      .max(500)
      .transform((query) => query.replace(/^@/u, "").trim())
      .pipe(z.string().min(1)),
  })
  .strict();
const riskInput = z
  .object({
    exposureId: z.string().trim().min(1).max(200).optional(),
    signalKey: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((input) => !input.signalKey || Boolean(input.exposureId), {
    message: "signalKey requires exposureId",
  });
const riskReviewToolInput = FarmingControlRiskReviewInputSchema.extend({
  inventoryOffset: z.number().int().min(0).max(1_000).optional(),
});
const DENIED = "This capability is not granted to this Farming Control specialist.";

/** Defense in depth: profile edits, hidden calls, and connector aliases cannot expand the grant. */
export function farmingControlToolDenied(
  bot: { id: string; spaceId: string; spawnKey?: string | null },
  name: string,
  args: Record<string, unknown>,
  groupId: string | null,
): boolean {
  if (name === "farming_control_source_refresh") {
    const role = farmingControlRole(bot);
    return (
      groupId !== null ||
      (role !== "coordinator" && role !== "opportunities") ||
      !FarmingControlSourceRefreshInputSchema.safeParse(args).success
    );
  }
  if (
    name === "farming_control_intelligence" ||
    name === "farming_control_recommendation_feedback" ||
    name === "farming_control_opportunity_publish"
  ) {
    const role = farmingControlRole(bot);
    if (
      role !== "opportunities" &&
      !(role === "coordinator" && name === "farming_control_intelligence")
    )
      return true;
    return !(
      name === "farming_control_intelligence"
        ? FarmingControlIntelligenceInputSchema
        : name === "farming_control_recommendation_feedback"
          ? FarmingControlRecommendationFeedbackInputSchema
          : opportunityPublicationInput
    ).safeParse(args).success;
  }
  if (name === "farming_control_risk_research") {
    const role = farmingControlRole(bot);
    return (
      !role || !FARMING_CONTROL_GRANTS[role].includes("risk") || Object.keys(args).length !== 0
    );
  }
  if (name === "farming_control_risk_review") {
    const role = farmingControlRole(bot);
    return (
      !role ||
      !FARMING_CONTROL_GRANTS[role].includes("risk") ||
      !riskReviewToolInput.safeParse(args).success
    );
  }
  if (name === "farming_control_position_history") {
    const role = farmingControlRole(bot);
    return (
      !role ||
      !FARMING_CONTROL_GRANTS[role].includes("portfolio") ||
      !FarmingControlPositionHistoryInputSchema.safeParse(args).success
    );
  }
  if (name === "farming_control_find") {
    const role = farmingControlRole(bot);
    return (
      !role ||
      !FARMING_CONTROL_GRANTS[role].includes("portfolio") ||
      !findInput.safeParse(args).success
    );
  }
  if (name === "farming_control_entity") {
    const role = farmingControlRole(bot);
    const parsed = FarmingControlEntitySelectionSchema.safeParse(args);
    return (
      !role ||
      !parsed.success ||
      !FARMING_CONTROL_GRANTS[role].includes(parsed.data.kind === "risk" ? "risk" : "portfolio")
    );
  }
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
  if (name === "message_bot") {
    return (
      role !== "coordinator" ||
      groupId !== null ||
      args.bot_id !== farmingControlBotId(bot.spaceId, "opportunities") ||
      typeof args.message !== "string" ||
      !args.message.trim() ||
      (args.intent !== undefined && args.intent !== "request" && args.intent !== "question") ||
      Object.keys(args).some(
        (key) => !["bot_id", "confirm_name", "message", "intent"].includes(key),
      )
    );
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

/** Format only a previously authorized, wallet-scoped risk read; never fetches data. */
export function scopedFarmingControlRiskRead(
  risk: FarmingControlRisk,
  exposureId: string,
  signalKey?: string,
) {
  const exposure = risk.exposures.find((card) => card.id === exposureId);
  const matching = exposure?.signals.filter((signal) => signal.key === signalKey) ?? [];
  // The card selection can outlive a no-reading placeholder. A successful reread
  // must deliver the new observations rather than an empty, misleading signal list.
  const placeholderSuperseded =
    signalKey === "no_current_reading" &&
    matching.length === 0 &&
    exposure?.dataStatus === "live" &&
    exposure.observedAtMs !== null;
  const signals = exposure
    ? signalKey && !placeholderSuperseded
      ? matching
      : exposure.signals
    : [];
  const severityRank = { info: 0, warning: 1, critical: 2 };
  const maxSeverity = signals.reduce<FarmingControlRiskExposure["maxSeverity"]>(
    (max, signal) =>
      signal.severity !== null &&
      (max === null || severityRank[signal.severity] > severityRank[max])
        ? signal.severity
        : max,
    null,
  );
  // Canonical selector namespaces identify only the protocol source to report.
  // They establish neither a monitor's existence nor any wallet/position binding.
  const sourceKey = exposure
    ? exposure.protocol === "Curve pool"
      ? "curve"
      : "morpho"
    : exposureId.startsWith("morpho.market.") || exposureId.startsWith("morpho.vault.")
      ? "morpho"
      : exposureId.startsWith("curve.pool.")
        ? "curve"
        : null;
  const source = sourceKey ? risk.sourceAvailability[sourceKey] : null;
  const discoveryUnavailable =
    risk.exposureScope.discovery === "unavailable" || source?.state === "unavailable";
  const discoveryPartial = risk.exposureScope.discovery === "partial" || source?.truncated;
  const selectionStatus = !exposure
    ? discoveryUnavailable
      ? "discovery_unavailable"
      : discoveryPartial
        ? "discovery_partial"
        : "exposure_missing"
    : placeholderSuperseded
      ? "placeholder_superseded"
      : signalKey && matching.length === 0
        ? "signal_missing"
        : "matched";
  return {
    exposureId,
    ...(signalKey ? { signalKey } : {}),
    selectionStatus,
    exposure: exposure ? { ...exposure, signals, maxSeverity } : null,
    // Preserve corroborating or competing assessments for this exact exposure.
    supportingSignals:
      exposure && signalKey && !placeholderSuperseded
        ? exposure.signals.filter((signal) => signal.key !== signalKey)
        : [],
    // Discovery describes lookup completeness, not this subject's safety. Do
    // not mix portfolio counts or unrelated alert infrastructure into a reply.
    exposureScope: {
      discovery: risk.exposureScope.discovery,
      walletVisibilityRevision: risk.exposureScope.walletVisibilityRevision,
    },
    fetchedAtMs: risk.fetchedAtMs,
    sourceAvailability: source
      ? {
          source: sourceKey,
          state: source.state,
          asOfMs: source.asOfMs,
          truncated: source.truncated,
        }
      : null,
    monitors: exposure
      ? risk.monitors.filter((monitor) => monitor.monitorKey === exposure.monitorKey)
      : [],
    issues: !exposure
      ? [
          discoveryUnavailable
            ? source?.state === "unavailable"
              ? "The selected protocol source is unavailable. This read cannot establish whether the selected exposure or monitor exists or belongs to visible holdings."
              : "Exposure discovery or its wallet scope could not be verified. This read cannot establish whether the selected exposure or monitor exists."
            : discoveryPartial
              ? "The selected exposure was not returned by incomplete discovery. This does not establish that the position closed or its monitor was removed."
              : "The selected exposure was not returned among visible active holdings. This does not establish that its monitor was removed.",
        ]
      : signalKey && matching.length === 0 && !placeholderSuperseded
        ? [
            "The exposure was found, but the selected signal was not returned. The exposure and its monitor are not missing on that basis.",
          ]
        : [],
  };
}

export const farmingControlIntelligenceTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.intelligence) return { error: "Intelligence is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowOpportunityAutomation: true,
    });
    return await ctx.deps.farmingControl.intelligence(
      actor,
      FarmingControlIntelligenceInputSchema.parse(call.args),
    );
  } catch {
    return { error: "Intelligence evidence is unavailable or this run is not authorized." };
  }
};
export const farmingControlSourceRefreshTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.refreshSources)
    return call.finish({ error: "Source refresh is not configured." });
  try {
    const input = FarmingControlSourceRefreshInputSchema.parse(call.args);
    let ownerText = "";
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      requireDirectOwnerTurn: true,
      onOwnerMessage: (blocks) => {
        ownerText = MessageBlock.array()
          .parse(blocks)
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("\n");
      },
    });
    if (ownerText.trim() !== input.operatorQuote)
      return call.finish({
        error:
          "Refresh requires the entire current owner message as operatorQuote, preserving its requested scope and exclusions.",
      });
    return call.finish(await ctx.deps.farmingControl.refreshSources(actor, input));
  } catch {
    return call.finish({
      error:
        "Source refresh is unavailable or not authorized. No successful refresh is confirmed; reread sources and refresh_status before any new request.",
    });
  }
};

export const farmingControlOpportunityPublishTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.opportunityPublish)
    return { error: "Research publication is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowOpportunityAutomation: true,
    });
    return await ctx.deps.farmingControl.opportunityPublish(
      actor,
      opportunityPublicationInput.parse(call.args),
    );
  } catch {
    return {
      error:
        "The research lead could not be published or this run is not authorized. Read the exact opportunity before retrying.",
    };
  }
};
export const farmingControlRecommendationFeedbackTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.recommendationFeedback)
    return { error: "Recommendation feedback is not configured." };
  try {
    const input = FarmingControlRecommendationFeedbackInputSchema.parse(call.args);
    let ownerText = "";
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      requireDirectOwnerTurn: true,
      onOwnerMessage: (blocks) => {
        const parsed = MessageBlock.array().parse(blocks);
        ownerText = parsed
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("\n");
      },
    });
    if (!ownerText.includes(input.operatorQuote))
      return {
        error: "Feedback requires an exact quote from the current operator's explicit judgment.",
      };
    return await ctx.deps.farmingControl.recommendationFeedback(
      actor,
      input,
      ctx.run.sourceMessageId ?? ctx.run.retryOfRunId ?? ctx.run.id,
    );
  } catch {
    return {
      error:
        "Feedback was not confirmed. Read the exact recommendation before retrying; only an explicit operator judgment can authorize feedback.",
    };
  }
};

export const farmingControlRiskResearchTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.riskResearch) return { error: "Risk research is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowRiskAutomation: true,
      automationKind: "weekly_review",
    });
    return compactFarmingControlRiskResearch(await ctx.deps.farmingControl.riskResearch(actor));
  } catch {
    return { error: "Official-source research is unavailable or this run is not authorized." };
  }
};

export const farmingControlRiskReviewTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.riskReview) return { error: "Farming Control is not configured." };
  try {
    let automation: FarmingControlRiskTrigger | undefined;
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowRiskAutomation: true,
      allowOpportunityAutomation: true,
      onRiskAutomation: (proof) => {
        automation = proof;
      },
    });
    const { inventoryOffset, ...input } = riskReviewToolInput.parse(call.args);
    if (automation?.kind === "emergency") {
      if (
        !automation.monitorKey ||
        (input.monitorKey && input.monitorKey !== automation.monitorKey)
      )
        return { error: DENIED };
      input.monitorKey = automation.monitorKey;
    }
    if (automation?.kind === "material_trend") {
      const keys = automation.subjects?.map((subject) => subject.monitorKey) ?? [];
      if (!input.monitorKey && keys.length === 1) input.monitorKey = keys[0];
      if (!input.monitorKey || !keys.includes(input.monitorKey)) return { error: DENIED };
    }
    return compactFarmingControlRiskReview(
      await ctx.deps.farmingControl.riskReview(actor, input),
      inventoryOffset === undefined ? {} : { inventoryOffset },
    );
  } catch {
    return {
      error:
        "Monitoring review evidence is unavailable or this run is no longer authorized. No fresh evidence was returned.",
    };
  }
};

export const farmingControlFindTool: ToolHandler = async (ctx, call) => {
  const bridge = ctx.deps.farmingControl;
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!bridge?.mentionTargets) return { error: "Farming Control is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowOpportunityAutomation: true,
    });
    const { query } = findInput.parse(call.args);
    const catalog = await bridge.mentionTargets(actor, {
      query,
      kinds: [
        "position",
        "wallet",
        "protocol",
        ...(FARMING_CONTROL_GRANTS[farmingControlRole(ctx.bot)!].includes("risk")
          ? ["risk" as const]
          : []),
      ],
      limit: 11,
    });
    return {
      state: catalog.state,
      fetchedAtMs: catalog.fetchedAtMs,
      issues: catalog.issues,
      moreMatches: catalog.entities.length > 10,
      matches: catalog.entities.slice(0, 10).map(({ selection, label, detail }) => ({
        ...selection,
        label,
        detail,
      })),
    };
  } catch {
    return { error: "Farming Control search is unavailable for this run." };
  }
};

export const farmingControlPositionHistoryTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  const bridge = ctx.deps.farmingControl;
  if (!bridge?.positionHistory) return { error: "Farming Control is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowOpportunityAutomation: true,
    });
    const evidence = await bridge.positionHistory(
      actor,
      FarmingControlPositionHistoryInputSchema.parse(call.args),
    );
    return positionHistoryForModel(evidence);
  } catch {
    return { error: "Historical position evidence could not be read for this run." };
  }
};

export const farmingControlEntityTool: ToolHandler = async (ctx, call) => {
  if (farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl?.entity) return { error: "Farming Control is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowOpportunityAutomation: true,
    });
    return await ctx.deps.farmingControl.entity(
      actor,
      FarmingControlEntitySelectionSchema.parse(call.args),
      { includeRisk: FARMING_CONTROL_GRANTS[farmingControlRole(ctx.bot)!].includes("risk") },
    );
  } catch {
    return {
      error:
        "The selected Farming Control subject is unavailable or this run is no longer authorized. No fresh evidence was returned.",
    };
  }
};

export const farmingControlReadTool: ToolHandler = async (ctx, call) => {
  const section = FARMING_CONTROL_TOOL_SECTIONS.get(call.name);
  if (!section || farmingControlToolDenied(ctx.bot, call.name, call.args, ctx.thread.groupId))
    return { error: DENIED };
  if (!ctx.deps.farmingControl) return { error: "Farming Control is not configured." };
  try {
    const actor = await authorizeFarmingControlRun(ctx.deps, ctx.run, ctx.bot, {
      allowPrivateConsultation: true,
      requireConsultationRequest: true,
      allowOpportunityAutomation: true,
    });
    if (section === "risk") {
      const { exposureId, signalKey } = riskInput.parse(call.args);
      const result = await ctx.deps.farmingControl.read(actor, section);
      if (!exposureId) return result;
      // Match only against evidence returned by the current authorized, wallet-scoped read.
      const risk = FarmingControlRiskSchema.parse(result);
      return scopedFarmingControlRiskRead(risk, exposureId, signalKey);
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
  deps: Pick<
    ExecutorDeps,
    | "prisma"
    | "farmingControl"
    | "farmingControlRiskAutomationEnabled"
    | "farmingControlOpportunitiesEnabled"
  >,
  run: { id: string; botId: string; userId: string; spaceId: string; threadId: string },
  expectedBot?: { id: string; spaceId: string; userId: string; spawnKey?: string | null },
  options: {
    allowPrivateConsultation?: boolean;
    requireConsultationRequest?: boolean;
    onPrivateConsultation?: (proof: FarmingControlPrivateConsultation) => void;
    allowRiskAutomation?: boolean;
    allowOpportunityAutomation?: boolean;
    requireDirectOwnerTurn?: boolean;
    onOwnerMessage?: (blocks: unknown) => void;
    automationKind?: FarmingControlRiskTrigger["kind"];
    onRiskAutomation?: (proof: FarmingControlRiskTrigger) => void;
  } = {},
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
        clientNonce: true,
        retryOfRunId: true,
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
      depth === 0 &&
      current?.trigger === "bot_message" &&
      options.allowPrivateConsultation &&
      !options.requireDirectOwnerTurn
    ) {
      const proof = await verifyFarmingControlPrivateConsultation(deps.prisma, run);
      if (
        options.requireConsultationRequest &&
        proof.intent !== "request" &&
        proof.intent !== "question"
      )
        throw new Error(DENIED);
      if (
        expectedBot &&
        (expectedBot.id !== current.bot.id ||
          expectedBot.userId !== current.bot.userId ||
          expectedBot.spaceId !== current.bot.spaceId ||
          farmingControlRole(expectedBot) !== farmingControlRole(current.bot))
      )
        throw new Error(DENIED);
      options.onPrivateConsultation?.(proof);
      ownerTurn = true;
      break;
    }
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
      (current.trigger !== "user" &&
        current.trigger !== "follow_up" &&
        !(
          depth === 0 &&
          current.trigger === "routine" &&
          ((options.allowRiskAutomation &&
            deps.farmingControlRiskAutomationEnabled &&
            farmingControlRole(current.bot) === "risk") ||
            (options.allowOpportunityAutomation &&
              deps.farmingControlOpportunitiesEnabled &&
              farmingControlRole(current.bot) === "opportunities")) &&
          !current.thread.groupId
        ))
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
    if (current.trigger === "routine") {
      if (current.sourceMessage) throw new Error(DENIED);
      const steering = await deps.prisma.steeringMessage.findFirst({
        where: { runId: current.id },
        select: { id: true },
      });
      if (steering) throw new Error(DENIED);
      if (farmingControlRole(current.bot) === "opportunities") {
        const event = await deps.prisma.event.findFirst({
          where: {
            runId: current.id,
            spaceId: run.spaceId,
            threadId: current.thread.id,
            botId: current.bot.id,
            type: "routine.fired",
            payload: {
              path: ["farmingControlOpportunityTrigger", "schemaVersion"],
              equals: "fc-opportunity-trigger.v1",
            },
          },
          select: { payload: true },
        });
        const proof = FarmingControlOpportunityTriggerSchema.safeParse(
          (event?.payload as { farmingControlOpportunityTrigger?: unknown } | null)
            ?.farmingControlOpportunityTrigger,
        );
        if (
          !proof.success ||
          current.clientNonce !==
            `fc-opportunity:v1:${proof.data.kind}:${proof.data.eventId}${current.retryOfRunId ? `:retry:${current.retryOfRunId}` : ""}`
        )
          throw new Error(DENIED);
        ownerTurn = true;
        break;
      }
      const event = await deps.prisma.event.findFirst({
        where: {
          runId: current.id,
          spaceId: run.spaceId,
          threadId: current.thread.id,
          botId: current.bot.id,
          type: "routine.fired",
          payload: {
            path: ["farmingControlRiskTrigger", "schemaVersion"],
            equals: "fc-risk-trigger.v1",
          },
        },
        select: { payload: true },
      });
      const proof = FarmingControlRiskTriggerSchema.safeParse(
        (event?.payload as { farmingControlRiskTrigger?: unknown } | null)
          ?.farmingControlRiskTrigger,
      );
      if (
        !proof.success ||
        current.clientNonce !==
          `fc-risk:v1:${proof.data.kind}:${proof.data.eventId}${current.retryOfRunId ? `:retry:${current.retryOfRunId}` : ""}` ||
        (proof.data.kind === "emergency" &&
          (!proof.data.event ||
            proof.data.event.monitorKey !== proof.data.monitorKey ||
            proof.data.event.eventId !== proof.data.eventId))
      )
        throw new Error(DENIED);
      if (options.automationKind && options.automationKind !== proof.data.kind)
        throw new Error(DENIED);
      options.onRiskAutomation?.(proof.data);
      ownerTurn = true;
      break;
    }
    const source = current.sourceMessage;
    if (
      !source ||
      source.threadId !== current.thread.id ||
      farmingControlOutsideBlocks(source.blocks)
    )
      throw new Error(DENIED);
    if (source.role === "user") {
      if (options.requireDirectOwnerTurn && (depth !== 0 || current.thread.groupId !== null))
        throw new Error(DENIED);
      options.onOwnerMessage?.(source.blocks);
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
