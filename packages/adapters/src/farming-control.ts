import type {
  FarmingControlAccounting,
  FarmingControlEntity,
  FarmingControlEntityCatalog,
  FarmingControlEntityCatalogInput,
  FarmingControlEntityKind,
  FarmingControlEntityRead,
  FarmingControlEntitySelection,
  FarmingControlHarvest,
  FarmingControlPortfolio,
  FarmingControlPortfolioInput,
  FarmingControlPositionHistory,
  FarmingControlPositionDetail,
  FarmingControlPositionDetailInput,
  FarmingControlPositionHistoryInput,
  FarmingControlRisk,
  FarmingControlRiskReview,
  FarmingControlRiskResearch,
  FarmingControlRiskReviewInput,
  FarmingControlSection,
  FarmingControlYieldEvidence,
} from "@rakazo/contracts";
import {
  FarmingControlAccountingMonthSchema,
  FarmingControlAccountingTotalsSchema,
  FarmingControlAlertSchema,
  FarmingControlAprHistoryPointSchema,
  FarmingControlAssessmentSchema,
  FarmingControlEntityCatalogInputSchema,
  FarmingControlEntitySelectionSchema,
  FarmingControlHarvestContributionSchema,
  FarmingControlHarvestTotalsSchema,
  FarmingControlHistoryPointSchema,
  FarmingControlMonitorSchema,
  FarmingControlPeriodEarningsContributionSchema,
  FarmingControlPortfolioInputSchema,
  FarmingControlPortfolioScopeSchema,
  FarmingControlPortfolioTotalsSchema,
  FarmingControlPositionSchema,
  FarmingControlPositionDetailInputSchema,
  FarmingControlRealizedPerformanceSchema,
  FarmingControlRiskReviewInputSchema,
  FarmingControlMonitoringEvidenceSchema,
  FarmingControlWalletAttributionSchema,
  FarmingControlWalletVisibilitySchema,
} from "@rakazo/contracts";
import { isPrivateNetworkHost } from "@rakazo/contracts/network-host";
import * as z from "zod";
import { readFarmingControlPositionTrend } from "./farming-control-position-trend.js";
import type { FarmingControlPositionEarningsPath } from "./farming-control-position-earnings.js";
import { readFarmingControlPositionEarnings } from "./farming-control-position-earnings.js";
import { curveRiskSource, morphoRiskSource, projectRiskExposures } from "./farming-control-risk.js";

import { detailActivitiesSource, detailActivity, detailEntrySource, detailInventorySource, detailTransaction } from "./farming-control-position-detail.js";
import type { PositionDetailPath } from "./farming-control-position-detail.js";

const ms = z.number().int().nonnegative();
// Wallet addresses stay inside this adapter; consumers receive only the hidden count.
const walletVisibilitySource = FarmingControlWalletVisibilitySchema.omit({
  hiddenWalletCount: true,
}).extend({
  hiddenWalletAddresses: z.array(z.string()),
});
// Explicit projections strip all source fields outside the read-only workspace contract.
const portfolioSource = z.object({
  asOfMs: ms,
  scope: FarmingControlPortfolioScopeSchema,
  walletVisibility: walletVisibilitySource,
  walletAttribution: FarmingControlWalletAttributionSchema.optional(),
  cumulative: FarmingControlPortfolioTotalsSchema,
  items: z
    .array(
      FarmingControlPositionSchema.extend({
        dataQuality: FarmingControlPositionSchema.shape.dataQuality.omit({
          valueFreshness: true,
          aprFreshness: true,
        }),
      }),
    )
    .max(2_000),
});
// Project only safe identity/association fields, never adapter configuration or documents.
const entityWalletSource = walletVisibilitySource.extend({
  wallets: z
    .array(
      z.object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        label: z.string().max(4_000),
        positionIds: z.array(z.string().max(500)).max(2_000),
        visible: z.boolean(),
      }),
    )
    .max(2_000)
    .optional(),
});
const entityPortfolioSource = portfolioSource.extend({
  walletAttribution: FarmingControlWalletAttributionSchema.extend({
    partialPositionIds: z.array(z.string()).max(2_000).optional(),
  }).optional(),
  items: z
    .array(
      portfolioSource.shape.items.element.extend({
        addedAtMs: ms.nullable().optional(),
        entryTransactions: z.array(z.object({
          activityKind: z.string(), status: z.string(), occurredAtMs: ms.nullable(),
          activityId: z.string().optional(), sourceId: z.string().optional(), namespace: z.string().optional(), chainId: z.string().nullable().optional(), hash: z.string().optional(),
        })).optional(),
        metadata: z
          .object({
            nodes: z
              .array(
                z.object({
                  id: z.string().max(500),
                  kind: z.string().max(100),
                  label: z.string().max(4_000).nullable(),
                  displayLabel: z.string().max(4_000).nullable().optional(),
                }),
              )
              .max(500),
            relations: z
              .array(
                z.object({
                  fromNodeId: z.string().max(500),
                  relation: z.string().max(100),
                  toNodeId: z.string().max(500),
                }),
              )
              .max(2_000),
          })
          .optional(),
      }),
    )
    .max(2_000),
});
const historySource = z.object({
  asOfMs: ms,
  // Legacy global history may omit the key; selected-set pages must echo it exactly.
  assetSetKey: z.string().nullable().optional(),
  walletVisibility: walletVisibilitySource,
  points: z.array(FarmingControlHistoryPointSchema).max(200),
  page: z.object({ nextCursor: z.string().max(2_000).nullable() }),
});
const harvestSource = FarmingControlHarvestTotalsSchema.extend({
  asOfMs: ms,
  complete: z.boolean(),
  components: z
    .array(z.object({ contributions: z.array(FarmingControlHarvestContributionSchema) }))
    .max(2_000),
  rewardComponents: z.array(FarmingControlHarvestContributionSchema).max(10_000),
});
const riskPositionSource = z.object({
  asOfMs: ms,
  walletVisibility: walletVisibilitySource,
  walletAttribution: z
    .object({
      complete: z.boolean(),
      partialPositionIds: z.array(z.string()).max(2_000).optional(),
    })
    .optional(),
  scope: z.object({ includedPositionIds: z.array(z.string()).max(2_000) }),
  items: z
    .array(
      portfolioSource.shape.items.element.partial().required({
        id: true, label: true, state: true,
      }),
    )
    .max(2_000),
});
const alertsSource = z.object({
  asOfMs: ms,
  retired: z.boolean().optional(),
  items: z.array(FarmingControlAlertSchema).max(100),
});
const assessmentsSource = z.object({
  asOfMs: ms,
  retired: z.boolean().optional(),
  items: z.array(FarmingControlAssessmentSchema).max(100),
});
const monitorsSource = z.array(FarmingControlMonitorSchema).max(1_000);
const accountingSource = z.object({
  asOfMs: ms,
  totals: FarmingControlAccountingTotalsSchema,
  months: z.array(FarmingControlAccountingMonthSchema).max(1_200),
});
const taxSource = z.object({
  enabled: z.boolean(),
  availableInBuild: z.boolean(),
  moduleVersion: z.string(),
  moduleSchemaStatus: z.string(),
  features: z.record(z.string(), z.boolean()),
});
const healthSource = z.object({ status: z.string() });
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const SOURCES = {
  walletVisibility: "/settings/wallet-visibility",
  portfolio: "/positions",
  history: "/portfolio/metrics/projections",
  harvest: "/harvest/outstanding",
  morpho: "/monitoring/morpho?window=1h",
  curve: "/monitoring/curve-risk/pools",
  alerts: "/monitoring/alerts?status=open&limit=100",
  assessments: "/monitoring/assessments?limit=100",
  monitors: "/monitoring/hot/monitors/",
  accounting: "/harvest/accounting",
  tax: "/cashout-tax/capabilities",
  health: "/health",
} as const;
type Source = (typeof SOURCES)[keyof typeof SOURCES];
type HistoryPoint = z.infer<typeof FarmingControlHistoryPointSchema>;
type PositionYieldSource =
  | `/positions/${string}/metrics/apr?${string}`
  | `/positions/${string}/performance?${string}`;
