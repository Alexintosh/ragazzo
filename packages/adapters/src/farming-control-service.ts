import type {
  Actor,
  FarmingControlEntityCatalogInput,
  FarmingControlEntitySelection,
  FarmingControlIntelligenceInput,
  FarmingControlPortfolioInput,
  FarmingControlPositionDetailInput,
  FarmingControlPositionHistoryInput,
  FarmingControlRecommendationFeedbackInput,
  FarmingControlRiskReviewInput,
  FarmingControlRiskReview,
  FarmingControlSection,
  FarmingControlSourceRefreshInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { createFarmingControlClient } from "./farming-control.js";
import type { RiskInterpretationDb } from "./farming-control-risk-interpretation.js";
import { readFarmingControlRiskInterpretations } from "./farming-control-risk-interpretation.js";
import { createFarmingControlIntelligence } from "./farming-control-intelligence.js";

export class FarmingControlAccessError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FORBIDDEN",
    message = "Farming Control is unavailable in this workspace.",
  ) {
    super(message);
    this.name = "FarmingControlAccessError";
  }
}

export interface FarmingControlConfiguration {
  farmingControlApiUrl?: string;
  farmingControlOwnerUserId?: string;
}

/** The host dataset belongs to one immutable account, in its unshared personal workspace. */
export function createFarmingControlService(
  prisma: Pick<PrismaClient, "space"> & Partial<RiskInterpretationDb>,
  config: FarmingControlConfiguration,
  transport?: typeof fetch,
) {
  const ownerId = config.farmingControlOwnerUserId?.trim();
  const client = config.farmingControlApiUrl
    ? createFarmingControlClient({ baseUrl: config.farmingControlApiUrl, fetch: transport })
    : null;
  const intelligence = config.farmingControlApiUrl
    ? createFarmingControlIntelligence({ baseUrl: config.farmingControlApiUrl, fetch: transport })
    : null;
  async function authorize(actor: Actor): Promise<void> {
    if (!ownerId) throw new FarmingControlAccessError("NOT_FOUND");
    if (actor.userId !== ownerId) throw new FarmingControlAccessError("FORBIDDEN");
    // Inspect all memberships rather than tenant-filtered rows: adding a peer revokes this view.
    const space = await runAsSystem("authorize configured Farming Control personal workspace", () =>
      prisma.space.findFirst({
        where: {
          id: actor.spaceId,
          isDefault: true,
          createdByUserId: ownerId,
          organization: { slug: `user-${ownerId.slice(0, 12)}` },
        },
        select: {
          id: true,
          organizationId: true,
          deletingAt: true,
          memberships: { select: { userId: true, role: true } },
          organization: { select: { members: { select: { userId: true, role: true } } } },
        },
      }),
    );
    if (
      !space ||
      space.id !== space.organizationId ||
      space.deletingAt ||
      space.memberships.length !== 1 ||
      space.memberships[0]?.userId !== ownerId ||
      space.memberships[0]?.role !== "owner" ||
      space.organization.members.length !== 1 ||
      space.organization.members[0]?.userId !== ownerId ||
      space.organization.members[0]?.role !== "owner"
    ) {
      throw new FarmingControlAccessError(
        "FORBIDDEN",
        "Farming Control is available only in the configured owner's private personal workspace.",
      );
    }
  }
  return {
    configured: client !== null,
    authorize,
    async status(actor: Actor) {
      await authorize(actor);
      return client
        ? client.status()
        : {
            configured: false,
            readOnly: true as const,
            connection: "not_configured" as const,
            fetchedAtMs: Date.now(),
          };
    },
    async intelligence(actor: Actor, input: FarmingControlIntelligenceInput) {
      await authorize(actor);
      if (!intelligence) throw new FarmingControlAccessError("NOT_FOUND");
      return intelligence.read(input);
    },
    async refreshSources(actor: Actor, input: FarmingControlSourceRefreshInput) {
      await authorize(actor);
      if (!intelligence) throw new FarmingControlAccessError("NOT_FOUND");
      return intelligence.refreshSources(input);
    },
    async recommendationFeedback(
      actor: Actor,
      input: FarmingControlRecommendationFeedbackInput,
      requestKey: string,
    ) {
      await authorize(actor);
      if (!intelligence) throw new FarmingControlAccessError("NOT_FOUND");
      return intelligence.feedback(input, requestKey);
    },
    async refreshOpportunitySources(actor: Actor, scheduledAtMs: number) {
      await authorize(actor);
      if (!intelligence) throw new FarmingControlAccessError("NOT_FOUND");
      return intelligence.refresh(scheduledAtMs);
    },
    async opportunityPublish(actor: Actor, input: unknown) {
      await authorize(actor);
      if (!intelligence) throw new FarmingControlAccessError("NOT_FOUND");
      return intelligence.publish(input);
    },
    async read(actor: Actor, section: FarmingControlSection, input?: FarmingControlPortfolioInput) {
      await authorize(actor);
      if (!client)
        throw new FarmingControlAccessError("NOT_FOUND", "Farming Control is not configured.");
      if (section === "intelligence") return intelligence!.read({ action: "sources" });
      return client.read(section, input);
    },
    async mentionTargets(actor: Actor, input?: FarmingControlEntityCatalogInput) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.mentionTargets(input);
    },
    async positionDetail(actor: Actor, input: FarmingControlPositionDetailInput) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.positionDetail(input);
    },
    async positionHistory(actor: Actor, input: FarmingControlPositionHistoryInput) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.positionHistory(input);
    },
    async entity(
      actor: Actor,
      selection: FarmingControlEntitySelection,
      options?: { includeRisk?: boolean },
    ) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.entity(selection, options);
    },
    async portfolio(actor: Actor, input?: FarmingControlPortfolioInput) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.portfolio(input);
    },
    async harvest(actor: Actor) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.harvest();
    },
    async riskResearch(actor: Actor) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.riskResearch();
    },
    async riskReview(actor: Actor, input?: FarmingControlRiskReviewInput) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      const review: FarmingControlRiskReview = await client.riskReview(input);
      if (input?.monitorKey && review.selectionStatus === "matched" && review.evidence) {
        review.interpretations = prisma.bot && prisma.run && prisma.event
          ? await readFarmingControlRiskInterpretations(prisma as RiskInterpretationDb, actor,
            input.monitorKey, review.evidence.requestedFromMs, review.evidence.asOfMs)
          : { state: "unavailable", asOfMs: Date.now(), truncated: false, runs: [],
            limitations: ["Risk run metadata is unavailable in this service composition."] };
        review.sources.push("ragazzo:scoped-risk-runs");
        if (review.interpretations.state === "unavailable" || review.interpretations.truncated)
          review.state = "partial";
      }
      return review;
    },
    async risk(actor: Actor) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.risk();
    },
    async accounting(actor: Actor) {
      await authorize(actor);
      if (!client) throw new FarmingControlAccessError("NOT_FOUND");
      return client.accounting();
    },
  };
}
export type FarmingControlService = ReturnType<typeof createFarmingControlService>;
