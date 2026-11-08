import { describe, expect, it, vi } from "vitest";
import { createFarmingControlClient, farmingControlBaseUrl } from "./farming-control.js";
import { scopedFarmingControlRiskRead } from "./run-tools-farming-control.js";

const now = 1_800_000_000_000;
const walletVisibility = { revision: 1, active: false, hiddenWalletAddresses: [] };
const coverage = {
  projectionCoverageRatio: "0.75",
  includedPositionIds: ["position-a"],
  excluded: [],
  earnedExcludedPositionIds: [],
  earnedExcluded: [],
  lifecycleExcludedPositionIds: [],
};
const positions = {
  asOfMs: now,
  walletVisibility,
  scope: {
    assetSetKey: null,
    label: "All sets",
    includedPositionIds: ["position-a"],
    availableAssetSets: [],
  },
  cumulative: {
    currentPricedValueUsd: "9007199254740993.123456789012345678",
    currentBlendedApr: { valueDecimal: "0.054321", percentPerYear: "5.4321" },
    expectedYield30dUsd: null,
    liveEarnedUsd: "1.23e-18",
    liveEarnedBreakdownUsd: {
      unrealized: "1.23e-18",
      claimableNotRealized: null,
      nature: "current_observed_marks_not_realized_roi",
      valuationComplete: true,
    },
    coverage,
  },
  items: [
    {
      id: "position-a",
      label: "Example position",
      state: "active",
      adapter: { key: "fixture", secret: "private-field-marker" },
      current: {
        valueUsd: null,
        capitalBaselineUsd: "10.000000000000000001",
        observedAtMs: now,
        nature: "mark_to_market",
      },
      apr: null,
      dataQuality: {
        hasObservations: true,
        lastObservedAtMs: now,
        rateObservedAtMs: now,
        maxObservationAgeMs: 7_200_000,
      },
      metadata: { privateWallet: "private-field-marker" },
    },
  ],
  runtimePath: "private-field-marker",
};
const history = {
  asOfMs: now,
  walletVisibility,
  points: [
    {
      snapshotId: "snapshot-a",
      sampledAtMs: now - 100,
      recordedAtMs: now,
      quality: "partial",
      currentBlendedApr: null,
      expectedYield30dUsd: null,
      liveEarnedUsd: null,
      coverage: { currentPricedValueUsd: "100.000000000001", projectionCoverageRatio: null },
    },
  ],
  page: { nextCursor: "more" },
};
function clientFor(responses: Record<string, unknown>, statuses: Record<string, number> = {}) {
  const transport = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/settings/wallet-visibility") return Response.json(walletVisibility);
    if (!(path in responses)) throw new Error("unexpected source");
    return new Response(JSON.stringify(responses[path]), {
      status: statuses[path] ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    client: createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
      now: () => now,
    }),
    transport,
  };
}

