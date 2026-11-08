import { describe, expect, it, vi } from "vitest";
import { publishOpportunityLead } from "./farming-control-opportunity-publication.js";

const input = {
  assetSetKey: "test-set",
  assetSetVersionId: "set-v1",
  opportunityId: "case-1",
  metricSignalIds: ["rate-1"],
  summary: "Investigate the variable rate.",
  risk: "Exit depth is unverified.",
  counterargument: "Rewards may expire.",
  invalidation: "The incentive schedule ends.",
};
function fixture() {
  const metric = {
    id: "rate-1",
    sourceItemId: "item-1",
    positionId: "candidate-1",
    metricKey: "yield.apy",
    observedAtMs: 950_000_000,
  };
  const recommendation = {
    id: "rec-1",
    positionId: "candidate-1",
    opportunityId: input.opportunityId,
    analysisRunId: "",
    payload: { metadata: { researchAssetSetKey: input.assetSetKey } },
  };
  const detail = {
    opportunity: { id: input.opportunityId, positionId: "candidate-1", status: "discovered" },
    currentRecommendation: null as typeof recommendation | null,
    candidateContext: { metricSignals: [metric] },
  };
  const page = {
    criteria: {
      assetSetKey: input.assetSetKey,
      assetSetVersionId: "set-v1",
      activeAssetSetVersionIds: ["set-v1"],
    },
    items: [
      {
        opportunityId: input.opportunityId,
        positionId: "candidate-1",
        sourceKey: "source",
        evidenceIds: { metricSignalIds: ["rate-1"] },
      },
    ],
    page: { total: 6 },
  };
  const context = {
    generatedAtMs: 1_000_000_000,
    portfolio: { privateLabel: "other-wallet" },
    inputManifest: {
      portfolioSnapshotId: null,
      assetSetVersionIds: ["set-v1"],
      preferenceProfile: { key: "pref", version: 0 },
      sourceSyncs: [{ sourceKey: "source", syncId: "sync-1", status: "succeeded" }],
    },
  };
  const transport = {
    async get(path: string) {
      if (path === "/intelligence/opportunities/case-1") return detail;
      if (path.startsWith("/intelligence/screening?")) return page;
      if (path === "/intelligence/context/latest") return context;
      throw new Error("Unexpected read");
    },
    post: vi.fn(async (path: string, _body: unknown) => {
      expect(path).toBe("/intelligence/reports");
      recommendation.analysisRunId = (_body as { publicationKey: string }).publicationKey;
      detail.currentRecommendation = recommendation;
      return { recommendations: [recommendation] };
    }),
  };
  return { transport, detail, page, context, metric, recommendation };
}
describe("opportunity research publication", () => {
  it("binds the report to screened evidence, verifies the ID and reuses the current recommendation", async () => {
    const { transport } = fixture();
    await expect(publishOpportunityLead(input, transport)).resolves.toMatchObject({
      status: "published",
      recommendationId: "rec-1",
    });
    const payload = transport.post.mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      inputManifest: { sourceItemIds: ["item-1"], metricSignalIds: ["rate-1"] },
      recommendations: [
        { action: "investigate", expectedImpact: { economics: { netAnnualYieldFraction: null } } },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("other-wallet");
    await expect(publishOpportunityLead(input, transport)).resolves.toMatchObject({
      status: "existing",
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
  it("recovers the exact current recommendation after an ambiguous POST", async () => {
    const f = fixture();
    f.transport.post.mockImplementationOnce(async (_path, body) => {
      f.recommendation.analysisRunId = (body as { publicationKey: string }).publicationKey;
      f.detail.currentRecommendation = f.recommendation;
      throw new Error("lost response");
    });
    await expect(publishOpportunityLead(input, f.transport)).resolves.toMatchObject({
      recommendationId: "rec-1",
    });
    expect(f.transport.post).toHaveBeenCalledTimes(1);
  });
  it("refreshes its own earlier review with new evidence, preserving other authors' reviews", async () => {
    const f = fixture();
    f.detail.currentRecommendation = { ...f.recommendation, analysisRunId: "another-researcher" };
    expect((await publishOpportunityLead(input, f.transport)).status).toBe("separate_review");
    expect(f.transport.post).not.toHaveBeenCalled();
    f.detail.currentRecommendation = {
      ...f.recommendation,
      analysisRunId: "ragazzo-lead-previous",
    };
    expect((await publishOpportunityLead(input, f.transport)).status).toBe("published");
    expect(f.transport.post.mock.calls[0]?.[1]).toMatchObject({
      supersedesRecommendationIds: ["rec-1"],
    });
  });
  it.each([
    "wrong set",
    "wrong position",
    "old metrics",
    "failed latest sync",
    "missing source item",
  ])("withholds publication for %s", async (kind) => {
    const f = fixture();
    if (kind === "wrong set") f.page.criteria.assetSetVersionId = "other";
    if (kind === "wrong position") f.metric.positionId = "other";
    if (kind === "old metrics") f.metric.observedAtMs = 1;
    if (kind === "failed latest sync") f.context.inputManifest.sourceSyncs[0]!.status = "failed";
    if (kind === "missing source item") f.metric.sourceItemId = "";
    await expect(publishOpportunityLead(input, f.transport)).rejects.toThrow();
    expect(f.transport.post).not.toHaveBeenCalled();
  });
});
