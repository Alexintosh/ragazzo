import { describe, expect, it, vi } from "vitest";
import { FarmingControlRiskReviewSchema } from "@rakazo/contracts";
import { createFarmingControlClient } from "./farming-control.js";
import { compactFarmingControlRiskReview } from "./farming-control-risk-review-model.js";
import { farmingControlToolsForRole } from "./farming-control-team-policy.js";

const now = 1_800_000_000_000;
const assessment = {
  family: "utilization",
  subjectKey: "pool:example",
  status: "attention",
  severity: "warning",
  summary: "Fixture assessment",
  indicators: { utilization: "0.900000000000000001" },
};
const item = {
  monitorKey: "pool-example",
  label: "Example pool",
  exposureRole: "not_evaluated",
  current: { status: "live", observedAtMs: now, collectedAtMs: now, assessments: [assessment] },
  emergency: { status: "attention" },
  history: {
    status: "ready",
    recordsRead: 2,
    truncated: false,
    oldestObservedAtMs: now - 1000,
    newestObservedAtMs: now,
    sampleCount: 2,
    transitionCount: 1,
  },
  trend: {
    status: "worsening",
    materialSignals: [],
    families: [
      {
        family: "utilization",
        lineageKey: "fixture-generation",
        first: {
          ...assessment,
          observedAtMs: now - 1000,
          status: "healthy",
          indicators: { utilization: "0.5" },
        },
        last: { ...assessment, observedAtMs: now },
        sampleCount: 2,
      },
    ],
  },
  limitations: [],
};
const evidence = {
  schemaVersion: "hot-monitoring-evidence.v1",
  asOfMs: now,
  window: "7d",
  requestedFromMs: now - 604800000,
  executionEligible: false,
  population: {
    configuredCount: 2,
    runningDesiredCount: 1,
    excludedStoppedCount: 1,
    basis: "all_desired_running_monitors",
  },
  items: [item],
};
function fixture(body: unknown = evidence, status = 200) {
  const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  return {
    transport,
    client: createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
      now: () => now,
    }),
  };
}

