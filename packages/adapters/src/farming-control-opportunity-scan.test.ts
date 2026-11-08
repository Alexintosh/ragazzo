import { FarmingControlIntelligenceInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { publishOpportunityLead } from "./farming-control-opportunity-publication.js";
import { scanOpportunityPopulation } from "./farming-control-opportunity-scan.js";

const now = 1_000_000_000;
const criteria = {
  assetSetKey: "USD",
  assetSetVersionId: "v-exact",
  activeAssetSetVersionIds: ["v-exact"],
};
function row(index: number, extras: Record<string, unknown> = {}) {
  return {
    opportunityId: `case-${index}`,
    positionId: `candidate-${index}`,
    sourceKey: "source",
    protocol: "Example",
    chain: "Ethereum",
    metrics: {
      apy: {
        id: `rate-${index}`,
        valueDecimal: "0.1234567890123456789",
        unit: "fraction_per_year",
        observedAtMs: now - 1000,
      },
    },
    enrichment: { pharos: { grade: null } },
    evidenceIds: { metricSignalIds: [`rate-${index}`] },
    ...extras,
  };
}
const firstPage = Array.from({ length: 100 }, (_, index) => row(index));
function page(items: unknown[], nextCursor: string | null, total = 101) {
  return {
    criteria,
    items,
    page: { total, count: items.length, nextCursor, hasMore: nextCursor !== null },
  };
}

describe("bounded sequential opportunity population scan", () => {
  it("streams the complete screen but returns only a diverse sample with exact metrics and evidence", async () => {
    const last = row(100, {
      protocol: "Other",
      enrichment: { pharos: { grade: "A" } },
      metrics: {
        apy: {
          id: "rate-100",
          valueDecimal: "0.1234567890123456789",
          unit: "fraction_per_year",
          observedAtMs: now,
        },
        baseApy: { id: "base-100", valueDecimal: "0.1", unit: "fraction_per_year" },
      },
    });
    const get = vi.fn(async (path: string) => {
      const query = new URL(path, "http://fixture.test").searchParams;
      expect(query.get("limit")).toBe("100");
      expect(query.get("minimumGrade")).toBe("C-");
      expect(query.get("exposureScope")).toBe("single_set");
      return query.get("cursor") ? page([last], null) : page(firstPage, "opaque-page-2");
    });
    const scan = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD", minimumGrade: "C-" },
      get,
      () => now,
    );
    expect(scan.coverage).toMatchObject({
      status: "complete",
      pagesRead: 2,
      rowsRead: 101,
      total: 101,
      nextCursor: null,
    });
    expect(scan.analysisComplete).toBe(false);
    expect(scan.counts).toMatchObject({ missingProviderGrade: 100, fullRiskReviewUnknown: 101 });
    expect(scan.finalists.length).toBeLessThanOrEqual(8);
    expect(scan.finalists.find((item) => item.opportunityId === "case-100")).toMatchObject({
      publicationCursor: "opaque-page-2",
      publicationMinimumGrade: "C-",
      metrics: {
        apy: {
          valueDecimal: "0.1234567890123456789",
          unit: "fraction_per_year",
          observedAtMs: now,
        },
      },
      evidenceIds: { metricSignalIds: ["rate-100"] },
      sampleReasons: expect.arrayContaining([
        "known_provider_grade_not_overall_safety",
        "recent_yield_observation_not_a_change_claim",
      ]),
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("publishes a later-page finalist by forwarding the exact cursor, grade and version without repaging", async () => {
    const later = row(100, { enrichment: { pharos: { grade: "A" } } });
    const screen = vi.fn(async (path: string) =>
      new URL(path, "http://fixture.test").searchParams.has("cursor")
        ? page([later], null)
        : page(firstPage, "opaque-page-2"),
    );
    const scan = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD", minimumGrade: "C-" },
      screen,
      () => now,
    );
    const finalist = scan.finalists.find((item) => item.opportunityId === "case-100")!;
    let saved: Record<string, unknown> | null = null;
    const publicationReads: string[] = [];
    const result = await publishOpportunityLead(
      {
        assetSetKey: "USD",
        assetSetVersionId: String(scan.criteria?.assetSetVersionId),
        opportunityId: String(finalist.opportunityId),
        cursor: String(finalist.publicationCursor),
        minimumGrade: "C-",
        metricSignalIds: ["rate-100"],
        summary: "Investigate this candidate",
        risk: "Unknown withdrawal feasibility",
        counterargument: "Yield may not compensate for risk",
        invalidation: "Changed source observations",
      },
      {
        async get(path) {
          publicationReads.push(path);
          if (path === "/intelligence/opportunities/case-100")
            return {
              opportunity: { id: "case-100", positionId: "candidate-100", status: "discovered" },
              currentRecommendation: saved,
              candidateContext: {
                metricSignals: [
                  {
                    id: "rate-100",
                    sourceItemId: "item-100",
                    positionId: "candidate-100",
                    metricKey: "yield.apy",
                    observedAtMs: now,
                  },
                ],
              },
            };
          if (path === "/intelligence/context/latest")
            return {
              generatedAtMs: now,
              inputManifest: {
                portfolioSnapshotId: null,
                assetSetVersionIds: ["v-exact"],
                preferenceProfile: { key: "pref", version: 0 },
                sourceSyncs: [{ sourceKey: "source", syncId: "sync", status: "succeeded" }],
              },
            };
          const query = new URL(path, "http://fixture.test").searchParams;
          expect(query.get("cursor")).toBe("opaque-page-2");
          expect(query.get("minimumGrade")).toBe("C-");
          return page([later], null);
        },
        async post(_path, body) {
          saved = {
            id: "rec-exact",
            positionId: "candidate-100",
            opportunityId: "case-100",
            analysisRunId: (body as { publicationKey: string }).publicationKey,
            payload: { metadata: { researchAssetSetKey: "USD" } },
          };
          return { recommendations: [saved] };
        },
      },
    );
    expect(result).toMatchObject({ status: "published", recommendationId: "rec-exact" });
    expect(
      publicationReads.filter((path) => path.startsWith("/intelligence/screening?")),
    ).toHaveLength(1);
  });
  it("retains explicit partial coverage and a resume cursor after a page cap or provider failure", async () => {
    const get = vi.fn(async () => page(firstPage, "next"));
    const capped = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD", maxPages: 1 },
      get,
      () => now,
    );
    expect(capped.coverage).toMatchObject({
      status: "partial",
      reason: "scan_page_budget",
      pagesRead: 1,
      rowsRead: 100,
      nextCursor: "next",
    });
    expect(get).toHaveBeenCalledOnce();
    const failing = vi.fn(async () => {
      if (failing.mock.calls.length === 1) return page(firstPage, "next");
      throw new Error("private provider error");
    });
    const partial = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD" },
      failing,
      () => now,
    );
    expect(partial.coverage).toMatchObject({
      status: "partial",
      reason: "screen_page_unavailable",
      pagesRead: 1,
      rowsRead: 100,
      nextCursor: "next",
    });
    expect(JSON.stringify(partial)).not.toContain("private provider error");
  });
  it("never describes a resumed segment or changing population as complete", async () => {
    const resumed = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD", cursor: "start" },
      async () => page([row(1)], null),
      () => now,
    );
    expect(resumed.coverage).toMatchObject({
      status: "partial",
      fromBeginning: false,
      reason: "resumed_segment_only",
    });
    let calls = 0;
    const changed = await scanOpportunityPopulation(
      { action: "scan", assetSetKey: "USD" },
      async () => (++calls === 1 ? page(firstPage, "next") : page([row(100)], null, 102)),
      () => now,
    );
    expect(changed.coverage).toMatchObject({
      status: "partial",
      reason: "screen_population_changed",
      pagesRead: 1,
    });
  });
  it("enforces the public scan page cap and bounded scoped discovery contract", () => {
    expect(
      FarmingControlIntelligenceInputSchema.safeParse({
        action: "scan",
        assetSetKey: "USD",
        maxPages: 11,
      }).success,
    ).toBe(false);
    expect(FarmingControlIntelligenceInputSchema.safeParse({ action: "discovery" }).success).toBe(
      false,
    );
    expect(
      FarmingControlIntelligenceInputSchema.safeParse({
        action: "discovery",
        sourceKey: "lido",
        limit: 26,
      }).success,
    ).toBe(false);
    expect(
      FarmingControlIntelligenceInputSchema.safeParse({ action: "discovery", search: "Lido" })
        .success,
    ).toBe(true);
  });
});
