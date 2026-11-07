import type {
  FarmingControlAccounting,
  FarmingControlHarvest,
  FarmingControlPortfolio,
  FarmingControlPortfolioInput,
  FarmingControlRisk,
  FarmingControlSection,
} from "@rakazo/contracts";
import {
  FarmingControlAccountingMonthSchema,
  FarmingControlAccountingTotalsSchema,
  FarmingControlAlertSchema,
  FarmingControlAssessmentSchema,
  FarmingControlHarvestContributionSchema,
  FarmingControlHarvestTotalsSchema,
  FarmingControlHistoryPointSchema,
  FarmingControlMonitorSchema,
  FarmingControlPortfolioInputSchema,
  FarmingControlPortfolioScopeSchema,
  FarmingControlPortfolioTotalsSchema,
  FarmingControlPositionSchema,
  FarmingControlWalletAttributionSchema,
  FarmingControlWalletVisibilitySchema,
} from "@rakazo/contracts";
import { isPrivateNetworkHost } from "@rakazo/contracts/network-host";
import * as z from "zod";
import { curveRiskSource, morphoRiskSource, projectRiskExposures } from "./farming-control-risk.js";

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
const historySource = z.object({
  asOfMs: ms,
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
      partialPositionIds: z.array(z.string()).max(2_000),
    })
    .optional(),
  scope: z.object({ includedPositionIds: z.array(z.string()).max(2_000) }),
  items: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().nullable(),
        state: z.string(),
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
type ScopedSource = `${typeof SOURCES.portfolio | typeof SOURCES.history}?${string}`;
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
  async function read<T>(
    path: Source | ScopedSource,
    schema: z.ZodType<T>,
    limits?: { signal: AbortSignal; onBytes: (bytes: number) => void },
  ): Promise<ReadResult<T>> {
    const sourceLabel = path.split("?")[0];
    // Match the native frontend's read budgets for saved scope and portfolio summaries.
    const timeoutMs =
      sourceLabel === SOURCES.walletVisibility || sourceLabel === SOURCES.morpho.split("?")[0]
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
      const parsed = schema.safeParse(await boundedJson(response, limits?.onBytes));
      if (!parsed.success)
        return {
          data: null,
          issue: `${sourceLabel}: source response does not match the supported schema.`,
        };
      return { data: parsed.data, issue: null };
    } catch {
      return {
        data: null,
        issue: `${sourceLabel}: source unavailable, timed out, or exceeded the response limit.`,
      };
    }
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
    assetSetScoped: boolean,
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
        let failed = walletRevision === null || assetSetScoped;
        let truncated = walletRevision === null || assetSetScoped;
        const seenCursors = new Set<string>();
        for (
          let page = 0;
          page < range.maxPages && !assetSetScoped && walletRevision !== null;
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
          query.set("walletVisibility", "visible");
          query.set("walletVisibilityRevision", String(walletRevision));
          const path: ScopedSource = `${SOURCES.history}?${query.toString()}`;
          const response = await read(
            path,
            historySource.refine((value) => value.walletVisibility.revision === walletRevision),
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
      issues: assetSetScoped
        ? [
            "Saved portfolio history is available for all Asset Sets only; no global history is substituted for the selected set.",
          ]
        : walletRevision === null
          ? []
          : retrievalComplete
            ? []
            : [
                "Recent history is partial: at least one date window exceeded the page, time or response budget, or was unavailable. Displayed dates are actual saved samples; gaps are not reconstructed.",
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
                (value.scope.assetSetKey ?? "").toLowerCase() === (assetSetKey ?? "").toLowerCase(),
            ),
          ),
      recentHistory(fetchedAtMs, revision, assetSetKey !== null),
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
          ...(assetSetKey === null ? [SOURCES.history] : []),
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
  async function risk(): Promise<FarmingControlRisk> {
    const settings = await read(
      SOURCES.walletVisibility,
      walletVisibilitySource,
    );
    const revision = settings.data?.revision ?? null;
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(revision),
    });
    const [alerts, assessments, monitors, morpho, curve, scoped] =
      await Promise.all([
        read(SOURCES.alerts, alertsSource),
        read(SOURCES.assessments, assessmentsSource),
        read(SOURCES.monitors, monitorsSource),
        read(SOURCES.morpho, morphoRiskSource),
        read(SOURCES.curve, curveRiskSource),
        revision === null
          ? Promise.resolve<ReadResult<z.infer<typeof riskPositionSource>>>({
              data: null,
              issue: "Wallet display scope is unavailable.",
            })
          : read(
              `${SOURCES.portfolio}?${query}`,
              riskPositionSource.refine(
                (p) => p.walletVisibility.revision === revision,
              ),
            ),
      ]);
    // Source dashboards are unscoped. Never publish them unless their position joins are fenced by the saved visibility revision.
    const after = await read(SOURCES.walletVisibility, walletVisibilitySource);
    const scopeValid =
      scoped.data !== null &&
      revision !== null &&
      after.data?.revision === revision;
    const active = scopeValid
      ? scoped.data!.items.filter(
          (p) =>
            p.state === "active" &&
            scoped.data!.scope.includedPositionIds.includes(p.id),
        )
      : [];
    const hidden = settings.data?.hiddenWalletAddresses.length !== 0;
    const mixed = new Set(
      scoped.data?.walletAttribution?.partialPositionIds ?? [],
    );
    const attributionKnown =
      !hidden || scoped.data?.walletAttribution !== undefined;
    const eligible = attributionKnown
      ? active.filter((p) => !mixed.has(p.id))
      : [];
    const projected = projectRiskExposures({
      morpho: morpho.data,
      curve: curve.data,
      positions: eligible,
      nowMs: now(),
    });
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
    if (
      alerts.data?.items.length === 100 ||
      assessments.data?.items.length === 100
    )
      issues.push(
        "Generic monitoring results may be truncated at 100 records per source.",
      );
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
        uncoveredPositionCount: scopeValid
          ? active.length - coveredCount
          : null,
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
          state: monitors.data
            ? ("available" as const)
            : ("unavailable" as const),
          asOfMs: monitorTime,
          returnedCount: monitors.data?.length ?? null,
          truncated: false,
        },
      },
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
    portfolio,
    harvest,
    risk,
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
    read(section: FarmingControlSection, input?: FarmingControlPortfolioInput) {
      return section === "portfolio" ? portfolio(input) : { harvest, risk, accounting }[section]();
    },
  };
}
export type FarmingControlClient = ReturnType<typeof createFarmingControlClient>;
