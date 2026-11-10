import { FarmingControlIntelligenceInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFarmingControlIntelligence } from "./farming-control-intelligence.js";

const now = 1_800_000_000_000;
const rec = {
  id: "rec-exact",
  positionId: "candidate-exact",
  opportunityId: "opportunity-exact",
  status: "current",
  summary: "Investigate",
  payload: {
    risks: ["Unknown withdrawal restrictions"],
    privateSecret: "must-not-leak",
    portfolio: { valueUsd: "hidden" },
  },
};
const detail = {
  recommendation: rec,
  candidate: { id: "opportunity-exact", positionId: "candidate-exact" },
  candidateContext: {
    position: { purpose: "candidate", adapterConfig: "must-not-leak" },
    metricSignals: [
      {
        id: "metric-exact",
        sourceId: "source",
        sourceItemId: "item",
        metricKey: "yield.apy",
        valueDecimal: "0.1234567890123456789",
        observedAtMs: now,
      },
    ],
    claims: [],
    report: null,
  },
  feedback: [] as unknown[],
};
const profile = {
  profileKey: "portfolio-opportunity-ranking",
  version: 0,
  status: "uninitialized",
  payload: {},
  signals: [],
  createdAtMs: null,
};
function fixture(handler: (path: string, init?: RequestInit) => unknown | Promise<unknown>) {
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const response = await handler(`${url.pathname}${url.search}`, init);
    return response instanceof Response ? response : Response.json(response);
  });
  return {
    http,
    client: createFarmingControlIntelligence({
      baseUrl: "http://127.0.0.1:9876",
      fetch: http,
      now: () => now,
    }),
  };
}

const refreshJob = {
  id: "synthetic-job-a",
  sourceId: "synthetic-source-a",
  source: { id: "synthetic-source-a", key: "source-a", label: null },
  status: "completed",
  attempts: 1,
  maxAttempts: 3,
  runAfterMs: now - 60_000,
  createdAtMs: now - 60_000,
  updatedAtMs: now,
  result: { sourceSync: { syncId: "synthetic-sync-a", status: "succeeded" } },
  sourceSync: {
    id: "synthetic-sync-a",
    sourceId: "synthetic-source-a",
    status: "succeeded",
    startedAtMs: now - 60_000,
    finishedAtMs: now,
  },
};