describe("Farming Control read-only host client", () => {
  it("preserves exact values, unknowns and source snapshot history while stripping unapproved fields", async () => {
    const { client, transport } = clientFor({
      "/positions": positions,
      "/portfolio/metrics/projections": history,
    });
    const result = await client.portfolio();
    expect(result.totals?.currentPricedValueUsd).toBe("9007199254740993.123456789012345678");
    expect(result.totals?.liveEarnedUsd).toBe("1.23e-18");
    expect(result.positions[0]?.current.valueUsd).toBeNull();
    expect(result.positions[0]?.current.capitalBaselineUsd).toBe("10.000000000000000001");
    expect(result.history[0]?.sampledAtMs).toBe(now - 100);
    expect(result.historyTruncated).toBe(true);
    expect(result.state).toBe("partial");
    expect(JSON.stringify(result)).not.toContain("private-field-marker");
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:9876\//);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.body).toBeUndefined();
    }
  });
  it("retains primary portfolio data when history fails and never invents a series", async () => {
    const { client } = clientFor(
      { "/positions": positions, "/portfolio/metrics/projections": {} },
      { "/portfolio/metrics/projections": 503 },
    );
    const result = await client.portfolio();
    expect(result.positions).toHaveLength(1);
    expect(result.history).toEqual([]);
    expect(result.state).toBe("partial");
    expect(result.issues.join()).toContain("Recent history is partial");
  });
  it("rejects numeric money and malformed responses instead of coercing them", async () => {
    const { client } = clientFor({
      "/positions": {
        ...positions,
        cumulative: { ...positions.cumulative, currentPricedValueUsd: 9007199254740992 },
      },
      "/portfolio/metrics/projections": history,
    });
    const result = await client.portfolio();
    expect(result.state).toBe("unavailable");
    expect(result.totals).toBeNull();
    expect(result.positions).toEqual([]);
  });
  it("preserves dated harvest evidence and unknown coverage", async () => {
    const contribution = {
      positionId: "position-a",
      positionLabel: "Example position",
      economicId: "reward-a",
      type: "reward",
      symbol: "RWD",
      amount: "0.000000000000000001",
      amountRaw: "1",
      valueUsd: null,
      quality: "fallback",
      quantityObservedAtMs: now - 500,
      priceObservedAtMs: null,
      reason: "No current price",
      readiness: "refresh_required",
      account: "private-field-marker",
    };
    const { client } = clientFor({
      "/harvest/outstanding": {
        asOfMs: now,
        complete: false,
        totalOutstandingUsd: null,
        claimableUsd: null,
        embeddedUsd: null,
        currentOutstandingUsd: "0",
        fallbackOutstandingUsd: "0",
        unknownEmbeddedCount: 0,
        unknownRewardCount: 1,
        invalidatedContributionCount: 0,
        components: [],
        rewardComponents: [contribution],
      },
    });
    const result = await client.harvest();
    expect(result.complete).toBe(false);
    expect(result.totals?.totalOutstandingUsd).toBeNull();
    expect(result.contributions[0]?.amountRaw).toBe("1");
    expect(result.contributions[0]?.quality).toBe("fallback");
    expect(result.state).toBe("partial");
    expect(JSON.stringify(result)).not.toContain("private-field-marker");
  });
  it("does not describe empty retired monitoring as safety", async () => {
    const { client } = clientFor({
      "/monitoring/alerts": { asOfMs: now, items: [], retired: true },
      "/monitoring/assessments": { asOfMs: now, items: [], retired: true },
    });
    const result = await client.risk();
    expect(result.complete).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.issues.join()).toContain("retired");
  });
  it("reads accounting independently of optional tax module availability", async () => {
    const totals = {
      realizedUsd: "12.000000000001",
      costsUsd: "0.2",
      netRealizedUsd: "11.800000000001",
      realizationCount: 1,
    };
    const { client } = clientFor(
      {
        "/harvest/accounting": { asOfMs: now, totals, months: [{ month: "2026-10", ...totals }] },
        "/cashout-tax/capabilities": {},
      },
      { "/cashout-tax/capabilities": 404 },
    );
    const result = await client.accounting();
    expect(result.totals?.netRealizedUsd).toBe("11.800000000001");
    expect(result.tax.state).toBe("unavailable");
    expect(result.state).toBe("partial");
  });
  it("bounds streamed bodies, hides upstream errors and reports unreachable health honestly", async () => {
    const oversized = new Response(new Uint8Array(4 * 1024 * 1024 + 1));
    const transport = vi.fn<typeof fetch>(async () => oversized);
    const client = createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
    });
    expect((await client.harvest()).state).toBe("unavailable");
    const offline = createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: async () => {
        throw new Error("sensitive server details");
      },
    });
    expect(await offline.status()).toMatchObject({
      configured: true,
      connection: "unavailable",
      readOnly: true,
    });
    expect(JSON.stringify(await offline.harvest())).not.toContain("sensitive");
  });
  it("reads recent windows independently and samples actual dated records without interpolation", async () => {
    const day = 86_400_000;
    const base = Math.floor(now / day) * day - 10 * day;
    const points = [
      {
        ...history.points[0]!,
        snapshotId: "oldest",
        sampledAtMs: now - 80 * day,
        recordedAtMs: now - 80 * day,
      },
      {
        ...history.points[0]!,
        snapshotId: "day-first",
        sampledAtMs: base + 1_000,
        recordedAtMs: base + 1_000,
      },
      {
        ...history.points[0]!,
        snapshotId: "day-middle",
        sampledAtMs: base + 2_000,
        recordedAtMs: base + 2_000,
      },
      {
        ...history.points[0]!,
        snapshotId: "day-last",
        sampledAtMs: base + 3_000,
        recordedAtMs: base + 3_000,
      },
      {
        ...history.points[0]!,
        snapshotId: "newest",
        sampledAtMs: now - 1_000,
        recordedAtMs: now - 1_000,
      },
    ];
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/settings/wallet-visibility") return Response.json(walletVisibility);
      if (url.pathname === "/positions") return Response.json(positions);
      expect(url.pathname).toBe("/portfolio/metrics/projections");
      expect(url.searchParams.get("limit")).toBe("200");
      const from = Number(url.searchParams.get("fromMs"));
      const to = Number(url.searchParams.get("toMs"));
      return Response.json({
        asOfMs: now,
        walletVisibility,
        points: points.filter((point) => point.sampledAtMs >= from && point.sampledAtMs <= to),
        page: { nextCursor: null },
      });
    });
    const result = await createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
      now: () => now,
    }).portfolio();
    expect(result.historyTruncated).toBe(false);
    expect(result.historyRange).toMatchObject({
      fromMs: now - 90 * day,
      toMs: now,
      windowDays: 90,
      observedPointCount: 5,
      returnedPointCount: 4,
      retrievalComplete: true,
    });
    expect(result.history.map((point) => point.snapshotId)).toEqual([
      "oldest",
      "day-first",
      "day-last",
      "newest",
    ]);
    for (const point of result.history) expect(points).toContainEqual(point);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it("caps dense older history without starving the independent recent window and copies opaque cursors", async () => {
    const day = 86_400_000;
    const calls = new Map<number, number>();
    const opaqueCursor = "opaque&not-a-new-parameter=1";
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/settings/wallet-visibility") return Response.json(walletVisibility);
      if (url.pathname === "/positions") return Response.json(positions);
      const from = Number(url.searchParams.get("fromMs"));
      const to = Number(url.searchParams.get("toMs"));
      const index = calls.get(from) ?? 0;
      calls.set(from, index + 1);
      if (from === now - 90 * day) {
        if (index > 0) expect(url.searchParams.get("cursor")).toBe(`${opaqueCursor}:${index}`);
        return Response.json({
          asOfMs: now,
          walletVisibility,
          points: [
            { ...history.points[0]!, snapshotId: `dense-${index}`, sampledAtMs: from + index + 1 },
          ],
          page: { nextCursor: `${opaqueCursor}:${index + 1}` },
        });
      }
      return Response.json({
        asOfMs: now,
        walletVisibility,
        points: [{ ...history.points[0]!, snapshotId: `recent-${from}`, sampledAtMs: to }],
        page: { nextCursor: null },
      });
    });
    const result = await createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
      now: () => now,
    }).portfolio();
    expect(result.historyTruncated).toBe(true);
    expect(result.historyRange.windows[0]).toMatchObject({
      state: "partial",
      truncated: true,
      observedPointCount: 4,
    });
    expect(result.historyRange.windows.at(-1)).toMatchObject({
      state: "available",
      truncated: false,
      lastSampleAtMs: now,
    });
    expect(result.history.at(-1)?.sampledAtMs).toBe(now);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(15);
    expect(transport.mock.calls.some(([input]) => String(input).includes("opaque%26"))).toBe(true);
    expect(result.issues.join()).not.toContain(opaqueCursor);
  });

  it("retains earnings component exclusions and independently marks stale APR when position value is fresh", async () => {
    const item = positions.items[0]!;
    const data = {
      ...positions,
      cumulative: {
        ...positions.cumulative,
        liveEarnedBreakdownUsd: {
          ...positions.cumulative.liveEarnedBreakdownUsd,
          valuationComplete: false,
        },
        coverage: {
          ...coverage,
          earnedExcluded: [
            {
              positionId: item.id,
              component: "unrealized_usd",
              reasons: ["adapter_measure_is_not_usd_valuation"],
            },
          ],
        },
      },
      items: [
        {
          ...item,
          current: { ...item.current, valueUsd: "100.00000001" },
          apr: { percentPerYear: "5.4321", observedAtMs: now - 8_000_000, projectionOnly: true },
          dataQuality: { ...item.dataQuality, rateObservedAtMs: now - 8_000_000 },
        },
      ],
    };
    const { client } = clientFor({
      "/positions": data,
      "/portfolio/metrics/projections": { ...history, points: [], page: { nextCursor: null } },
    });
    const result = await client.portfolio();
    expect(result.totals?.liveEarnedBreakdownUsd.valuationComplete).toBe(false);
    expect(result.totals?.coverage.earnedExcluded[0]).toEqual({
      positionId: item.id,
      component: "unrealized_usd",
      reasons: ["adapter_measure_is_not_usd_valuation"],
    });
    expect(result.positions[0]?.dataQuality).toMatchObject({
      valueFreshness: "current",
      aprFreshness: "stale",
      rateObservedAtMs: now - 8_000_000,
    });
    expect(result.issues.join()).toContain("APR observations");
    expect(result.issues.join()).toContain("earnings components");
  });

  it("distinguishes failed generic alerts, retired empty assessments and sanitized current hot monitors", async () => {
    const monitor = {
      monitorKey: "example.monitor",
      actualState: "running",
      health: "healthy",
      asOfMs: now,
      desiredState: "running",
      supervisorReachable: true,
    };
    const { client } = clientFor(
      {
        "/monitoring/alerts": {},
        "/monitoring/assessments": { asOfMs: now, items: [], retired: true },
        "/monitoring/hot/monitors/": [
          {
            ...monitor,
            configuration: { secret: "hidden-runtime-marker" },
            process: { pid: 123, privatePath: "hidden-runtime-marker" },
            snapshot: { privateRecord: "hidden-runtime-marker" },
            lastError: "hidden-runtime-marker",
          },
        ],
      },
      { "/monitoring/alerts": 503 },
    );
    const result = await client.risk();
    expect(result.monitors).toEqual([monitor]);
    expect(result.sourceAvailability).toEqual({
      morpho: { state: "unavailable", asOfMs: null, returnedCount: null, truncated: false },
      curve: { state: "unavailable", asOfMs: null, returnedCount: null, truncated: false },
      alerts: { state: "unavailable", asOfMs: null, returnedCount: null, truncated: false },
      assessments: { state: "retired", asOfMs: now, returnedCount: 0, truncated: false },
      monitors: { state: "available", asOfMs: now, returnedCount: 1, truncated: false },
    });
    expect(JSON.stringify(result)).not.toContain("hidden-runtime-marker");
    expect(result.complete).toBe(false);
    expect(result.state).toBe("partial");
  });

  function connectedFixture() {
    const position = {
      ...positions.items[0]!,
      current: { ...positions.items[0]!.current, valueUsd: "12345.000000000000000001" },
      apr: { percentPerYear: "6.123456789", observedAtMs: now - 10, projectionOnly: true },
      metadata: { nodes: [], relations: [], privateWallet: "private-field-marker" },
    };
    const morpho = (positionId: string, monitorKey: string) => ({
      positionId, monitorKey, label: "Same display name", kind: "direct_market", chainId: 1,
      address: "0x0000000000000000000000000000000000000002", assetSymbol: "USDC",
      positionState: "active", dataStatus: "live",
      current: { observedAtMs: now, collectedAtMs: now, blockNumber: "123",
        blockHash: `0x${"a".repeat(64)}`, metrics: { withdrawableFraction: "0.99" } },
      assessments: [
        { family: "utilization", status: "attention", severity: "warning", summary: "Utilization rose" },
        { family: "exit_capacity", status: "healthy", severity: "info", summary: "Exit capacity available" },
      ], limitations: [],
    });
    const data = { ...positions,
      scope: { ...positions.scope, includedPositionIds: [position.id, "position-b"] },
      items: [position, { ...position, id: "position-b", label: position.label,
        current: { ...position.current, valueUsd: "999" } }],
    };
    const responses = {
      "/positions": data,
      "/monitoring/morpho": { schemaVersion: "morpho-monitoring-dashboard.v1", asOfMs: now,
        items: [morpho(position.id, "morpho.market.example"), morpho("position-b", "morpho.market.other")] },
      "/monitoring/curve-risk/pools": { schemaVersion: "curve-risk-hot-pools.v2", asOfMs: now,
        source: "hot_supervisor_ram", items: [] },
      "/monitoring/alerts": { asOfMs: now, items: [] },
      "/monitoring/assessments": { asOfMs: now, items: [] },
      "/monitoring/hot/monitors/": [],
    };
    return { position, data, responses };
  }

  it("joins position and risk evidence by exact ID with one saved-scope portfolio read", async () => {
    const fixture = connectedFixture();
    const { client, transport } = clientFor(fixture.responses);
    const result = await client.entity({ kind: "position", id: fixture.position.id }, { includeRisk: true });
    expect(result.selectionStatus).toBe("matched");
    expect(result.state).toBe("available");
    expect(result.relatedRisks?.map((risk) => risk.id)).toEqual(["morpho.market.example"]);
    expect(result.risk?.positions).toHaveLength(1);
    expect(result.risk?.positions[0]?.holding).toMatchObject({
      state: "active", current: fixture.position.current, apr: fixture.position.apr,
      dataQuality: { valueFreshness: "current", aprFreshness: "current" },
    });
    expect(result.risk?.holdingScope).toEqual({ walletVisibilityRevision: 1, asOfMs: now,
      valueBasis: "visible_position_mark_not_sized_protocol_exposure" });
    expect(transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/positions")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("position-b");
    expect(JSON.stringify(result)).not.toContain("private-field-marker");
    expect(result).not.toHaveProperty("walletSettings");
    // Historical yield limitations stay scoped to yieldEvidence, rather than
    // declaring the complete current position/risk association unavailable.
    expect(result.yieldEvidence?.issues.length).toBeGreaterThan(0);
  });

  it("keeps portfolio-only position reads within their existing grant", async () => {
    const fixture = connectedFixture();
    const { client, transport } = clientFor(fixture.responses);
    const result = await client.entity({ kind: "position", id: fixture.position.id });
    expect(result.risk).toBeNull();
    expect(result.relatedRisks).toEqual([]);
    expect(transport.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith("/monitoring/"))).toBe(false);
  });

  it("carries same-card competing signals and exact marks into a selected risk read", async () => {
    const { client } = clientFor(connectedFixture().responses);
    const selected = scopedFarmingControlRiskRead(await client.risk(), "morpho.market.example", "utilization");
    expect(selected.exposure?.signals.map((signal) => signal.key)).toEqual(["utilization"]);
    expect(selected.supportingSignals.map((signal) => signal.key)).toEqual(["exit_capacity"]);
    expect(selected.exposure?.positions[0]?.holding?.current.valueUsd).toBe("12345.000000000000000001");
    expect(JSON.stringify(selected)).not.toContain("morpho.market.other");
  });

  it("withholds connected risk amounts when the visible holding has mixed wallet attribution", async () => {
    const fixture = connectedFixture();
    const { client } = clientFor({ ...fixture.responses, "/positions": { ...fixture.data,
      walletAttribution: { complete: false, partialPositionIds: [fixture.position.id] },
    } });
    const result = await client.entity({ kind: "position", id: fixture.position.id }, { includeRisk: true });
    expect(result.risk).toBeNull();
    expect(result.relatedRisks).toEqual([]);
    expect(result.issues.join()).toContain("Connected risk discovery is incomplete");
  });

  it.each([
    "https://public.example",
    "http://169.254.169.254",
    "http://user:pass@127.0.0.1",
    "file:///tmp/fc",
    "http://127.0.0.1/positions",
    "http://127.0.0.1?path=positions",
    "http://127.0.0.1#fragment",
  ])("rejects nonprivate or nonorigin configuration %s", (url) => {
    expect(() => farmingControlBaseUrl(url)).toThrow();
  });
  it.each([
    "http://host.docker.internal:8766",
    "http://127.0.0.1:8766",
    "http://[::1]:8766",
    "http://10.1.2.3:8766",
  ])("accepts explicit private host origins %s", (url) => {
    expect(farmingControlBaseUrl(url)).toBe(url);
  });
});
