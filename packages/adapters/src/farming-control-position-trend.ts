import type {
  FarmingControlPositionTrend,
  FarmingControlPositionTrendPoint,
} from "@rakazo/contracts";
import { FarmingControlPositionTrendPointSchema } from "@rakazo/contracts";
import * as z from "zod";

const ms = z.number().int().nonnegative();
const pageSchema = z.object({
  positionId: z.string().max(500),
  asOfMs: ms,
  order: z.literal("observed_at_ascending"),
  walletVisibility: z.object({ revision: ms }),
  points: z.array(FarmingControlPositionTrendPointSchema).max(1_000),
  page: z.object({ nextCursor: z.string().min(1).max(2_000).nullable() }),
  change24h: z.object({
    current: FarmingControlPositionTrendPointSchema.nullable(),
    quality: z.object({ staleCurrent: z.boolean().optional() }),
  }),
});
type Read = <T>(
  path: `/positions/${string}/metrics/apr?${string}`,
  schema: z.ZodType<T>,
) => Promise<{ data: T; issue: null } | { data: null; issue: string }>;
type Month = FarmingControlPositionTrend["months"][number];
const MAX_MONTHS = 240;
const DEFAULT_MAX_PAGES = 64;

function monthStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextMonth(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
function methodology(point: FarmingControlPositionTrendPoint): string {
  return JSON.stringify([point.rateType, point.source, point.window, point.adapterKey]);
}
/** Compare exact signed decimal/scientific strings without financial floating point. */
function compareDecimal(left: string, right: string): number {
  function parts(value: string) {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value)!;
    const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
    return {
      digits,
      sign: digits.length === 0 ? 0 : match[1] === "-" ? -1 : 1,
      magnitude: BigInt(digits.length) + BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length),
    };
  }
  const a = parts(left);
  const b = parts(right);
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  if (a.magnitude !== b.magnitude) return (a.magnitude < b.magnitude ? -1 : 1) * a.sign;
  const length = Math.max(a.digits.length, b.digits.length);
  const x = a.digits.padEnd(length, "0");
  const y = b.digits.padEnd(length, "0");
  return (x < y ? -1 : x > y ? 1 : 0) * a.sign;
}
function earlier(a: FarmingControlPositionTrendPoint, b: FarmingControlPositionTrendPoint) {
  return (
    a.observedAtMs < b.observedAtMs ||
    (a.observedAtMs === b.observedAtMs && a.observationId < b.observationId)
  );
}

/**
 * Reads the native saved-rate ledger under one saved wallet visibility revision.
 * The caller injects the existing bounded HTTP reader (including shared deadline/byte budget)
 * and must recheck the revision before exposing the combined entity read.
 */