describe("source attempt and candidate value evidence", () => {
  it("keeps the same FC job identity for concurrent refresh requests", async () => {
    let submissions = 0;
    const f = fixture((path, init) => {
      if (path === "/intelligence/sources")
        return {
          items: [
            {
              ...refreshJob.source,
              enabled: true,
              mode: "pull",
              available: true,
              pullSyncable: true,
            },
          ],
        };
      expect(path).toBe("/intelligence/sources/refresh");
      expect(init?.method).toBe("POST");
      return {
        requestedSourceKeys: ["source-a"],
        jobs: [
          {
            source: refreshJob.source,
            job: { ...refreshJob, status: "running" },
            deduplicated: submissions++ > 0,
          },
        ],
      };
    });
    const input = {
      scope: "source" as const,
      sourceKey: "source-a",
      operatorQuote: "Refresh source-a",
    };
    const [first, second] = await Promise.all([
      f.client.refreshSources(input),
      f.client.refreshSources(input),
    ]);
    expect(first).toMatchObject({
      state: "accepted",
      jobs: [{ job: { id: refreshJob.id }, deduplicated: false }],
    });
    expect(second).toMatchObject({
      state: "accepted",
      jobs: [{ job: { id: refreshJob.id }, deduplicated: true }],
    });
    expect(submissions).toBe(2);
  });

  it.each([
    ["queued", null, "pending", false],
    ["running", null, "pending", false],
    ["completed", null, "unconfirmed", true],
    [
      "completed",
      { ...refreshJob.sourceSync, status: "running", finishedAtMs: null },
      "unconfirmed",
      true,
    ],
    ["completed", { ...refreshJob.sourceSync, status: "failed" }, "failed", true],
    ["completed", refreshJob.sourceSync, "succeeded", true],
    ["dead", null, "failed", true],
    ["cancelled", null, "cancelled", true],
  ])(
    "projects %s and its independent source-sync result",
    async (status, sourceSync, outcome, terminal) => {
      const f = fixture(() => ({
        ...refreshJob,
        status,
        sourceSync,
        lastError: { code: "lease_expired_max_attempts", message: "private-provider-error" },
      }));
      const result = await f.client.read({ action: "refresh_status", jobId: refreshJob.id });
      expect(result).toMatchObject({ state: "available", data: { status, outcome, terminal } });
      expect(JSON.stringify(result)).not.toContain("private-provider-error");
    },
  );

  it.each([
    "source_not_found",
    "source_disabled",
    "source_push_only",
    "adapter_unavailable",
    "sync_runtime_unavailable",
    "not_refreshable",
  ])("retains the worker's safe skip reason %s", async (reason) => {
    const f = fixture(() => ({
      ...refreshJob,
      sourceSync: null,
      result: { status: "skipped", reason },
    }));
    expect(await f.client.read({ action: "refresh_status", jobId: refreshJob.id })).toMatchObject({
      state: "available",
      data: { outcome: "skipped", terminal: true, skippedReason: reason, sourceSync: null },
    });
  });

  it("keeps unknown skip reasons private and never treats a non-skipped result as a skip", async () => {
    for (const [status, reason, outcome] of [
      ["skipped", "private-provider-error", "skipped"],
      ["other", "source_disabled", "unconfirmed"],
    ]) {
      const f = fixture(() => ({ ...refreshJob, sourceSync: null, result: { status, reason } }));
      const result = await f.client.read({ action: "refresh_status", jobId: refreshJob.id });
      expect(result).toMatchObject({ state: "available", data: { outcome, skippedReason: null } });
      expect(JSON.stringify(result)).not.toContain("private-provider-error");
    }
  });

  it.each(["failed", "succeeded"])(
    "rereads the exact candidate after a %s sync without advancing an old value date",
    async (syncStatus) => {
      const oldAt = now - 86_400_000;
      const oldMetric = {
        id: "synthetic-metric-a",
        positionId: "synthetic-candidate-a",
        sourceId: refreshJob.sourceId,
        sourceItemId: "synthetic-item-a",
        metricKey: "yield.apy",
        valueDecimal: "0.045",
        unit: "fraction_per_year",
        observedAtMs: oldAt,
        metadata: { methodology: "provider", window: "current" },
      };
      const criteria = {
        assetSetKey: "USD",
        assetSetVersionId: "synthetic-version",
        activeAssetSetVersionIds: ["synthetic-version"],
      };
      const f = fixture((path) => {
        if (path === `/intelligence/sources/refresh-jobs/${refreshJob.id}`)
          return { ...refreshJob, sourceSync: { ...refreshJob.sourceSync, status: syncStatus } };
        if (path === "/intelligence/opportunities/synthetic-case-a")
          return {
            opportunity: {
              id: "synthetic-case-a",
              positionId: oldMetric.positionId,
              status: "discovered",
            },
            candidateContext: { metricSignals: [oldMetric], claims: [] },
            currentRecommendation: null,
            recommendations: [],
            feedback: [],
          };
        if (path.startsWith("/intelligence/screening?"))
          return {
            criteria,
            items: [
              {
                opportunityId: "synthetic-case-a",
                positionId: oldMetric.positionId,
                sourceKey: "source-a",
                metrics: { apy: oldMetric },
              },
              {
                opportunityId: "synthetic-case-b",
                positionId: "synthetic-candidate-b",
                sourceKey: "source-b",
                metrics: {
                  apy: {
                    ...oldMetric,
                    id: "synthetic-metric-b",
                    positionId: "synthetic-candidate-b",
                    sourceId: "synthetic-source-b",
                    sourceItemId: "synthetic-item-b",
                    valueDecimal: "0.04",
                    observedAtMs: now,
                  },
                },
                operatorFeedback: {
                  count: 1,
                  latest: { sentiment: "negative", reason: "weak_evidence" },
                },
              },
            ],
            page: { total: 2, count: 2, hasMore: false, nextCursor: null },
          };
        throw new Error(`Unexpected request: ${path}`);
      });
      const attempt = await f.client.read({ action: "refresh_status", jobId: refreshJob.id });
      const candidate = await f.client.read({
        action: "opportunity",
        opportunityId: "synthetic-case-a",
      });
      const screen = await f.client.read({ action: "screen", assetSetKey: "USD" });
      expect(attempt).toMatchObject({
        state: "available",
        data: {
          outcome: syncStatus === "failed" ? "failed" : "succeeded",
          sourceSync: { startedAtMs: now - 60_000, finishedAtMs: now },
        },
      });
      expect(candidate).toMatchObject({
        state: "available",
        fetchedAtMs: now,
        data: {
          opportunity: { id: "synthetic-case-a", positionId: oldMetric.positionId },
          candidateContext: { metricSignals: [oldMetric] },
        },
      });
      expect(screen).toMatchObject({
        state: "available",
        data: {
          criteria,
          items: [
            {
              sourceKey: "source-a",
              metrics: { apy: { valueDecimal: "0.045", observedAtMs: oldAt } },
            },
            {
              sourceKey: "source-b",
              metrics: { apy: { valueDecimal: "0.04", observedAtMs: now } },
              operatorFeedback: { count: 1 },
            },
          ],
        },
      });
      expect(f.http.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        `/intelligence/sources/refresh-jobs/${refreshJob.id}`,
        "/intelligence/opportunities/synthetic-case-a",
        "/intelligence/screening",
      ]);
      expect(f.http.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    },
  );

  it("rejects status from a different job or source before claiming success", async () => {
    for (const reply of [
      { ...refreshJob, id: "other-job" },
      { ...refreshJob, sourceSync: { ...refreshJob.sourceSync, sourceId: "other-source" } },
    ]) {
      const f = fixture(() => reply);
      expect(await f.client.read({ action: "refresh_status", jobId: refreshJob.id })).toMatchObject(
        { state: "unavailable" },
      );
    }
  });
});