type PositionHistoryPath = PositionYieldSource | FarmingControlPositionEarningsPath;
type ScopedSource = PositionDetailPath | `/monitoring/hot/evidence?${string}` | PositionHistoryPath | `${typeof SOURCES.portfolio | typeof SOURCES.history}?${string}`;
const aprHistorySource = z.object({
  positionId: z.string().max(500),
  asOfMs: ms,
  walletVisibility: walletVisibilitySource,
  points: z.array(FarmingControlAprHistoryPointSchema).max(200),
  page: z.object({ nextCursor: z.string().max(2_000).nullable() }),
  change24h: z.object({
    current: FarmingControlAprHistoryPointSchema.nullable(),
    baseline: FarmingControlAprHistoryPointSchema.nullable(),
    quality: z.object({ staleCurrent: z.boolean().optional() }),
  }),
});
const periodEarningsSource = z.object({
  fromMs: ms,
  toMs: ms,
  walletVisibility: walletVisibilitySource,
  methodology: z.literal("per_position_accrual_measure_delta"),
  byPosition: z.array(FarmingControlPeriodEarningsContributionSchema).max(2_000),
  excludedPositionIds: z.array(z.string().max(500)).max(2_000),
});
const realizedPerformanceSource = FarmingControlRealizedPerformanceSchema.extend({
  walletVisibility: walletVisibilitySource,
  walletAttribution: z.object({ complete: z.boolean() }),
});
const DAY_MS = 86_400_000;
const HISTORY_DEADLINE_MS = 12_000;
const HISTORY_BODY_BUDGET = 8 * 1024 * 1024;
type ReadResult<T> = { data: T; issue: null } | { data: null; issue: string };

/** Configuration is server-owned. No URL, endpoint, query, header or account comes from a caller. */
export function farmingControlBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "FARMING_CONTROL_API_URL must be an HTTP origin without credentials, path, query or fragment",
    );
  }
  if (!isPrivateNetworkHost(url.hostname) && url.hostname !== "host.docker.internal") {
    throw new Error("FARMING_CONTROL_API_URL must use a private network host");
  }
  return url.origin;
}