export async function readFarmingControlPositionTrend(options: {
  read: Read;
  positionId: string;
  walletVisibilityRevision: number;
  fromMs: number;
  toMs: number;
  maxPages?: number;
}): Promise<FarmingControlPositionTrend> {
  const { read, positionId, walletVisibilityRevision, fromMs, toMs } = options;
  if (
    !positionId ||
    positionId.length > 500 ||
    !Number.isSafeInteger(walletVisibilityRevision) ||
    walletVisibilityRevision < 0 ||
    !Number.isSafeInteger(fromMs) ||
    fromMs < 0 ||
    !Number.isSafeInteger(toMs) ||
    toMs < fromMs ||
    toMs > 8_640_000_000_000_000
  )
    throw new TypeError("Invalid saved position trend range or identity");
  const requestedPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(requestedPages) || requestedPages < 1)
    throw new TypeError("Invalid trend page budget");
  const maxPages = Math.min(256, requestedPages);
  const issues = new Set<string>();
  const methods = new Set<string>();
  const versions = new Set<string>();
  const windows = new Set<string | null>();
  const seen = new Set<string>();
  const months: Month[] = [];
  const monthMethods = new Map<string, Set<string>>();
  const monthVersions = new Map<string, Set<string>>();
  let pagesRead = 0;
  let earliestRate: FarmingControlPositionTrendPoint | null = null;
  let latestRate: FarmingControlPositionTrendPoint | null = null;
  let latestRateFreshness: FarmingControlPositionTrend["latestRateFreshness"] = "unknown";
  let discoveryComplete = false;
  let discoveryCursor: string | undefined;
  const discoveryCursors = new Set<string>();

  async function fetchPage(start: number, end: number, limit: number, cursor?: string) {
    if (pagesRead >= maxPages) return null;
    const query = new URLSearchParams({
      walletVisibility: "visible",
      walletVisibilityRevision: String(walletVisibilityRevision),
      fromMs: String(start),
      toMs: String(end),
      limit: String(limit),
    });
    if (cursor) query.set("cursor", cursor);
    pagesRead++;
    const result = await read(
      `/positions/${encodeURIComponent(positionId)}/metrics/apr?${query}`,
      pageSchema.refine(
        (data) =>
          data.positionId === positionId &&
          data.walletVisibility.revision === walletVisibilityRevision,
      ),
    );
    if (!result.data) {
      issues.add(result.issue);
      return null;
    }
    const current = result.data.change24h.current;
    // change24h is unbounded by the history query: never label it as the range endpoint.
    if (current && current.observedAtMs >= fromMs && current.observedAtMs <= toMs) {
      if (!latestRate || earlier(latestRate, current)) {
        latestRate = current;
        latestRateFreshness =
          result.data.change24h.quality.staleCurrent === undefined
            ? "unknown"
            : result.data.change24h.quality.staleCurrent
              ? "stale"
              : "current";
      }
    }
    return result.data;
  }

  // Discover the first actual saved observation, so fromMs=0 does not scan empty decades.
  // Pages may be empty when canonical wallet attribution excludes their underlying rows.
  while (pagesRead < maxPages) {
    const page = await fetchPage(fromMs, toMs, 1_000, discoveryCursor);
    if (!page) break;
    const point = page.points.find((p) => p.observedAtMs >= fromMs && p.observedAtMs <= toMs);
    if (point) {
      earliestRate = point;
      discoveryComplete = true;
      break;
    }
    if (!page.page.nextCursor) {
      discoveryComplete = true;
      break;
    }
    if (discoveryCursors.has(page.page.nextCursor)) {
      issues.add("The saved-rate discovery cursor repeated; earliest coverage is incomplete.");
      break;
    }
    discoveryCursors.add(page.page.nextCursor);
    discoveryCursor = page.page.nextCursor;
  }

  if (earliestRate) {
    const firstMonth = monthStart(fromMs === 0 ? earliestRate.observedAtMs : fromMs);
    const lastMonth = monthStart(toMs);
    const starts: number[] = [];
    for (let at = firstMonth; at <= lastMonth && starts.length <= MAX_MONTHS; at = nextMonth(at)) {
      starts.push(at);
    }
    if (starts.length > MAX_MONTHS) {
      issues.add("The requested range exceeds 240 UTC months; older monthly windows are omitted.");
      starts.length = 0;
      for (let at = lastMonth, n = 0; n < MAX_MONTHS; n++) {
        starts.unshift(at);
        const d = new Date(at);
        at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      }
    }
    for (const at of starts) {
      const month = new Date(at).toISOString().slice(0, 7);
      months.push({
        month,
        fromMs: Math.max(fromMs, at),
        toMs: Math.min(toMs, nextMonth(at) - 1),
        firstRate: null,
        lastRate: null,
        minimumRate: null,
        maximumRate: null,
        adapterVersions: [],
        observedPointCount: 0,
        retrievalComplete: false,
        truncated: true,
        methodologyComparable: false,
        methodologyCount: 0,
        issues: [],
      });
      monthMethods.set(month, new Set());
      monthVersions.set(month, new Set());
    }
    // Read recent months first. A dense early month cannot hide every recent endpoint.
    for (const month of [...months].reverse()) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      while (pagesRead < maxPages) {
        const page = await fetchPage(month.fromMs, month.toMs, 1_000, cursor);
        if (!page) break;
        for (const point of page.points) {
          if (point.observedAtMs < fromMs || point.observedAtMs > toMs) {
            issues.add(
              "Some provider-dated rates fall outside the requested range and were excluded.",
            );
            continue;
          }
          if (seen.has(point.observationId)) continue;
          seen.add(point.observationId);
          methods.add(methodology(point));
          versions.add(point.adapterVersion);
          windows.add(point.window);
          if (!earliestRate || earlier(point, earliestRate)) earliestRate = point;
          if (!latestRate || earlier(latestRate, point)) {
            latestRate = point;
            latestRateFreshness = "unknown";
          }
          // Group by the native provider observation date, never the retrieval window date.
          const target = months.find(
            (m) => m.month === new Date(point.observedAtMs).toISOString().slice(0, 7),
          );
          if (!target) continue;
          target.observedPointCount++;
          if (!target.firstRate || earlier(point, target.firstRate)) target.firstRate = point;
          if (!target.lastRate || earlier(target.lastRate, point)) target.lastRate = point;
          monthMethods.get(target.month)!.add(methodology(point));
          monthVersions.get(target.month)!.add(point.adapterVersion);
          if (
            !target.minimumRate ||
            compareDecimal(point.percentPerYear, target.minimumRate.percentPerYear) < 0
          )
            target.minimumRate = point;
          if (
            !target.maximumRate ||
            compareDecimal(point.percentPerYear, target.maximumRate.percentPerYear) > 0
          )
            target.maximumRate = point;
        }
        if (!page.page.nextCursor) {
          month.retrievalComplete = true;
          month.truncated = false;
          break;
        }
        if (cursors.has(page.page.nextCursor)) {
          month.issues.push("The saved-rate cursor repeated; this month is incomplete.");
          break;
        }
        cursors.add(page.page.nextCursor);
        cursor = page.page.nextCursor;
      }
      if (!month.retrievalComplete) {
        month.issues.push(
          "Saved-rate retrieval stopped before this month was fully scanned; its last point is not a verified month endpoint.",
        );
      }
    }
  }

  // Include boundary evidence even when the bounded month scan stops early.
  for (const point of [earliestRate, latestRate])
    if (point) {
      methods.add(methodology(point));
      versions.add(point.adapterVersion);
      windows.add(point.window);
    }
  for (const month of months) {
    month.methodologyCount = monthMethods.get(month.month)!.size;
    month.adapterVersions = [...monthVersions.get(month.month)!];
    // Partial extrema describe only the scanned subset and cannot establish monthly peaks.
    if (!month.retrievalComplete || month.methodologyCount !== 1) {
      month.minimumRate = null;
      month.maximumRate = null;
    }
    month.methodologyComparable = month.retrievalComplete && month.methodologyCount === 1;
    if (month.retrievalComplete && !month.observedPointCount) {
      month.issues.push("No saved quoted rates in this UTC month; absence is not a zero rate.");
    }
    if (month.methodologyCount > 1) {
      month.issues.push(
        "Rate type, source, window or adapter changed within this month; its extrema are withheld.",
      );
    }
  }
  const omittedMonths = issues.has(
    "The requested range exceeds 240 UTC months; older monthly windows are omitted.",
  );
  const retrievalComplete =
    discoveryComplete && !omittedMonths && months.every((m) => m.retrievalComplete);
  if (!retrievalComplete)
    issues.add(
      "Saved-rate coverage is partial; scanned counts do not establish total history size.",
    );
  if (methods.size > 1)
    issues.add(
      "Rate type, source, window or adapter changed; rates across different methods cannot be compared as one series.",
    );
  if (earliestRate && fromMs !== 0 && earliestRate.observedAtMs > fromMs) {
    issues.add(
      "No saved rate is established between the requested start and the first dated observation.",
    );
  }
  if (versions.size > 1)
    issues.add(
      "Adapter revisions changed across the saved observations. Revision labels are retained separately; a revision alone does not prove that the rate definition changed.",
    );
  if (windows.has("7d"))
    issues.add(
      "The 7d provider rate window is a seven-day lookback, not the duration the position was held.",
    );
  if (!earliestRate)
    issues.add("No saved quoted rate was found; absence is not a zero rate or zero return.");
  issues.add(
    "Saved quoted APR/APY observations do not establish earned yield, realized ROI or a held-period average.",
  );
  return {
    positionId,
    walletVisibilityRevision,
    fromMs,
    toMs,
    state: !earliestRate ? "unavailable" : retrievalComplete ? "available" : "partial",
    earliestRate,
    latestRate,
    latestRateFreshness,
    observedPointCount: seen.size,
    pagesRead,
    retrievalComplete,
    truncated: !retrievalComplete,
    sampling: "first_and_last_saved_rate_per_utc_month",
    windowMeaning: "provider_rate_window_not_holding_period",
    adapterVersions: [...versions],
    months,
    methodologyComparable: retrievalComplete && methods.size === 1,
    methodologyCount: methods.size,
    issues: [...issues],
  };
}