describe("bounded Farming Control Intelligence transport", () => {
  it("exposes source status and failure timestamps without config, cursors or transport secrets", async () => {
    const f = fixture(() => ({
      items: [
        {
          id: "s",
          key: "pools",
          mode: "pull",
          enabled: true,
          available: true,
          config: { apiKey: "must-not-leak" },
          locator: { url: "https://user:must-not-leak@example.test/?token=must-not-leak" },
          latestSync: {
            id: "sync",
            status: "failed",
            finishedAtMs: now,
            error: "must-not-leak",
            cursorAfter: { credential: "must-not-leak" },
          },
        },
      ],
      adapters: [{ key: "fixture", version: "1", configSchema: { password: "must-not-leak" } }],
    }));
    const result = await f.client.read({ action: "sources" });
    expect(result).toMatchObject({
      state: "available",
      action: "sources",
      data: {
        refreshed: false,
        items: [
          { key: "pools", latestSync: { status: "failed", failed: true, finishedAtMs: now } },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(f.http.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    expect(f.http).toHaveBeenCalledOnce();
  });
  it("screens only an exact Asset Set with conservative scope and preserves opaque IDs, decimals and pagination", async () => {
    const f = fixture((path) => {
      const url = new URL(path, "http://fixture.test");
      expect(url.pathname).toBe("/intelligence/screening");
      expect(url.searchParams.get("assetSetKey")).toBe("USD & cash");
      expect(url.searchParams.get("minimumTvlUsd")).toBe("1000000");
      expect(url.searchParams.get("evmOnly")).toBe("true");
      expect(url.searchParams.get("exposureScope")).toBe("single_set");
      expect(url.searchParams.has("minimumApy")).toBe(false);
      return {
        criteria: {
          assetSetKey: "USD & cash",
          assetSetVersionId: "v-exact",
          activeAssetSetVersionIds: ["v-exact"],
        },
        items: [
          {
            opportunityId: "opaque-case-exact",
            positionId: "candidate-exact",
            metrics: {
              apy: { id: "metric-exact", valueDecimal: "0.1234567890123456789", observedAtMs: now },
            },
            evidenceIds: { metricSignalIds: ["metric-exact"] },
            operatorMetadata: {
              profile: { fees: { performance: "0.005" }, secret: "must-not-leak" },
            },
          },
        ],
        page: { total: 101, count: 1, nextCursor: "opaque+cursor/=", hasMore: true },
      };
    });
    const result = await f.client.read({ action: "screen", assetSetKey: "USD & cash" });
    expect(result).toMatchObject({
      state: "available",
      data: {
        criteria: { assetSetVersionId: "v-exact" },
        items: [
          {
            opportunityId: "opaque-case-exact",
            metrics: { apy: { valueDecimal: "0.1234567890123456789" } },
          },
        ],
        page: { nextCursor: "opaque+cursor/=", total: 101 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    await f.client.read({ action: "screen", assetSetKey: "USD & cash", cursor: "opaque+cursor/=" });
    expect(new URL(String(f.http.mock.calls[1]?.[0])).searchParams.get("cursor")).toBe(
      "opaque+cursor/=",
    );
  });
  it("serializes simultaneous screening requests to protect the embedded FC backend", async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const f = fixture(async () => {
      calls += 1;
      if (calls === 1) await hold;
      return {
        criteria: { assetSetKey: calls === 1 ? "one" : "two" },
        items: [],
        page: { total: 0, nextCursor: null },
      };
    });
    const first = f.client.read({ action: "screen", assetSetKey: "one" });
    const second = f.client.read({ action: "screen", assetSetKey: "two" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
  it("rejects arbitrary request/configuration fields and out-of-universe screening switches before any request", async () => {
    const f = fixture(() => ({}));
    for (const input of [
      { action: "sources", url: "http://external.test" },
      { action: "screen", assetSetKey: "set", evmOnly: false },
      { action: "screen", assetSetKey: "set", minimumApy: "0.1" },
      { action: "source_refresh" },
      { action: "evidence", sourceKey: "source" },
    ])
      expect(FarmingControlIntelligenceInputSchema.safeParse(input).success).toBe(false);
    expect(f.http).not.toHaveBeenCalled();
  });
  it("keeps candidate evidence and feedback separate from hidden or canonical portfolio data", async () => {
    const f = fixture(() => ({
      ...detail,
      portfolio: { wallet: "hidden" },
      portfolioSnapshot: { valueUsd: "hidden" },
    }));
    const result = await f.client.read({ action: "recommendation", recommendationId: "rec-exact" });
    expect(result).toMatchObject({
      state: "available",
      data: {
        recommendation: {
          id: "rec-exact",
          payload: { risks: ["Unknown withdrawal restrictions"] },
        },
        candidateContext: {
          metricSignals: [{ id: "metric-exact", valueDecimal: "0.1234567890123456789" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(new URL(String(f.http.mock.calls[0]?.[0])).pathname).toBe(
      "/intelligence/recommendations/rec-exact",
    );
  });
  it("strips credentials and sensitive URL query values from selected compact evidence", async () => {
    const f = fixture(() => ({
      source: { id: "source-id", key: "source/a", config: { secret: "must-not-leak" } },
      item: {
        id: "i/1",
        sourceId: "source-id",
        rawText: "See https://user:must-not-leak@example.test/article?key=must-not-leak",
        raw: { secret: "must-not-leak", claim: "Source says 5% APY" },
        locator: { url: "https://example.test/article?api_key=must-not-leak" },
      },
    }));
    const result = await f.client.read({
      action: "evidence",
      sourceKey: "source/a",
      itemId: "i/1",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).toContain("Source says 5% APY");
    expect(String(f.http.mock.calls[0]?.[0])).toContain("/sources/source%2Fa/items/i%2F1");
  });
  it("does not return provider/deployment errors or oversized body content", async () => {
    for (const body of [
      new Response("private-url-and-secret", { status: 500 }),
      new Response("private-marker", { headers: { "Content-Length": String(5 * 1024 * 1024) } }),
      Response.json({ wrongShape: true }),
    ]) {
      const f = fixture(() => body);
      const result = await f.client.read({ action: "sources" });
      expect(result.state).toBe("unavailable");
      expect(result.data).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(f.http).toHaveBeenCalledOnce();
    }
  });
});

describe("operator recommendation feedback", () => {
  it("writes to the exact recommendation once, preserves a mixed judgment, then rereads detail and profile", async () => {
    const saved: unknown[] = [];
    const order: string[] = [];
    const f = fixture((path, init) => {
      order.push(`${init?.method} ${path}`);
      if (path === "/intelligence/preferences/profile") return profile;
      if (init?.method === "POST") {
        expect(path).toBe("/intelligence/recommendations/rec-exact/feedback");
        const input = JSON.parse(String(init.body));
        const feedback = {
          id: "feedback-exact",
          targetId: "rec-exact",
          sentiment: "negative",
          comment: input.note,
          reasons: input.reasons,
        };
        saved.push(feedback);
        return { feedback, preferenceProfile: profile };
      }
      return { ...detail, feedback: saved };
    });
    const input = {
      recommendationId: "rec-exact",
      operatorQuote: "I like this vault, but the net economics are missing.",
      direction: "down" as const,
      reasons: [{ category: "actionability" as const, reasonCode: "too_vague" as const }],
      note: "Candidate remains liked; criticism concerns missing net economics.",
      subject: { kind: "recommendation", key: "rec-exact" },
    };
    const [result, replay] = await Promise.all([
      f.client.feedback(input, "owner-turn"),
      f.client.feedback(input, "owner-turn"),
    ]);
    expect(result).toMatchObject({
      state: "recorded",
      recommendationId: "rec-exact",
      feedback: { id: "feedback-exact", sentiment: "negative" },
      preferenceProfile: { version: 0, status: "uninitialized" },
    });
    expect(replay).toMatchObject({ state: "recorded", replayed: true });
    expect(order.filter((request) => request.startsWith("POST"))).toHaveLength(1);
    expect(order.slice(0, 4)).toEqual([
      "GET /intelligence/recommendations/rec-exact",
      "POST /intelligence/recommendations/rec-exact/feedback",
      "GET /intelligence/recommendations/rec-exact",
      "GET /intelligence/preferences/profile",
    ]);
    expect(JSON.stringify(result)).toContain(input.operatorQuote);
    expect(JSON.stringify(result)).not.toContain("good_fit");
  });
  it("recovers an ambiguous POST by rereading without repeating it", async () => {
    const saved: unknown[] = [];
    const f = fixture((path, init) => {
      if (path === "/intelligence/preferences/profile") return profile;
      if (init?.method === "POST") {
        saved.push({ id: "f", targetId: "rec-exact", comment: JSON.parse(String(init.body)).note });
        throw new Error("lost response with private-secret");
      }
      return { ...detail, feedback: saved };
    });
    expect(
      await f.client.feedback(
        {
          recommendationId: "rec-exact",
          operatorQuote: "I like the recommendation",
          direction: "up",
          reasons: [{ category: "relevance", reasonCode: "relevant" }],
        },
        "owner-turn",
      ),
    ).toMatchObject({ state: "recorded", resultConfirmed: false });
    expect(f.http.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not post when a detail response has a different target identity", async () => {
    const f = fixture(() => ({ ...detail, recommendation: { ...rec, id: "another" } }));
    await expect(
      f.client.feedback(
        {
          recommendationId: "rec-exact",
          operatorQuote: "I like it",
          direction: "up",
          reasons: [{ category: "relevance", reasonCode: "relevant" }],
        },
        "owner-turn",
      ),
    ).rejects.toThrow("mismatch");
    expect(f.http.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});

it("reads objective policy only and excludes canonical holdings/actuals", async () => {
  const f = fixture((path) => {
    expect(path).toBe("/asset-sets/USD/objective");
    return {
      assetSet: { key: "USD", label: "Stablecoins" },
      objective: {
        id: "objective-v",
        version: 2,
        metricKey: "current_blended_apr",
        metricUnit: "fraction_per_year",
        bands: [{ key: "good", lowerBoundDecimal: "0.04", upperBoundDecimal: "0.05" }],
      },
      current: { valueDecimal: "hidden-actual", includedPositionIds: ["hidden-position"] },
    };
  });
  const result = await f.client.read({ action: "objectives", assetSetKey: "USD" });
  expect(result).toMatchObject({
    state: "available",
    data: {
      actualsIncluded: false,
      objective: { version: 2, bands: [{ lowerBoundDecimal: "0.04" }] },
    },
  });
  expect(JSON.stringify(result)).not.toContain("hidden-");
});

it("keeps a dead refresh job distinct from an older running sync without exposing its raw error", async () => {
  const f = fixture(() => ({
    items: [
      {
        key: "pools",
        latestSync: { id: "old", status: "running", startedAtMs: now - 10000, error: null },
        latestRefreshJob: {
          id: "job",
          status: "dead",
          attempts: 3,
          maxAttempts: 3,
          updatedAtMs: now,
          lastError: "private-provider-error",
        },
        activeRefreshJob: null,
      },
    ],
    adapters: [],
  }));
  const result = await f.client.read({ action: "sources" });
  expect(result).toMatchObject({
    data: {
      items: [
        {
          latestSync: { status: "running" },
          latestRefreshJob: {
            status: "dead",
            attempts: 3,
            updatedAtMs: now,
            failureClass: "refresh_job_failed",
          },
          activeRefreshJob: null,
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-provider-error");
});

it("summarizes large approved universes without returning selectors or private metadata", async () => {
  const f = fixture(() => ({
    generatedAtMs: now,
    activeVersionIds: ["v"],
    sets: [
      {
        identity: { id: "set", key: "USD" },
        version: { id: "v", version: 1, label: "Stablecoins", intelligenceEnabled: true },
        memberships: Array.from({ length: 2000 }, () => ({
          mode: "include",
          selector: "private-marker",
        })),
      },
    ],
    counts: { sets: 1 },
  }));
  const result = await f.client.read({ action: "universe" });
  expect(result).toMatchObject({
    state: "available",
    data: {
      sets: [
        {
          identity: { key: "USD" },
          version: { id: "v" },
          membershipCounts: { total: 2000, include: 2000, exclude: 0 },
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-marker");
  expect(JSON.stringify(result).length).toBeLessThan(1000);
});

it("reads bounded scoped APR-only Discovery without claiming screening or publication eligibility", async () => {
  const f = fixture((path) => {
    const query = new URL(path, "http://fixture.test").searchParams;
    expect(query.get("sourceKey")).toBe("lido-steth");
    expect(query.get("sort")).toBe("updated");
    expect(query.get("limit")).toBe("10");
    return {
      items: [
        {
          opportunityId: "apr-case",
          positionId: "apr-candidate",
          protocol: "Lido",
          apr: {
            id: "apr-metric",
            valueDecimal: "0.034567890123456789",
            unit: "fraction_per_year",
            observedAtMs: now,
          },
          apy: null,
        },
      ],
      page: { total: 1, count: 1, nextCursor: null, hasMore: false },
      filters: { sort: "updated", direction: "desc" },
    };
  });
  const result = await f.client.read({ action: "discovery", sourceKey: "lido-steth" });
  expect(result).toMatchObject({
    state: "available",
    data: {
      screened: false,
      publicationAuthorization: false,
      items: [
        {
          opportunityId: "apr-case",
          apr: { valueDecimal: "0.034567890123456789", unit: "fraction_per_year" },
          apy: null,
        },
      ],
      page: { nextCursor: null },
    },
  });
  expect(f.http).toHaveBeenCalledOnce();
});