describe("Monitoring-wide risk review", () => {
  it("reads the fixed GET without holdings or wallet filtering and preserves exact dated evidence", async () => {
    const { client, transport } = fixture({ ...evidence, privateRuntimeField: "omit-me" });
    const review = await client.riskReview();
    expect(FarmingControlRiskReviewSchema.safeParse(review).success).toBe(true);
    expect(review.state).toBe("available");
    expect(review.selectionStatus).toBe("all_subjects");
    expect(review.evidence?.items[0]?.exposureRole).toBe("not_evaluated");
    expect(review.evidence?.items[0]?.current.assessments[0]?.indicators.utilization).toBe(
      "0.900000000000000001",
    );
    expect(review.evidence?.items[0]?.trend.families[0]?.first.observedAtMs).toBe(now - 1000);
    expect(JSON.stringify(review)).not.toContain("omit-me");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:9876/monitoring/hot/evidence?window=7d",
    );
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    expect(transport.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it("narrows only exact identities and distinguishes absent subjects from unavailable discovery", async () => {
    const { client, transport } = fixture();
    expect((await client.riskReview({ monitorKey: item.monitorKey })).selectionStatus).toBe(
      "matched",
    );
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:9876/monitoring/hot/evidence?window=7d&monitorKey=pool-example",
    );
    const absent = await client.riskReview({ monitorKey: "pool-other" });
    expect(absent.selectionStatus).toBe("absent_subject");
    expect(absent.evidence?.items).toEqual([]);
    expect(absent.evidence?.population.runningDesiredCount).toBe(1);
    expect(absent.state).toBe("partial");
    const failed = await fixture({}, 503).client.riskReview();
    expect(failed.selectionStatus).toBe("unavailable");
    expect(failed.evidence).toBeNull();
    expect(failed.state).toBe("unavailable");
  });
  it("attaches only the exact monitor's visible holding impact and never infers watch-only from absence", async () => {
    const visibility = {
      revision: 4,
      active: true,
      hiddenWalletAddresses: ["0x0000000000000000000000000000000000000001"],
    };
    const position = {
      id: "visible-position", label: "Visible holding", state: "active",
      current: { valueUsd: "1100.25", capitalBaselineUsd: "1000", observedAtMs: now, nature: "mark_to_market" },
      apr: null,
      dataQuality: { hasObservations: true, lastObservedAtMs: now, rateObservedAtMs: null, maxObservationAgeMs: 7200000 },
    };
    const morpho = (monitorKey: string, positionId: string) => ({
      monitorKey,
      positionId,
      label: monitorKey,
      kind: "direct_market",
      chainId: 1,
      address: "0x0000000000000000000000000000000000000002",
      assetSymbol: "USDC",
      positionState: "active",
      dataStatus: "live",
      current: {
        observedAtMs: now,
        collectedAtMs: now,
        blockNumber: "123",
        blockHash: `0x${"a".repeat(64)}`,
        metrics: {
          accountAssets: "9007199254740993.123456789",
          withdrawableAssets: "100.123456789",
          utilizationFraction: "0.9",
        },
      },
      assessments: [
        {
          family: "utilization",
          status: "attention",
          severity: "warning",
          summary: "Utilization evidence",
        },
      ],
      limitations: [],
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      const responses: Record<string, unknown> = {
        "/monitoring/hot/evidence": evidence,
        "/settings/wallet-visibility": visibility,
        "/positions": {
          asOfMs: now,
          walletVisibility: visibility,
          walletAttribution: { complete: true, partialPositionIds: [] },
          scope: { includedPositionIds: [position.id] },
          items: [position],
        },
        "/monitoring/morpho": {
          schemaVersion: "morpho-monitoring-dashboard.v1",
          asOfMs: now,
          items: [morpho(item.monitorKey, position.id), morpho("other-monitor", "hidden-position")],
        },
        "/monitoring/curve-risk/pools": {
          schemaVersion: "curve-risk-hot-pools.v2",
          asOfMs: now,
          source: "hot_supervisor_ram",
          items: [],
        },
        "/monitoring/alerts": { asOfMs: now, items: [] },
        "/monitoring/assessments": { asOfMs: now, items: [] },
        "/monitoring/hot/monitors/": [],
      };
      return Response.json(responses[path] ?? {});
    });
    const client = createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch,
      now: () => now,
    });
    const selected = await client.riskReview({ monitorKey: item.monitorKey });
    expect(selected.exposureAssociationStatus).toBe("matched_visible_holding");
    expect(selected.linkedExposure?.positions).toHaveLength(1);
    expect(compactFarmingControlRiskReview(selected).linkedExposure?.positions[0]).toMatchObject({
      id: position.id, association: "active_exposure", holding: {
        current: { valueUsd: "1100.25", observedAtMs: now },
        dataQuality: { valueFreshness: "current" },
      },
    });
    expect(selected.linkedExposure?.currentObservation?.metrics.accountAssets).toBe(
      "9007199254740993.123456789",
    );
    expect(JSON.stringify(selected)).not.toContain("hidden-position");
    expect(JSON.stringify(selected)).not.toContain("other-monitor");
    const broad = await client.riskReview();
    expect(broad.exposureAssociationStatus).toBe("not_requested");
    expect(broad.linkedExposure).toBeNull();
    const unknown = await fixture().client.riskReview({ monitorKey: item.monitorKey });
    expect(unknown.exposureAssociationStatus).toBe("unavailable");
    expect(unknown.linkedExposure).toBeNull();
  });
  it("keeps unavailable subjects and disabled history visible as partial coverage", async () => {
    const review = await fixture({
      ...evidence,
      items: [
        {
          ...item,
          current: {
            status: "unavailable",
            observedAtMs: null,
            collectedAtMs: null,
            assessments: [],
          },
          emergency: { status: "unknown" },
          history: { ...item.history, status: "disabled", sampleCount: 0 },
          trend: { status: "insufficient_evidence", materialSignals: [], families: [] },
          limitations: ["History disabled."],
        },
      ],
    }).client.riskReview();
    expect(review.state).toBe("partial");
    expect(review.evidence?.items).toHaveLength(1);
    expect(review.evidence?.items[0]?.emergency.status).toBe("unknown");
    expect(review.evidence?.items[0]?.history.status).toBe("disabled");
  });
  it("fails closed on malformed financial indicators, mismatched windows and executable claims", async () => {
    const numeric = { ...assessment, indicators: { utilization: 0.9 } };
    for (const body of [
      { ...evidence, window: "24h" },
      { ...evidence, executionEligible: true },
      { ...evidence, items: [{ ...item, current: { ...item.current, assessments: [numeric] } }] },
    ]) {
      const review = await fixture(body).client.riskReview();
      expect(review.state).toBe("unavailable");
      expect(review.evidence).toBeNull();
    }
    const { client, transport } = fixture();
    await expect(
      client.riskReview({ monitorKey: "example", endpoint: "/other" } as never),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("pages the inventory and compacts repeated lineages without changing raw evidence", async () => {
    const dense = {
      ...evidence,
      items: Array.from({ length: 15 }, (_, index) => ({
        ...item,
        monitorKey: `pool-${index}`,
        trend: {
          ...item.trend,
          families: Array.from({ length: 100 }, (_, lineage) => ({
            ...item.trend.families[0],
            lineageKey: `generation-${lineage}`,
          })),
        },
      })),
    };
    const review = await fixture(dense).client.riskReview();
    const compact = compactFarmingControlRiskReview(review);
    expect(compact.monitors).toHaveLength(12);
    expect(compact.nextInventoryOffset).toBe(12);
    expect(compact.omittedMonitorCount).toBe(3);
    expect(compact.monitors[0]?.trend.historicalLineageGroupCount).toBe(100);
    expect(compact.metricSets).toEqual([]);
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(24_000);
    expect(compactFarmingControlRiskReview(review, { inventoryOffset: 12 }).monitors).toHaveLength(
      3,
    );
    expect(
      compactFarmingControlRiskReview(review, { inventoryOffset: 12 }).nextInventoryOffset,
    ).toBeNull();
    const selected = compactFarmingControlRiskReview({
      ...review,
      selectionStatus: "matched",
      evidence: { ...dense, items: [dense.items[0]!] },
    } as typeof review);
    expect(
      selected.metricSets.find((set) => set.indicators.utilization)?.indicators.utilization,
    ).toBe("0.900000000000000001");
    expect(selected.monitors[0]?.trend.familySummaries[0]?.lineageCount).toBe(100);
    expect(selected.monitors[0]?.trend.statusChanges.length).toBe(8);
    expect(selected.monitors[0]?.omitted.statusChanges).toBe(92);
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(24_000);
    expect(review.evidence?.items[0]?.trend.families).toHaveLength(100);
  });
  it("keeps dense model output within budget by omitting whole records and preserving exact returned decimals", async () => {
    const exact = `0.${"1".repeat(500)}`;
    const dense = {
      ...evidence,
      items: [
        {
          ...item,
          current: {
            ...item.current,
            assessments: Array.from({ length: 64 }, (_, index) => ({
              ...assessment,
              family: `${index}-${"f".repeat(3_900)}`,
              subjectKey: "s".repeat(4_000),
              indicators: { exact },
            })),
          },
        },
      ],
    };
    const review = await fixture(dense).client.riskReview();
    const compact = compactFarmingControlRiskReview({ ...review, selectionStatus: "matched" });
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(24_000);
    expect(compact.monitors[0]?.omitted.currentAssessments).toBeGreaterThan(48);
    expect(compact.metricSets[0]?.indicators.exact).toBe(exact);
    expect(review.evidence?.items[0]?.current.assessments).toHaveLength(64);
  });
  it("offers the same strictly read-only review only to roles with risk grants", () => {
    for (const role of ["risk", "coordinator", "operations", "tax", "accounting"] as const) {
      const tool = farmingControlToolsForRole(role).find(
        (value) => value.name === "farming_control_risk_review",
      );
      expect(Boolean(tool)).toBe(role === "risk" || role === "coordinator");
      if (tool) {
        expect(tool.readOnly).toBe(true);
        expect(tool.inputSchema).toEqual({
          type: "object",
          properties: {
            window: { type: "string", enum: ["24h", "7d"] },
            inventoryOffset: { type: "integer", minimum: 0, maximum: 1_000 },
            monitorKey: { type: "string", minLength: 1, maxLength: 500 },
          },
          additionalProperties: false,
        });
      }
    }
  });
});