async function boundedJson(
  response: Response,
  onBytes?: (bytes: number) => void,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("body_limit");
  }
  if (!response.body) throw new Error("invalid_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      onBytes?.(chunk.value.byteLength);
      if (size > MAX_BODY_BYTES) throw new Error("body_limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export function createFarmingControlClient(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const baseUrl = farmingControlBaseUrl(options.baseUrl);
  const http = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const pendingPositionReads = new Map<string, Promise<ReadResult<unknown>>>();
  async function readBody(
    path: Source | ScopedSource,
    limits?: { signal: AbortSignal; onBytes: (bytes: number) => void },
  ): Promise<ReadResult<unknown>> {
    const sourceLabel = path.split("?")[0];
    // Match the native frontend's read budgets for saved scope and portfolio summaries.
    const timeoutMs =
      sourceLabel === "/monitoring/hot/evidence"
        ? 30_000
        : sourceLabel === SOURCES.walletVisibility || sourceLabel === SOURCES.morpho.split("?")[0]
        ? 20_000
        : sourceLabel === SOURCES.portfolio
          ? 15_000
          : TIMEOUT_MS;
    try {
      const response = await http(`${baseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: limits
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), limits.signal])
          : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          data: null,
          issue: `${sourceLabel}: source unavailable (HTTP ${response.status}).`,
        };
      }
      return { data: await boundedJson(response, limits?.onBytes), issue: null };
    } catch {
      return {
        data: null,
        issue: `${sourceLabel}: source unavailable, timed out, or exceeded the response limit.`,
      };
    }
  }
  async function read<T>(
    path: Source | ScopedSource,
    schema: z.ZodType<T>,
    limits?: { signal: AbortSignal; onBytes: (bytes: number) => void },
  ): Promise<ReadResult<T>> {
    // The detail, risk and historical projections request the identical scoped position
    // list on entry. Share only the in-flight body for that exact URL and revision.
    let pending: Promise<ReadResult<unknown>>;
    if (!limits && path.startsWith(SOURCES.portfolio + "?")) {
      pending = pendingPositionReads.get(path) ?? readBody(path).finally(() => pendingPositionReads.delete(path));
      pendingPositionReads.set(path, pending);
    } else {
      pending = readBody(path, limits);
    }
    const result = await pending;
    if (result.issue !== null) return { data: null, issue: result.issue };
    const parsed = schema.safeParse(result.data);
    return parsed.success
      ? { data: parsed.data, issue: null }
      : { data: null, issue: `${path.split("?")[0]}: source response does not match the supported schema.` };
  }
  const meta = (
    asOfMs: number | null,
    sources: string[],
    issues: string[],
    available: boolean,
  ) => ({
    state: !available
      ? ("unavailable" as const)
      : issues.length
        ? ("partial" as const)
        : ("available" as const),
    fetchedAtMs: now(),
    asOfMs,
    sources,
    issues,
  });
  /** Read bounded recent ranges independently so a dense older range cannot starve newer evidence. */
  async function recentHistory(
    toMs: number,
    walletRevision: number | null,
    assetSetKey: string | null,
  ) {
    const fromMs = Math.max(0, toMs - 90 * DAY_MS);
    const start60 = Math.max(0, toMs - 60 * DAY_MS);
    const start30 = Math.max(0, toMs - 30 * DAY_MS);
    const ranges = [
      { fromMs, toMs: Math.max(fromMs, start60 - 1), maxPages: 4 },
      { fromMs: start60, toMs: Math.max(start60, start30 - 1), maxPages: 4 },
      { fromMs: start30, toMs, maxPages: 4 },
      { fromMs: Math.max(0, toMs - DAY_MS), toMs, maxPages: 2 },
    ];
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(HISTORY_DEADLINE_MS)]);
    let bodyBytes = 0;
    const onBytes = (bytes: number) => {
      bodyBytes += bytes;
      if (bodyBytes > HISTORY_BODY_BUDGET) {
        controller.abort();
        throw new Error("history_body_budget");
      }
    };
    const fetched = await Promise.all(
      ranges.map(async (range) => {
        const points: HistoryPoint[] = [];
        let cursor: string | null = null;
        let failed = walletRevision === null;
        let truncated = walletRevision === null;
        const seenCursors = new Set<string>();
        for (
          let page = 0;
          page < range.maxPages && walletRevision !== null;
          page += 1
        ) {
          if (signal.aborted) {
            failed = true;
            truncated = true;
            break;
          }
          const query = new URLSearchParams({
            fromMs: String(range.fromMs),
            toMs: String(range.toMs),
            limit: "200",
          });
          if (cursor) query.set("cursor", cursor);
          if (assetSetKey !== null) {
            query.set("assetSetKey", assetSetKey);
            query.set("sampling", "utc_day_last_with_boundaries");
          }
          query.set("walletVisibility", "visible");
          query.set("walletVisibilityRevision", String(walletRevision));
          const path: ScopedSource = `${SOURCES.history}?${query.toString()}`;
          const response = await read(
            path,
            historySource.refine(
              (value) =>
                value.walletVisibility.revision === walletRevision &&
                (value.assetSetKey ?? null) === assetSetKey,
            ),
            { signal, onBytes },
          );
          if (
            !response.data ||
            response.data.points.some(
              (point) => point.sampledAtMs < range.fromMs || point.sampledAtMs > range.toMs,
            )
          ) {
            failed = true;
            truncated = true;
            break;
          }
          points.push(...response.data.points);
          cursor = response.data.page.nextCursor;
          if (!cursor) break;
          if (seenCursors.has(cursor)) {
            failed = true;
            truncated = true;
            break;
          }
          seenCursors.add(cursor);
          if (page + 1 === range.maxPages) truncated = true;
        }
        points.sort(
          (left, right) =>
            left.sampledAtMs - right.sampledAtMs ||
            left.recordedAtMs - right.recordedAtMs ||
            left.snapshotId.localeCompare(right.snapshotId),
        );
        return {
          points,
          summary: {
            fromMs: range.fromMs,
            toMs: range.toMs,
            state:
              failed && points.length === 0
                ? ("unavailable" as const)
                : truncated
                  ? ("partial" as const)
                  : ("available" as const),
            truncated,
            observedPointCount: points.length,
            firstSampleAtMs: points[0]?.sampledAtMs ?? null,
            lastSampleAtMs: points.at(-1)?.sampledAtMs ?? null,
          },
        };
      }),
    );
    const unique = new Map<string, HistoryPoint>();
    for (const range of fetched)
      for (const point of range.points) unique.set(point.snapshotId, point);
    const all = [...unique.values()].sort(
      (left, right) =>
        left.sampledAtMs - right.sampledAtMs ||
        left.recordedAtMs - right.recordedAtMs ||
        left.snapshotId.localeCompare(right.snapshotId),
    );
    const selected = new Map<string, HistoryPoint>();
    const perDay = new Map<number, HistoryPoint>();
    for (const point of all) perDay.set(Math.floor(point.sampledAtMs / DAY_MS), point);
    for (const point of perDay.values()) selected.set(point.snapshotId, point);
    // Preserve actual range boundary samples too; no value or timestamp is interpolated.
    for (const range of fetched) {
      const first = range.points[0];
      const last = range.points.at(-1);
      if (first) selected.set(first.snapshotId, first);
      if (last) selected.set(last.snapshotId, last);
    }
    const points = [...selected.values()].sort(
      (left, right) =>
        left.sampledAtMs - right.sampledAtMs ||
        left.recordedAtMs - right.recordedAtMs ||
        left.snapshotId.localeCompare(right.snapshotId),
    );
    const retrievalComplete = fetched.every((range) => !range.summary.truncated);
    return {
      points,
      range: {
        fromMs,
        toMs,
        windowDays: 90 as const,
        sampling: "last_saved_sample_per_utc_day_with_boundary_points" as const,
        observedPointCount: all.length,
        returnedPointCount: points.length,
        retrievalComplete,
        windows: fetched.map((range) => range.summary),
      },
      issues: walletRevision === null || retrievalComplete
        ? []
        : [
            "Recent history is partial: at least one date window could not verify the requested scope, exceeded the page, time or response budget, or was unavailable. Displayed dates are actual saved samples; gaps are not reconstructed.",
          ],
    };
  }
  async function portfolio(input?: FarmingControlPortfolioInput): Promise<FarmingControlPortfolio> {
    const selected = FarmingControlPortfolioInputSchema.parse(input ?? {});
    const assetSetKey = selected.assetSetKey ?? null;
    const fetchedAtMs = now();
    // Resolve the instance preference once; every current and history GET must apply this revision.
    const settings = await read(SOURCES.walletVisibility, walletVisibilitySource);
    const revision = settings.data?.revision ?? null;
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    if (assetSetKey !== null) query.set("assetSetKey", assetSetKey);
    const [source, history] = await Promise.all([
      revision === null
        ? Promise.resolve<ReadResult<z.infer<typeof portfolioSource>>>({
            data: null,
            issue: settings.issue ?? "Wallet display scope is unavailable.",
          })
        : read(
            `${SOURCES.portfolio}?${query}`,
            portfolioSource.refine(
              (value) =>
                value.walletVisibility.revision === revision &&
                value.scope.assetSetKey === assetSetKey,
            ),
          ),
      recentHistory(fetchedAtMs, revision, assetSetKey),
    ]);
    const included = new Set(source.data?.scope.includedPositionIds ?? []);
    const scopedItems = (source.data?.items ?? []).filter(
      (item) => assetSetKey === null || included.has(item.id),
    );
    const activeItems = scopedItems.filter((item) => item.state === "active");
    const issues = [...(source.issue ? [source.issue] : []), ...history.issues];
    if (source.data?.walletAttribution?.complete === false)
      issues.push("Selected-wallet attribution is incomplete; unknown contributions are not zero.");
    if (
      source.data?.cumulative.coverage.excluded.length ||
      source.data?.cumulative.coverage.earnedExcludedPositionIds.length ||
      source.data?.cumulative.coverage.earnedExcluded.length ||
      source.data?.cumulative.liveEarnedBreakdownUsd.valuationComplete === false ||
      (source.data && activeItems.length > 0 && source.data.cumulative.liveEarnedUsd === null) ||
      activeItems.some(
        (item) => item.current.valueUsd === null || !item.dataQuality.hasObservations,
      )
    )
      issues.push(
        "Portfolio valuation, earnings components or forward projections have incomplete coverage; inspect the component exclusions. Unknown values are not zero.",
      );
    const freshness = (observedAtMs: number | null, maxAgeMs: number, known: boolean) =>
      !known || observedAtMs === null
        ? ("unknown" as const)
        : fetchedAtMs - observedAtMs > maxAgeMs
          ? ("stale" as const)
          : ("current" as const);
    const positions = scopedItems.map((item) => ({
      ...item,
      dataQuality: {
        ...item.dataQuality,
        valueFreshness: freshness(
          item.current.observedAtMs,
          item.dataQuality.maxObservationAgeMs,
          item.current.valueUsd !== null,
        ),
        aprFreshness: freshness(
          item.apr?.observedAtMs ?? item.dataQuality.rateObservedAtMs,
          item.dataQuality.maxObservationAgeMs,
          item.apr?.percentPerYear != null,
        ),
      },
    }));
    if (
      positions.some(
        (item) => item.state === "active" && item.dataQuality.valueFreshness === "stale",
      )
    )
      issues.push("Some position value observations exceed Farming Control's freshness window.");
    if (
      positions.some((item) => item.state === "active" && item.dataQuality.aprFreshness === "stale")
    )
      issues.push(
        "Some APR observations exceed Farming Control's freshness window even where position values are current.",
      );
    return {
      ...meta(
        source.data?.asOfMs ?? null,
        [
          SOURCES.walletVisibility,
          SOURCES.portfolio,
          SOURCES.history,
        ],
        issues,
        source.data !== null,
      ),
      scope: source.data?.scope ?? null,
      walletVisibility: source.data
        ? {
            revision: source.data.walletVisibility.revision,
            active: source.data.walletVisibility.active,
            hiddenWalletCount: source.data.walletVisibility.hiddenWalletAddresses.length,
          }
        : null,
      ...(source.data?.walletAttribution
        ? { walletAttribution: source.data.walletAttribution }
        : {}),
      totals: source.data?.cumulative ?? null,
      positions,
      history: history.points,
      historyTruncated: !history.range.retrievalComplete,
      historyRange: history.range,
    };
  }
  async function harvest(): Promise<FarmingControlHarvest> {
    const source = await read(SOURCES.harvest, harvestSource);
    const issues = source.issue ? [source.issue] : [];
    if (source.data && !source.data.complete)
      issues.push(
        "Outstanding returns have incomplete coverage; fallback and unknown evidence do not authorize execution.",
      );
    if (
      source.data &&
      [
        ...source.data.components.flatMap((item) => item.contributions),
        ...source.data.rewardComponents,
      ].some((item) => item.quality !== "current")
    ) {
      issues.push(
        "Some returns use fallback, unknown, or invalidated evidence; complete coverage does not establish fresh or executable values.",
      );
    }
    return {
      ...meta(source.data?.asOfMs ?? null, [SOURCES.harvest], issues, source.data !== null),
      complete: source.data?.complete ?? null,
      totals: source.data ? FarmingControlHarvestTotalsSchema.parse(source.data) : null,
      contributions: source.data
        ? [
            ...source.data.components.flatMap((item) => item.contributions),
            ...source.data.rewardComponents,
          ]
        : [],
    };
  }
  async function risk(snapshot?: {
    settings: ReadResult<z.infer<typeof walletVisibilitySource>>;
    scoped: ReadResult<z.infer<typeof riskPositionSource>>;
    positionId?: string;
  }): Promise<FarmingControlRisk> {
    const settings = snapshot?.settings ?? await read(SOURCES.walletVisibility, walletVisibilitySource);
    const revision = settings.data?.revision ?? null;
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    const [alerts, assessments, monitors, morpho, curve, scoped] = await Promise.all([
      read(SOURCES.alerts, alertsSource),
      read(SOURCES.assessments, assessmentsSource),
      read(SOURCES.monitors, monitorsSource),
      read(SOURCES.morpho, morphoRiskSource),
      read(SOURCES.curve, curveRiskSource),
      snapshot?.scoped ?? (revision === null
        ? Promise.resolve<ReadResult<z.infer<typeof riskPositionSource>>>({
            data: null,
            issue: "Wallet display scope is unavailable.",
          })
        : read(
            `${SOURCES.portfolio}?${query}`,
            riskPositionSource.refine((p) => p.walletVisibility.revision === revision),
          )),
    ]);
    // Source dashboards are unscoped. Never publish them unless their position joins are fenced by the saved visibility revision.
    const after = await read(SOURCES.walletVisibility, walletVisibilitySource);
    const scopeValid =
      scoped.data !== null && revision !== null && after.data?.revision === revision;
    const active = scopeValid
      ? scoped.data!.items.filter(
          (p) => p.state === "active" && scoped.data!.scope.includedPositionIds.includes(p.id),
        )
      : [];
    const hidden = settings.data?.hiddenWalletAddresses.length !== 0;
    const mixed = new Set(scoped.data?.walletAttribution?.partialPositionIds ?? []);
    const attribution = scoped.data?.walletAttribution;
    const attributionKnown = !hidden || attribution?.complete === true ||
      attribution?.partialPositionIds !== undefined;
    const eligible = attributionKnown ? active.filter((p) =>
      !mixed.has(p.id) && (!snapshot?.positionId || p.id === snapshot.positionId),
    ) : [];
    const projected = projectRiskExposures({
      morpho: morpho.data,
      curve: curve.data,
      positions: eligible,
      nowMs: now(),
    });
    // Join by proven position identity, never by label or token quantity. These
    // marks come from the same scoped /positions response that admitted the card.
    const holdings = new Map(eligible.map((position) => [position.id, position]));
    const fetchedAtMs = now();
    const freshness = (at: number | null, maxAgeMs: number, known: boolean) =>
      !known || at === null || at > fetchedAtMs ? "unknown" as const
        : fetchedAtMs - at > maxAgeMs ? "stale" as const : "current" as const;
    for (const exposure of projected.exposures) {
      if (revision !== null && scoped.data)
        exposure.holdingScope = { walletVisibilityRevision: revision, asOfMs: scoped.data.asOfMs,
          valueBasis: "visible_position_mark_not_sized_protocol_exposure" };
      exposure.positions = exposure.positions.map((linked) => {
        const position = holdings.get(linked.id);
        if (!position?.current || !position.dataQuality) return linked;
        return { ...linked, holding: {
          state: position.state,
          current: position.current,
          apr: position.apr ?? null,
          dataQuality: {
            ...position.dataQuality,
            valueFreshness: freshness(position.current.observedAtMs,
              position.dataQuality.maxObservationAgeMs, position.current.valueUsd !== null),
            aprFreshness: freshness(position.apr?.observedAtMs ?? position.dataQuality.rateObservedAtMs,
              position.dataQuality.maxObservationAgeMs, position.apr?.percentPerYear != null),
          },
        } };
      });
    }
    const coveredCount = new Set(
      projected.exposures.flatMap((card) => card.positions.map((p) => p.id)),
    ).size;
    const issues = [
      alerts.issue,
      assessments.issue,
      monitors.issue,
      morpho.issue,
      curve.issue,
      settings.issue,
      scoped.issue,
      after.issue,
    ].filter((issue): issue is string => issue !== null);
    issues.push(...projected.issues);
    if (!scopeValid)
      issues.push(
        "Risk exposure scope could not be verified; exposure cards are withheld until a fresh read succeeds.",
      );
    if (!attributionKnown || mixed.size)
      issues.push(
        "Combined or unattributed wallet positions are omitted from risk cards because the source risk reads cannot apply wallet attribution.",
      );
    issues.push(
      "This bounded Monitoring view is not complete portfolio risk coverage. Empty results do not establish safety. Monitor health describes runtime readiness, not the safety of positions.",
    );
    if (alerts.data?.retired || assessments.data?.retired)
      issues.push(
        "The generic alerts or assessments surface is retired; current hot-monitor runtime states are listed separately and do not substitute for alert evidence.",
      );
    if (alerts.data?.items.length === 100 || assessments.data?.items.length === 100)
      issues.push("Generic monitoring results may be truncated at 100 records per source.");
    if (
      monitors.data?.some(
        (item) =>
          !item.supervisorReachable ||
          item.health === "degraded" ||
          (item.desiredState === "running" && item.actualState !== "running"),
      )
    )
      issues.push(
        "Some hot monitors are unreachable, degraded, or have not reached their desired running state.",
      );
    const availability = (
      data: { asOfMs: number; retired?: boolean; items: unknown[] } | null,
    ) => ({
      state: !data
        ? ("unavailable" as const)
        : data.retired
          ? ("retired" as const)
          : ("available" as const),
      asOfMs: data?.asOfMs ?? null,
      returnedCount: data?.items.length ?? null,
      truncated: data?.items.length === 100,
    });
    const monitorTime = monitors.data?.length
      ? Math.max(...monitors.data.map((item) => item.asOfMs))
      : null;
    return {
      ...meta(
        monitorTime ?? alerts.data?.asOfMs ?? assessments.data?.asOfMs ?? null,
        [
          SOURCES.walletVisibility,
          SOURCES.portfolio,
          SOURCES.morpho,
          SOURCES.curve,
          SOURCES.alerts,
          SOURCES.assessments,
          SOURCES.monitors,
        ],
        issues,
        morpho.data !== null ||
          curve.data !== null ||
          alerts.data !== null ||
          assessments.data !== null ||
          monitors.data !== null,
      ),
      complete: false,
      exposures: projected.exposures,
      exposureScope: {
        walletVisibilityRevision: scopeValid ? revision : null,
        discovery: !scopeValid
          ? "unavailable"
          : !morpho.data ||
              !curve.data ||
              projected.issues.length ||
              !attributionKnown ||
              mixed.size > 0
            ? "partial"
            : "complete",
        activePositionCount: scopeValid ? active.length : null,
        coveredPositionCount: coveredCount,
        uncoveredPositionCount: scopeValid ? active.length - coveredCount : null,
      },
      alerts: alerts.data?.items ?? [],
      assessments: assessments.data?.items ?? [],
      monitors: monitors.data ?? [],
      sourceAvailability: {
        morpho: {
          ...availability(morpho.data),
          truncated: projected.incomplete.morpho,
        },
        curve: {
          ...availability(curve.data),
          truncated: projected.incomplete.curve,
        },
        alerts: availability(alerts.data),
        assessments: availability(assessments.data),
        monitors: {
          state: monitors.data ? ("available" as const) : ("unavailable" as const),
          asOfMs: monitorTime,
          returnedCount: monitors.data?.length ?? null,
          truncated: false,
        },
      },
    };
  }
  /** One bounded, revision-fenced snapshot is shared by completion and selected-subject reads. */
  async function entitySnapshot(kinds: readonly FarmingControlEntityKind[], positionId?: string) {
    const settings = await read(SOURCES.walletVisibility, entityWalletSource);
    const revision = settings.data?.revision ?? null;
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    const source =
      revision === null
        ? {
            data: null,
            issue: settings.issue ?? "Wallet display scope is unavailable.",
          }
        : await read(
            `${SOURCES.portfolio}?${query}`,
            entityPortfolioSource.refine((value) => value.walletVisibility.revision === revision),
          );
    const issues = [settings.issue, source.issue].filter(
      (issue): issue is string => issue !== null,
    );
    const rows = source.data?.items ?? [];
    const included = new Set(source.data?.scope.includedPositionIds ?? []);
    const visibleRows = rows.filter((item) => included.has(item.id));
    const entities: FarmingControlEntity[] = [];
    if (kinds.includes("position"))
      for (const item of visibleRows)
        entities.push({
          selection: { kind: "position", id: item.id },
          label: item.label?.trim() || item.id,
          detail: item.state,
          aliases: [item.id, ...(item.adapter.key ? [item.adapter.key] : [])],
          positionIds: [item.id],
        });
    if (kinds.includes("wallet") && source.data && settings.data) {
      if (!settings.data.wallets) issues.push("The source did not return its wallet inventory.");
      const hidden = new Set(
        settings.data.hiddenWalletAddresses.map((value) => value.toLowerCase()),
      );
      for (const wallet of settings.data.wallets ?? []) {
        const positionIds = wallet.positionIds.filter((id) => included.has(id));
        if (!wallet.visible || hidden.has(wallet.address.toLowerCase()) || !positionIds.length)
          continue;
        entities.push({
          selection: { kind: "wallet", id: wallet.address.toLowerCase() },
          label: wallet.label.trim() || wallet.address,
          detail: wallet.address,
          aliases: [wallet.address],
          positionIds,
        });
      }
    }
    if (kinds.includes("protocol")) {
      const protocols = new Map<string, FarmingControlEntity>();
      for (const item of visibleRows) {
        if (!item.metadata) {
          issues.push("Protocol associations are unavailable for some positions.");
          continue;
        }
        const linked = new Set(
          item.metadata.relations
            .filter((edge) => edge.fromNodeId === item.id && edge.relation === "uses_protocol")
            .map((edge) => edge.toNodeId),
        );
        for (const node of item.metadata.nodes) {
          if (node.kind !== "protocol" || !linked.has(node.id)) continue;
          const protocol = protocols.get(node.id) ?? {
            selection: { kind: "protocol" as const, id: node.id },
            label: node.displayLabel?.trim() || node.label?.trim() || node.id,
            detail: "Protocol",
            aliases: [node.id],
            positionIds: [],
          };
          if (!protocol.positionIds.includes(item.id)) protocol.positionIds.push(item.id);
          protocols.set(node.id, protocol);
        }
      }
      entities.push(...protocols.values());
    }
    let riskRead: FarmingControlRisk | null = null;
    if (kinds.includes("risk") && source.data) {
      riskRead = await risk({ settings, scoped: source, ...(positionId ? { positionId } : {}) });
      // Both native reads must share the exact saved scope before linking a card.
      if (riskRead.exposureScope.walletVisibilityRevision !== revision) {
        issues.push("Risk discovery did not match the saved wallet scope.");
        riskRead = null;
      } else {
        if (riskRead.exposureScope.discovery !== "complete")
          issues.push("Connected risk discovery is incomplete; an absent card does not establish that its monitor is missing or the position is safe.");
        for (const exposure of riskRead.exposures) {
          const positionIds = exposure.positions.map((position) => position.id);
          if (!positionIds.length || !positionIds.every((id) => included.has(id))) continue;
          entities.push({
            selection: { kind: "risk", id: exposure.id },
            label: exposure.label.trim() || exposure.id,
            detail: exposure.protocol,
            aliases: [exposure.id, exposure.protocol],
            positionIds,
          });
        }
      }
    }
    const uniqueIssues = [...new Set(issues)];
    return {
      ...meta(
        source.data?.asOfMs ?? null,
        [SOURCES.walletVisibility, SOURCES.portfolio, ...(riskRead?.sources ?? [])],
        uniqueIssues,
        source.data !== null,
      ),
      walletVisibilityRevision: source.data ? revision : null,
      entities,
      rows: visibleRows,
      riskRead,
      walletSettings: settings.data,
      attributionComplete: source.data?.walletAttribution?.complete ?? null,
    };
  }
  async function mentionTargets(
    input?: FarmingControlEntityCatalogInput,
  ): Promise<FarmingControlEntityCatalog> {
    const selected = FarmingControlEntityCatalogInputSchema.parse(input ?? {});
    const snapshot = await entitySnapshot(selected.kinds ?? ["position", "wallet", "protocol"]);
    const query = selected.query?.trim().toLocaleLowerCase("en-US") ?? "";
    const terms = query.split(/\s+/).filter(Boolean);
    const filtered = snapshot.entities.filter(
      (entity) =>
        (!selected.positionId || entity.positionIds.includes(selected.positionId)) &&
        (terms.length === 0 ||
          terms.every((term) =>
            [
              entity.label,
              entity.detail ?? "",
              entity.selection.id,
              ...entity.aliases,
              ...entity.positionIds,
            ].some((value) => value.toLocaleLowerCase("en-US").includes(term)),
          )),
    );
    const { rows: _rows, riskRead: _riskRead, entities: _entities, ...metadata } = snapshot;
    const limit = selected.limit ?? 100;
    return {
      ...metadata,
      entities: filtered.slice(0, limit),
      truncated: filtered.length > limit,
    };
  }
  /** Uses canonical FC calculation services; never reconstructs accounting or averages rates. */
  async function positionYieldEvidence(
    positionId: string,
    revision: number,
    toMs: number,
  ): Promise<FarmingControlYieldEvidence | null> {
    const fromMs = Math.max(0, toMs - 30 * DAY_MS);
    const historyFromMs = Math.max(0, toMs - 90 * DAY_MS);
    const scope = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    const historyQuery = new URLSearchParams(scope);
    historyQuery.set("fromMs", String(historyFromMs));
    historyQuery.set("toMs", String(toMs));
    historyQuery.set("limit", "200");
    const periodQuery = new URLSearchParams(scope);
    periodQuery.set("fromMs", String(fromMs));
    const escapedId = encodeURIComponent(positionId);
    const deadline = AbortSignal.timeout(HISTORY_DEADLINE_MS);
    let bytes = 0;
    const limits = {
      signal: deadline,
      onBytes(count: number) {
        bytes += count;
        if (bytes > HISTORY_BODY_BUDGET) throw new Error("yield_body_budget");
      },
    };
    const [history, period, realized] = await Promise.all([
      read(
        `/positions/${escapedId}/metrics/apr?${historyQuery}`,
        aprHistorySource.refine(
          (value) =>
            value.positionId === positionId &&
            value.walletVisibility.revision === revision &&
            value.points.every(
              (point) => point.observedAtMs >= historyFromMs && point.observedAtMs <= toMs,
            ),
        ),
        limits,
      ),
      // FC's per-position period breakdown is provided by this single shared read service.
      read(
        `/portfolio/metrics/earned/since?${periodQuery}`,
        periodEarningsSource.refine(
          (value) =>
            value.walletVisibility.revision === revision &&
            value.fromMs === fromMs &&
            value.toMs >= fromMs,
        ),
        limits,
      ),
      read(
        `/positions/${escapedId}/performance?${scope}`,
        realizedPerformanceSource.refine((value) => value.walletVisibility.revision === revision),
        limits,
      ),
    ]);
    const after = await read(SOURCES.walletVisibility, walletVisibilitySource);
    // A preference change invalidates all historical joins; do not leak an older visible scope.
    if (after.data?.revision !== revision) return null;
    const issues = [history.issue, period.issue, realized.issue].filter(
      (issue): issue is string => issue !== null,
    );
    issues.push(
      "A held-period average APR is unavailable: saved quoted rates are not earned yield or realized ROI, and rate sources or methodology can change.",
    );
    const contribution = period.data?.excludedPositionIds.includes(positionId)
      ? null
      : (period.data?.byPosition.find((row) => row.positionId === positionId) ?? null);
    if (!contribution)
      issues.push(
        "The rolling 30-day earned contribution is unavailable; absence is not zero. Older confirmed returns may still appear in realized lifetime evidence.",
      );
    if (contribution?.measure === "claimable")
      issues.push(
        "Claimable earned is the saved claimable mark delta plus recorded disposal proceeds. A negative delta alone does not establish a realized loss or complete claim history.",
      );
    if (contribution && ["steth_balance", "base_balance"].includes(contribution.measure))
      issues.push(
        "For native balance measures, baselineUsd and currentUsd preserve FC's field names but contain native quantities; earnedUsd is the USD-valued delta.",
      );
    const rows = history.data?.points ?? [];
    const points =
      rows.length <= 12
        ? rows
        : Array.from({ length: 12 }, (_, i) => rows[Math.floor((i * (rows.length - 1)) / 11)]!);
    if (history.data?.page.nextCursor)
      issues.push(
        "APR history exceeded the 200 saved-point read budget; sampled points are partial and must not be used as a held-period average.",
      );
    const comparisonPoints = [
      ...rows,
      history.data?.change24h.current,
      history.data?.change24h.baseline,
    ].filter((point) => point != null);
    if (
      new Set(
        comparisonPoints.map((point) => `${point.rateType}:${point.source}:${point.window ?? ""}`),
      ).size > 1
    )
      issues.push(
        "Historical APR/APY source or methodology changes make rates incomparable across the whole period.",
      );
    const performance = realized.data
      ? FarmingControlRealizedPerformanceSchema.parse(realized.data)
      : null;
    if (performance) {
      const attributionComplete = realized.data?.walletAttribution.complete === true;
      const withheld: string[] = [];
      for (const [assetSet, bucket] of Object.entries(performance.byAssetSet)) {
        for (const window of ["day", "month", "year", "lifetime"] as const) {
          const cost = bucket.attributedCosts[window];
          // Compare exact decimal text without converting financial values to Number.
          const zeroCost =
            cost !== null && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(cost);
          if (!attributionComplete || !zeroCost) {
            bucket.attributedCosts[window] = null;
            bucket.realizedNet[window] = null;
            bucket.realizedRoiPercent[window] = null;
            withheld.push(`${assetSet.slice(0, 100)}/${window}`);
          }
          if (!attributionComplete) bucket.averageCapitalBasis[window] = null;
        }
        if (!attributionComplete) bucket.currentCapitalBasis = null;
      }
      issues.push(
        "Realized gross values are source asset quantities grouped only by asset set; the grouping does not establish one token or a USD denomination. No cross-asset totals are calculated.",
      );
      if (!attributionComplete)
        issues.push(
          "Realized activity attribution is incomplete; gross quantities are known subtotals only. Costs, net returns, ROI and capital basis are withheld rather than presented as complete performance.",
        );
      if (withheld.length)
        issues.push(
          `Costs, net returns and ROI are withheld for ${withheld.slice(0, 8).join(", ")}${withheld.length > 8 ? " and additional windows" : ""}: FC can group USD execution fees with destination-asset quantities, so nonzero or unverified costs cannot safely be subtracted. Only exact zero-cost windows with complete activity attribution retain canonical net returns.`,
        );
    }
    return {
      positionId,
      asOfMs: Math.max(toMs, period.data?.toMs ?? toMs),
      walletVisibilityRevision: revision,
      heldPeriodAverageAprPercent: null,
      periodEarnings: {
        window: "rolling_30d",
        fromMs,
        toMs: period.data?.toMs ?? null,
        state: contribution ? "available" : "unavailable",
        methodology: "per_position_accrual_measure_delta",
        contribution,
      },
      realizedGrossUnit: "source_asset_quantities_grouped_by_asset_set",
      realized: performance,
      aprHistory: {
        fromMs: historyFromMs,
        toMs,
        state:
          !history.data || rows.length === 0
            ? "unavailable"
            : history.data.page.nextCursor
              ? "partial"
              : "available",
        latestRate: history.data?.change24h.current ?? null,
        latestRateFreshness:
          !history.data?.change24h.current ||
          history.data.change24h.quality.staleCurrent === undefined
            ? "unknown"
            : history.data.change24h.quality.staleCurrent
              ? "stale"
              : "current",
        dayPriorRate: history.data?.change24h.baseline ?? null,
        observedPointCount: rows.length,
        sampling: "bounded_saved_points_with_boundaries",
        points,
        truncated: history.data === null || history.data.page.nextCursor !== null,
      },
      issues,
    };
  }
  async function entity(input: FarmingControlEntitySelection,
    options: { includeRisk?: boolean } = {},
  ): Promise<FarmingControlEntityRead> {
    const selection = FarmingControlEntitySelectionSchema.parse(input);
    const snapshot = await entitySnapshot(
      selection.kind === "position" && options.includeRisk ? ["position", "risk"] : [selection.kind],
      selection.kind === "position" ? selection.id : undefined,
    );
    const found =
      snapshot.entities.find(
        (item) => item.selection.kind === selection.kind && item.selection.id === selection.id,
      ) ?? null;
    const { entities: _entities, rows, riskRead,
      walletSettings: _walletSettings, attributionComplete: _attributionComplete, ...metadata } = snapshot;
    const positionIds = new Set(found?.positionIds ?? []);
    const fetchedAtMs = metadata.fetchedAtMs;
    const freshness = (observedAtMs: number | null, maxAgeMs: number, known: boolean) =>
      !known || observedAtMs === null
        ? ("unknown" as const)
        : fetchedAtMs - observedAtMs > maxAgeMs
          ? ("stale" as const)
          : ("current" as const);
    let withheld = false;
    const positions = rows
      .filter((item) => positionIds.has(item.id))
      .map(({ metadata: _metadata, addedAtMs: _addedAt, entryTransactions: _entries, ...item }) => {
        // Current configuration links do not prove the account attributed to a saved observation.
        const attributed = selection.kind !== "wallet";
        if (!attributed) withheld = true;
        const { projectedRewards, ...withoutProjection } = item;
        return {
          ...withoutProjection,
          ...(attributed && projectedRewards ? { projectedRewards } : {}),
          // The source's visible-scope position mark can include several visible wallets.
          // No position-wide amount is attributed to one selected wallet.
          ...(!attributed
            ? {
                current: {
                  ...item.current,
                  valueUsd: null,
                  capitalBaselineUsd: null,
                },
                apr: null,
              }
            : {}),
          dataQuality: {
            ...item.dataQuality,
            valueFreshness: freshness(
              item.current.observedAtMs,
              item.dataQuality.maxObservationAgeMs,
              attributed && item.current.valueUsd !== null,
            ),
            aprFreshness: freshness(
              item.apr?.observedAtMs ?? item.dataQuality.rateObservedAtMs,
              item.dataQuality.maxObservationAgeMs,
              attributed && item.apr?.percentPerYear != null,
            ),
          },
        };
      });
    if (withheld) {
      metadata.state = "partial";
      metadata.issues = [
        ...metadata.issues,
        "Current wallet links do not establish the account attributed to saved observations; wallet financial amounts, APRs, and yield projections are withheld.",
      ];
    }
    const yieldEvidence =
      found && selection.kind === "position" && metadata.walletVisibilityRevision !== null
        ? await positionYieldEvidence(selection.id, metadata.walletVisibilityRevision, fetchedAtMs)
        : undefined;
    if (found && selection.kind === "position" && !yieldEvidence) {
      return {
        ...metadata,
        state: "unavailable",
        asOfMs: null,
        walletVisibilityRevision: null,
        issues: [
          ...metadata.issues,
          "The saved wallet scope changed or could not be reverified; position evidence is withheld until a fresh read succeeds.",
        ],
        selection,
        selectionStatus: "discovery_unavailable",
        entity: null,
        positions: [],
        risk: null,
      };
    }
    const relatedRisks = found ? (riskRead?.exposures ?? []).filter((item) =>
      selection.kind === "risk" ? item.id === selection.id
        : selection.kind === "position" && item.positions.some((p) => p.id === selection.id),
    ) : [];
    const exposure = relatedRisks.length === 1 ? relatedRisks[0] ?? null : null;
    return {
      ...metadata,
      selection,
      selectionStatus: found
        ? "matched"
        : snapshot.state === "unavailable"
          ? "discovery_unavailable"
          : snapshot.state === "partial"
            ? "discovery_partial"
            : "missing",
      entity: found,
      ...(yieldEvidence ? { yieldEvidence } : {}),
      positions,
      relatedRisks,
      risk:
        exposure && selection.signalKey
          ? {
              ...exposure,
              signals: exposure.signals.filter((signal) => signal.key === selection.signalKey),
            }
          : exposure,
    };
  }
  async function positionDetail(
    input: FarmingControlPositionDetailInput,
  ): Promise<FarmingControlPositionDetail> {
    const selected = FarmingControlPositionDetailInputSchema.parse(input);
    const snapshot = await entitySnapshot(["position", "wallet"]);
    const row = snapshot.rows.find((item) => item.id === selected.positionId);
    const revision = snapshot.walletVisibilityRevision;
    if (!row || revision === null || !snapshot.walletSettings)
      return {
        status: "unavailable",
        reason: "Position could not be verified in the saved wallet scope.",
      };
    const hidden = snapshot.walletSettings.hiddenWalletAddresses.length > 0;
    const wallets = snapshot.entities
      .filter((entity) => entity.selection.kind === "wallet" && entity.positionIds.includes(row.id))
      .map((entity) => ({ address: entity.selection.id, label: entity.label }));
    const visibleAccounts = new Set(wallets.map((wallet) => wallet.address.toLowerCase()));
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    const activityPath: PositionDetailPath = `/positions/${encodeURIComponent(row.id)}/activities?limit=101`;
    const inventoryPath: PositionDetailPath = `/harvest/inventory?${query}`;
    const [ledger, inventory] = await Promise.all([
      read(activityPath, detailActivitiesSource),
      read(
        inventoryPath,
        detailInventorySource.refine((value) => value.walletVisibility.revision === revision),
      ),
    ]);
    const issues = [...snapshot.issues, ledger.issue, inventory.issue].filter(
      (issue): issue is string => issue !== null,
    );
    const rawActivities =
      ledger.data?.items.filter((activity) => activity.positionId === row.id) ?? [];
    const projectedActivities = rawActivities.flatMap((activity) => {
      const projected = detailActivity(activity, hidden, visibleAccounts);
      return projected ? [projected] : [];
    });
    const omittedActivities = projectedActivities.length !== rawActivities.length;
    const activitiesTruncated = (ledger.data?.items.length ?? 0) > 100;
    if (omittedActivities)
      issues.push("Some activities lack exact visible-wallet attribution and are withheld.");
    if (activitiesTruncated) issues.push("Only a bounded recent activity window was read.");
    // Source entry references already passed FC's historical scopedActivity projection.
    const entries = (row.entryTransactions ?? [])
      .flatMap((entry) => {
        const parsed = detailEntrySource.safeParse(entry);
        return parsed.success &&
          parsed.data.status === "confirmed" &&
          parsed.data.activityKind === "position.open" &&
          parsed.data.occurredAtMs !== null &&
          parsed.data.occurredAtMs <= now()
          ? [parsed.data]
          : [];
      })
      .sort((a, b) => a.occurredAtMs! - b.occurredAtMs!);
    const entry = entries[0];
    const opening = entry
      ? {
          id: entry.activityId,
          kind: entry.activityKind,
          status: entry.status,
          occurredAtMs: entry.occurredAtMs,
          recordedAtMs: null,
          sourceId: entry.sourceId,
          evidenceId: null,
          transaction: detailTransaction({
            ...(entry.namespace ? { namespace: entry.namespace } : {}),
            ...(entry.chainId ? { chainId: entry.chainId } : {}),
            hash: entry.hash,
          }),
          amount: null,
          token: null,
        }
      : null;
    const positionRewards =
      inventory.data?.items.filter((item) => item.positionId === row.id) ?? [];
    const scopedRewards = positionRewards.filter(
      (item) =>
        !hidden || (item.account !== null && visibleAccounts.has(item.account.toLowerCase())),
    );
    const rewardsTruncated = scopedRewards.length > 100;
    const rewardsComplete =
      inventory.data !== null &&
      scopedRewards.length > 0 &&
      inventory.data.walletVisibilityCoverage?.complete !== false &&
      scopedRewards.length === positionRewards.length &&
      !rewardsTruncated &&
      scopedRewards.every(
        (item) =>
          item.retrievalComplete === true &&
          item.informational?.quality !== "unknown" &&
          item.informational?.quality !== "invalidated",
      );
    if (!rewardsComplete) issues.push("Claimable reward coverage is incomplete or unavailable.");
    const manual = scopedRewards.some(
      (item) => BigInt(item.reward.amountRaw) > 0n && item.informational?.quality !== "invalidated",
    );
    // These exact registered adapters declare automatic compounding in their
    // canonical protocol calculation methodology. Embedded yield alone does not.
    const auto =
      row.adapter.key === "beefy-cow-clm-vault" || row.adapter.key === "mellow-earn-vault";
    const harvestingEvidence = [
      ...(auto
        ? ["The registered position adapter declares automatic compounding into vault shares."]
        : []),
      ...(manual
        ? [
            "Saved inventory contains a separate positive claimable reward balance; execution readiness is independent.",
          ]
        : []),
    ];
    if (auto && !rewardsComplete)
      issues.push(
        "Automatic compounding is established, but incomplete reward coverage cannot rule out separate claimable rewards.",
      );
    const after = await read(SOURCES.walletVisibility, walletVisibilitySource);
    if (after.data?.revision !== revision)
      return {
        status: "unavailable",
        reason: "Wallet visibility changed during the read. Reread the position.",
      };
    return {
      status: "matched",
      positionId: row.id,
      label: row.label ?? row.id,
      lifecycle: row.state,
      fetchedAtMs: now(),
      asOfMs: snapshot.asOfMs,
      walletVisibilityRevision: revision,
      wallets,
      walletsComplete: snapshot.walletSettings.wallets !== undefined,
      opening,
      activities: {
        state: !ledger.data
          ? "unavailable"
          : omittedActivities || activitiesTruncated
            ? "partial"
            : "available",
        items: projectedActivities.slice(0, 100),
        complete: ledger.data !== null && !omittedActivities && !activitiesTruncated,
        truncated: activitiesTruncated,
      },
      rewards: {
        state: !inventory.data ? "unavailable" : rewardsComplete ? "available" : "partial",
        complete: rewardsComplete,
        truncated: rewardsTruncated,
        items: scopedRewards
          .slice(0, 100)
          .map((item) => ({
            id: item.id,
            symbol: item.reward.symbol,
            token: item.reward.token,
            amount: item.reward.amount,
            observedAtMs: item.informational?.quantityObservedAtMs ?? item.observedAtMs,
            sourceObservationId: item.sourceObservationId,
            quality: item.informational?.quality ?? "unknown",
            readiness: item.informational?.readiness ?? "unknown",
          })),
      },
      harvesting: {
        mode: auto ? (manual ? "mixed" : "auto") : manual ? "manual" : "unknown",
        evidence: harvestingEvidence,
      },
      sources: [...snapshot.sources, activityPath.split("?")[0]!, "/harvest/inventory"],
      issues: [...new Set(issues)].slice(0, 100),
    };
  }
  async function positionHistory(input: FarmingControlPositionHistoryInput): Promise<FarmingControlPositionHistory> {
    const snapshot = await entitySnapshot(["position"]);
    const row = snapshot.rows.find((item) => item.id === input.positionId);
    const revision = snapshot.walletVisibilityRevision;
    if (!row || revision === null) return { status: "unavailable", reason: "Position could not be verified in the saved wallet scope." };
    const toMs = now();
    const entries = (row.entryTransactions ?? []).filter(
      (entry) => entry.status === "confirmed" && entry.occurredAtMs !== null && entry.occurredAtMs <= toMs,
    ).sort((a, b) => a.occurredAtMs! - b.occurredAtMs!);
    const open = entries.find((entry) => entry.activityKind === "position.open");
    const deposit = entries.find((entry) => entry.activityKind === "deposit" || entry.activityKind === "position.deposit_reference");
    const tracked = row.addedAtMs != null && row.addedAtMs <= toMs ? row.addedAtMs : null;
    const startEvidence: Extract<FarmingControlPositionHistory, { status: "matched" }>["startEvidence"] =
      open ? { kind: "confirmed_open", atMs: open.occurredAtMs }
      : deposit && (tracked === null || deposit.occurredAtMs! < tracked)
        ? { kind: "confirmed_deposit", atMs: deposit.occurredAtMs }
        : tracked !== null ? { kind: "tracking_started", atMs: tracked }
        : { kind: "unknown", atMs: null };
    const period = input.period ?? "since_opening";
    const windowStart = period === "since_opening" ? 0 : Math.max(0, toMs - { "7d": 7, "30d": 30, "90d": 90 }[period] * DAY_MS);
    const fromMs = Math.max(windowStart, startEvidence.atMs ?? 0);
    const deadline = AbortSignal.timeout(40_000);
    let bytes = 0;
    const boundedRead = <T>(path: PositionHistoryPath, schema: z.ZodType<T>) => read(path, schema, {
      signal: deadline,
      onBytes(size) {
        bytes += size;
        if (bytes > 24 * 1024 * 1024) throw new Error("Position history response budget exceeded.");
      },
    });
    const args = { read: boundedRead, positionId: row.id, walletVisibilityRevision: revision, fromMs, toMs };
    const [trend, initialEarnings] = await Promise.all([
      readFarmingControlPositionTrend(args),
      fromMs ? readFarmingControlPositionEarnings(args) : Promise.resolve(null),
    ]);
    if (startEvidence.kind === "unknown" && trend.earliestRate && period === "since_opening") {
      startEvidence.kind = "first_saved_rate";
      startEvidence.atMs = trend.earliestRate.observedAtMs;
    }
    const earnings = initialEarnings ?? (startEvidence.atMs && !fromMs
      ? await readFarmingControlPositionEarnings({ ...args, fromMs: startEvidence.atMs }) : null);
    const after = await read(SOURCES.walletVisibility, walletVisibilitySource);
    if (after.data?.revision !== revision) return { status: "unavailable", reason: "Wallet visibility changed during the read. Reread the position." };
    return { status: "matched", positionId: row.id, label: row.label ?? row.id, lifecycle: row.state, period, startEvidence,
      walletVisibilityRevision: revision, requestedThroughMs: toMs, trend, earnings };
  }
  async function riskReview(input?: FarmingControlRiskReviewInput): Promise<FarmingControlRiskReview> {
    const selection = FarmingControlRiskReviewInputSchema.parse(input ?? {});
    const window = selection.window ?? "7d";
    const query = new URLSearchParams({ window });
    if (selection.monitorKey) query.set("monitorKey", selection.monitorKey);
    const path = `/monitoring/hot/evidence?${query}` as const;
    const result = await read(path, FarmingControlMonitoringEvidenceSchema.refine((value) => value.window === window));
    if (!result.data) return {
      ...meta(null, [path], [result.issue], false),
      selectionStatus: "unavailable",
      exposureAssociationStatus: "not_requested",
      linkedExposure: null,
      evidence: null,
    };
    const items = selection.monitorKey
      ? result.data.items.filter((item) => item.monitorKey === selection.monitorKey)
      : result.data.items;
    const issues: string[] = [];
    let exposureAssociationStatus: FarmingControlRiskReview["exposureAssociationStatus"] = "not_requested";
    let linkedExposure: FarmingControlRiskReview["linkedExposure"] = null;
    if (selection.monitorKey && items.length) {
      const holdings = await risk();
      linkedExposure = holdings.exposures.find((item) => item.monitorKey === selection.monitorKey) ?? null;
      exposureAssociationStatus = linkedExposure?.positions.length ? "matched_visible_holding"
        : holdings.exposureScope.discovery === "unavailable" ? "unavailable" : "unproven";
      if (!linkedExposure) issues.push("Visible holding impact is not established for this monitor. An absent wallet-scoped card does not prove zero exposure or a watch-only subject.");
    }
    if (selection.monitorKey && !items.length)
      issues.push("The selected monitor is absent from the desired-running Monitoring universe; this does not establish safety or prove that the monitor does not exist.");
    return {
      ...meta(result.data.asOfMs, [path], issues, true),
      state: issues.length || items.some((item) =>
        item.current.status !== "live" || item.history.status !== "ready" || item.history.truncated
      ) ? "partial" : "available",
      selectionStatus: selection.monitorKey ? items.length ? "matched" : "absent_subject" : "all_subjects",
      evidence: { ...result.data, items },
      exposureAssociationStatus,
      linkedExposure,
    };
  }
  async function accounting(): Promise<FarmingControlAccounting> {
    const [source, tax] = await Promise.all([
      read(SOURCES.accounting, accountingSource),
      read(SOURCES.tax, taxSource),
    ]);
    const issues = [source.issue, tax.issue].filter((issue): issue is string => issue !== null);
    return {
      ...meta(
        source.data?.asOfMs ?? null,
        [SOURCES.accounting, SOURCES.tax],
        issues,
        source.data !== null,
      ),
      totals: source.data?.totals ?? null,
      months: source.data?.months ?? [],
      tax: {
        state: !tax.data
          ? "unavailable"
          : tax.data.enabled && tax.data.availableInBuild
            ? "enabled"
            : "disabled",
        moduleVersion: tax.data?.moduleVersion ?? null,
        moduleSchemaStatus: tax.data?.moduleSchemaStatus ?? null,
        features: tax.data?.features ?? {},
      },
    };
  }
  return {
    mentionTargets,
    positionHistory,
    positionDetail,
    entity,
    portfolio,
    harvest,
    risk,
    riskReview,
    async riskResearch(): Promise<FarmingControlRiskResearch> {
      const { readFarmingControlRiskResearch } = await import("./farming-control-risk-research.js");
      return readFarmingControlRiskResearch();
    },
    accounting,
    async status() {
      const source = await read(SOURCES.health, healthSource);
      return {
        configured: true,
        readOnly: true as const,
        connection: source.data ? ("connected" as const) : ("unavailable" as const),
        fetchedAtMs: now(),
      };
    },
    read(section: Exclude<FarmingControlSection, "intelligence">, input?: FarmingControlPortfolioInput) {
      return section === "portfolio" ? portfolio(input) : { harvest, risk, accounting }[section]();
    },
  };
}
export type FarmingControlClient = ReturnType<typeof createFarmingControlClient>;
