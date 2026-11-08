import { createHash } from "node:crypto";
import * as z from "zod";

const id = z.string().trim().min(1).max(500);
const note = z.string().trim().min(1).max(1200);
export const opportunityPublicationInput = z
  .object({
    assetSetKey: id,
    assetSetVersionId: id,
    opportunityId: id,
    metricSignalIds: z.array(id).min(1).max(12),
    summary: note,
    risk: note,
    counterargument: note,
    invalidation: note,
    cursor: z.string().min(1).max(2000).optional(),
    minimumGrade: z.literal("C-").optional(),
  })
  .strict();

type Transport = {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
};
const contextSchema = z.object({
  generatedAtMs: z.number().int().nonnegative(),
  inputManifest: z.object({
    portfolioSnapshotId: id.nullable(),
    assetSetVersionIds: z.array(id),
    preferenceProfile: z.object({ key: id, version: z.number().int().nonnegative() }),
    sourceSyncs: z.array(z.object({ sourceKey: id, syncId: id.nullable(), status: id })),
  }),
});
const detailSchema = z.object({
  opportunity: z.object({ id, positionId: id, status: id }),
  currentRecommendation: z
    .object({
      id,
      positionId: id,
      opportunityId: id,
      analysisRunId: id.nullable(),
      payload: z.object({ metadata: z.object({ researchAssetSetKey: id.optional() }).optional() }),
    })
    .nullable(),
  candidateContext: z.object({
    metricSignals: z.array(
      z.object({
        id,
        sourceItemId: id.nullable(),
        positionId: id.nullable(),
        metricKey: id,
        observedAtMs: z.number().int().nonnegative(),
      }),
    ),
  }),
});
const pageSchema = z.object({
  criteria: z.object({
    assetSetKey: id,
    assetSetVersionId: id,
    activeAssetSetVersionIds: z.array(id),
  }),
  items: z.array(
    z.object({
      opportunityId: id,
      positionId: id,
      sourceKey: id,
      evidenceIds: z.object({ metricSignalIds: z.array(id) }),
    }),
  ),
  page: z.object({ total: z.number().int().nonnegative() }),
});

function existingLead(detail: z.infer<typeof detailSchema>) {
  const existing = detail.currentRecommendation;
  if (!existing) return null;
  if (
    existing.positionId !== detail.opportunity.positionId ||
    existing.opportunityId !== detail.opportunity.id
  )
    throw new Error("The current recommendation has a conflicting candidate identity.");
  return {
    status: "existing" as const,
    opportunityId: existing.opportunityId,
    recommendationId: existing.id,
  };
}

// Publish only an investigative lead on an exactly eligible candidate. The server owns the
// target, action, citations, provenance and deduplication key. Portfolio comparisons stay in chat.
export async function publishOpportunityLead(
  args: z.input<typeof opportunityPublicationInput>,
  transport: Transport,
) {
  const input = opportunityPublicationInput.parse(args);
  const detailPath = `/intelligence/opportunities/${encodeURIComponent(input.opportunityId)}`;
  const detailRead = async () => {
    const detail = detailSchema.parse(await transport.get(detailPath));
    if (detail.opportunity.id !== input.opportunityId)
      throw new Error("Opportunity identity changed.");
    return detail;
  };
  const detail = await detailRead();
  const prior = existingLead(detail);
  if (["stale", "archived"].includes(detail.opportunity.status))
    throw new Error("This opportunity is stale or archived.");
  const context = contextSchema.parse(await transport.get("/intelligence/context/latest"));
  const manifest = context.inputManifest;
  const query = new URLSearchParams({
    assetSetKey: input.assetSetKey,
    minimumTvlUsd: "1000000",
    exposureScope: "single_set",
    evmOnly: "true",
    sort: "apy",
    direction: "desc",
    limit: "100",
  });
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.minimumGrade) query.set("minimumGrade", input.minimumGrade);
  const page = pageSchema.parse(await transport.get(`/intelligence/screening?${query}`));
  const candidate = page.items.find((row) => row.opportunityId === input.opportunityId);
  if (
    !candidate ||
    candidate.positionId !== detail.opportunity.positionId ||
    page.criteria.assetSetKey !== input.assetSetKey ||
    page.criteria.assetSetVersionId !== input.assetSetVersionId ||
    !manifest.assetSetVersionIds.includes(input.assetSetVersionId) ||
    JSON.stringify([...manifest.assetSetVersionIds].sort()) !==
      JSON.stringify([...page.criteria.activeAssetSetVersionIds].sort())
  )
    throw new Error(
      "Reread the candidate in its current eligible Asset Set screen before publishing.",
    );
  const source = manifest.sourceSyncs.find((sync) => sync.sourceKey === candidate.sourceKey);
  if (source?.status !== "succeeded" || !source.syncId)
    throw new Error("A successful latest sync is required to publish a new lead from this source.");
  const signals = [...new Set(input.metricSignalIds)].sort().map((signalId) => {
    const signal = detail.candidateContext.metricSignals.find((s) => s.id === signalId);
    if (
      !candidate.evidenceIds.metricSignalIds.includes(signalId) ||
      !signal?.sourceItemId ||
      signal.positionId !== candidate.positionId ||
      signal.observedAtMs > context.generatedAtMs
    )
      throw new Error("Cited evidence is missing, superseded, or belongs to another opportunity.");
    return { ...signal, sourceItemId: signal.sourceItemId };
  });
  // A review may cite older comparison data, but at least one selected metric must cover the weekly review window.
  const recentSinceMs = context.generatedAtMs - 7 * 24 * 60 * 60 * 1000;
  if (!signals.some((s) => s.observedAtMs >= recentSinceMs))
    throw new Error(
      "All cited observations are older than seven days. Discuss this as a dated lead.",
    );
  const sourceItemIds = [...new Set(signals.map((s) => s.sourceItemId))];
  const citations = signals.map((s) => ({
    key: s.id,
    sourceItemId: s.sourceItemId,
    locator: { metricKey: s.metricKey, metricSignalId: s.id, observedAtMs: s.observedAtMs },
  }));
  const publicationKey =
    "ragazzo-lead-" +
    createHash("sha256")
      .update(
        JSON.stringify([input.opportunityId, input.assetSetVersionId, signals.map((s) => s.id)]),
      )
      .digest("hex");
  const previous = detail.currentRecommendation;
  if (prior && previous?.analysisRunId === publicationKey) return prior;
  if (
    prior &&
    (!previous?.analysisRunId?.startsWith("ragazzo-lead-") ||
      previous.payload.metadata?.researchAssetSetKey !== input.assetSetKey)
  )
    return {
      ...prior,
      status: "separate_review" as const,
      message:
        "This case already has a different review. Discuss the new evidence in chat and identify that prior review separately.",
    };
  const qualification = {
    unknowns: ["Protocol diligence and net economics require independent verification."],
    counterarguments: [input.counterargument],
    invalidationConditions: [input.invalidation],
  };
  const economics = {
    status: "unknown",
    depositFeeFraction: null,
    withdrawalFeeFraction: null,
    fixedEntryCostUsd: null,
    fixedExitCostUsd: null,
    netAnnualYieldFraction: null,
    assumedCapitalUsd: null,
    breakEvenDays: null,
    minimumCapitalUsd: null,
    targetHoldingDays: null,
    methodology: "Unverified candidate research lead",
    missingInputs: [
      "deposit_fee",
      "withdrawal_fee",
      "entry_gas",
      "exit_gas",
      "entry_slippage",
      "exit_slippage",
      "management_fee",
      "performance_fee",
      "reward_conversion",
      "reward_dump_slippage",
    ],
  };
  const body = {
    ...(prior ? { supersedesRecommendationIds: [prior.recommendationId] } : {}),
    publicationKey,
    candidatePositionId: candidate.positionId,
    kind: "opportunity-research-lead",
    producer: { key: "ragazzo-fc-opportunities", version: "1" },
    generatedAtMs: context.generatedAtMs,
    methodology: { key: "single-set-candidate-review", version: 1 },
    preferenceProfile: manifest.preferenceProfile,
    inputManifest: {
      contextAsOfMs: context.generatedAtMs,
      portfolioSnapshotId: manifest.portfolioSnapshotId,
      assetSetVersionIds: manifest.assetSetVersionIds,
      sourceItemIds,
      metricSignalIds: signals.map((s) => s.id),
      claimIds: [],
    },
    summary: input.summary,
    citations,
    ...qualification,
    metadata: {
      sourceSyncId: source.syncId,
      assetSetVersionId: input.assetSetVersionId,
      verifiedScreen: query.toString(),
      filteredTotal: page.page.total,
      scope: "individual_candidate",
    },
    recommendations: [
      {
        candidatePositionId: candidate.positionId,
        action: "investigate",
        status: "current",
        summary: input.summary,
        thesis: input.summary,
        citationKeys: citations.map((c) => c.key),
        risks: [input.risk],
        metadata: { researchAssetSetKey: input.assetSetKey },
        expectedImpact: { nature: "research_only", economics },
        ...qualification,
      },
    ],
  };
  // The FC run key is unique. Reconcile an uncertain response or a concurrent winner by readback.
  let publishedId: string | undefined;
  try {
    const saved = z
      .object({ recommendations: z.array(z.object({ id, positionId: id })).length(1) })
      .parse(await transport.post("/intelligence/reports", body));
    if (saved.recommendations[0]?.positionId === candidate.positionId)
      publishedId = saved.recommendations[0].id;
  } catch {
    // A timeout can occur after the transaction commits.
  }
  const reread = await detailRead();
  const current = existingLead(reread);
  if (!current || reread.currentRecommendation?.analysisRunId !== publicationKey)
    throw new Error("Publication could not be verified. Reread the opportunity before retrying.");
  return {
    ...current,
    status:
      publishedId === current.recommendationId ? ("published" as const) : ("existing" as const),
  };
}
