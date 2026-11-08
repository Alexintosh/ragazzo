import type { FarmingControlPositionEarnings } from "@rakazo/contracts";
import {
  FarmingControlEconomicScorecardSchema,
  FarmingControlHarvestRealizationEntrySchema,
  FarmingControlHistoricalEarnedContributionSchema,
  FarmingControlPositionEarningsSchema,
} from "@rakazo/contracts";
import * as z from "zod";
import { exactMean, exactSum } from "./farming-control-exact-decimal.js";

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const visibility = z.object({ revision: ms });
const contribution = FarmingControlHistoricalEarnedContributionSchema;
const windowSource = z.object({
  fromMs: ms,
  toMs: ms,
  walletVisibility: visibility,
  methodology: z.literal("per_position_accrual_measure_delta"),
  byPosition: z.array(contribution).max(2_000),
  excludedPositionIds: z.array(z.string().max(500)).max(2_000),
});
const accountingSource = z.object({
  asOfMs: ms,
  walletVisibility: visibility,
  walletVisibilityCoverage: z.object({ complete: z.boolean() }),
  entries: z.array(FarmingControlHarvestRealizationEntrySchema).max(10_000),
});
const monthlySource = z.object({
  fromMs: ms,
  toMs: ms,
  walletVisibility: visibility,
  calendar: z.literal("utc"),
  methodology: z.literal("per_position_accrual_measure_delta"),
  months: z
    .array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        fromMs: ms,
        toMs: ms,
        completeCalendarMonth: z.boolean(),
        excludedPositionIds: z.array(z.string().max(500)).max(2_000),
        byPosition: z.array(contribution).max(2_000),
      }),
    )
    .max(120),
});

const outstandingSource = z.object({
  asOfMs: ms,
  walletVisibility: visibility,
  walletVisibilityCoverage: z.object({ complete: z.boolean() }),
  scope: z.literal("all_accumulated_outstanding_returns"),
  components: z
    .array(
      z.object({
        positionId: z.string(),
        estimate: z.null(),
        contributions: z.array(
          FarmingControlEconomicScorecardSchema.shape.outstandingContributions.element.extend({
            positionId: z.string(),
          }),
        ),
      }),
    )
    .max(2_000),
  rewardComponents: z
    .array(
      FarmingControlEconomicScorecardSchema.shape.outstandingContributions.element.extend({
        positionId: z.string(),
      }),
    )
    .max(10_000),
  projectionStates: z
    .array(z.object({ positionId: z.string(), pending: z.boolean(), cursorGap: z.boolean() }))
    .max(2_000),
});

export type FarmingControlPositionEarningsPath =
  | `/portfolio/metrics/earned/since?${string}`
  | `/portfolio/metrics/earned/monthly?${string}`
  | `/harvest/accounting?${string}`
  | `/harvest/outstanding?${string}`;
type ReadResult<T> = { data: T; issue: null } | { data: null; issue: string };
type Read = <T>(
  path: FarmingControlPositionEarningsPath,
  schema: z.ZodType<T>,
) => Promise<ReadResult<T>>;

/** Only call after resolving one visible position. The caller rereads the visibility fence afterwards. */
export async function readFarmingControlPositionEarnings(input: {
  read: Read;
  positionId: string;
  walletVisibilityRevision: number;
  fromMs: number;
  toMs: number;
}): Promise<FarmingControlPositionEarnings> {
  const { read, positionId, walletVisibilityRevision, fromMs, toMs } = input;
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
  ) {
    throw new RangeError("Invalid historical earnings window");
  }
  const scope = new URLSearchParams({
    walletVisibility: "visible",
    walletVisibilityRevision: String(walletVisibilityRevision),
    fromMs: String(fromMs),
  });
  const accountingQuery = new URLSearchParams(scope);
  accountingQuery.set("toMs", String(toMs));
  const visibilityQuery = new URLSearchParams({
    walletVisibility: "visible",
    walletVisibilityRevision: String(walletVisibilityRevision),
  });
  const [period, accounting, recorded, outstanding] = await Promise.all([
    read(
      `/portfolio/metrics/earned/since?${scope}`,
      windowSource.refine(
        (value) =>
          value.walletVisibility.revision === walletVisibilityRevision &&
          value.fromMs === fromMs &&
          value.toMs >= fromMs &&
          uniquePositions(value.byPosition),
      ),
    ),
    read(
      `/harvest/accounting?${accountingQuery}`,
      accountingSource.refine(
        (value) =>
          value.walletVisibility.revision === walletVisibilityRevision &&
          value.entries.every(
            (entry) => entry.occurredAtMs >= fromMs && entry.occurredAtMs <= toMs,
          ) &&
          new Set(value.entries.map((entry) => entry.activityId)).size === value.entries.length,
      ),
    ),
    read(
      `/harvest/accounting?${visibilityQuery}`,
      accountingSource.refine(
        (value) =>
          value.walletVisibility.revision === walletVisibilityRevision &&
          new Set(value.entries.map((entry) => entry.activityId)).size === value.entries.length,
      ),
    ),
    read(
      `/harvest/outstanding?${visibilityQuery}`,
      outstandingSource.refine((value) => {
        const rows = [
          ...value.components.flatMap((component) => component.contributions),
          ...value.rewardComponents,
        ];
        return (
          value.walletVisibility.revision === walletVisibilityRevision &&
          new Set(rows.map((row) => row.economicId)).size === rows.length &&
          value.components.every((component) =>
            component.contributions.every((row) => row.positionId === component.positionId),
          ) &&
          uniquePositions(value.projectionStates)
        );
      }),
    ),
  ]);
  const issues = [period.issue, accounting.issue, recorded.issue, outstanding.issue].filter(
    (issue): issue is string => issue !== null,
  );
  const earnedContribution = period.data?.excludedPositionIds.includes(positionId)
    ? null
    : (period.data?.byPosition.find((row) => row.positionId === positionId) ?? null);
  const months: FarmingControlPositionEarnings["monthlyRecovery"]["months"] = [];
  let monthlyRequested = false;
  let monthlyAvailable = false;
  if (!earnedContribution) {
    issues.push(
      "Earned for the full requested window is unavailable. A missing baseline, incompatible history or unresolved movements must not be treated as zero or a realized loss.",
    );
  }
  {
    // Always read the bounded monthly source: a supported full period does not establish a calendar-month average.
    const start = new Date(fromMs);
    const end = new Date(toMs);
    const monthCount =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      start.getUTCMonth() +
      1;
    if (monthCount <= 120) {
      monthlyRequested = true;
      const monthly = await read(
        `/portfolio/metrics/earned/monthly?${accountingQuery}`,
        monthlySource.refine(
          (value) =>
            value.walletVisibility.revision === walletVisibilityRevision &&
            value.fromMs === fromMs &&
            value.toMs === toMs &&
            value.months.every(
              (month) =>
                month.fromMs >= fromMs &&
                month.toMs <= toMs &&
                month.fromMs <= month.toMs &&
                validMonthWindow(month) &&
                uniquePositions(month.byPosition),
            ) &&
            new Set(value.months.map((month) => month.month)).size === value.months.length,
        ),
      );
      if (monthly.issue) issues.push(monthly.issue);
      for (const month of monthly.data?.months ?? []) {
        const selected = month.excludedPositionIds.includes(positionId)
          ? null
          : (month.byPosition.find((row) => row.positionId === positionId) ?? null);
        months.push({
          month: month.month,
          fromMs: month.fromMs,
          toMs: month.toMs,
          completeCalendarMonth: month.completeCalendarMonth,
          state: selected ? "available" : "unavailable",
          contribution: selected,
        });
      }
      monthlyAvailable = monthly.data !== null;
      if (months.some((month) => month.contribution !== null)) {
        issues.push(
          "Supported calendar-month contributions cover only their stated windows. Gaps remain unknown; these rows do not establish lifetime earnings or a held-period average APR.",
        );
      }
    } else issues.push("Monthly recovery exceeds the 120-month read budget.");
  }
  const entries = accounting.data?.entries.filter((entry) => entry.positionId === positionId) ?? [];
  const coverageComplete = accounting.data?.walletVisibilityCoverage.complete === true;
  let totals: { realizedUsd: string; costsUsd: string; netRealizedUsd: string } | null = null;
  if (accounting.data && (entries.length > 0 || coverageComplete)) {
    try {
      totals = {
        realizedUsd: exactSum(entries.map((entry) => entry.realizedUsd)),
        costsUsd: exactSum(entries.map((entry) => entry.costUsd)),
        netRealizedUsd: exactSum(entries.map((entry) => entry.netRealizedUsd)),
      };
    } catch {
      issues.push(
        "Recorded realization totals exceed the exact-decimal aggregation budget; individual source amounts remain available.",
      );
    }
  }
  if (accounting.data && !coverageComplete) {
    issues.push(
      "Wallet attribution of the Harvest ledger is incomplete; recorded USD values are known subtotals, not complete returns.",
    );
  }
  if (entries.length)
    issues.push(
      "Harvest amounts are confirmed recorded disposal USD proceeds and costs, not withdrawn principal or current claimable yield. Do not add them to flow/value/balance earned contributions, which can already include those returns.",
    );
  if (
    earnedContribution?.measure === "claimable" ||
    months.some((month) => month.contribution?.measure === "claimable")
  ) {
    issues.push(
      "Claimable earned is a saved claimable-mark delta plus recorded disposal proceeds. A negative delta alone does not prove a realized loss.",
    );
  }
  const economicScorecard = buildEconomicScorecard({
    recorded: recorded.data,
    outstanding: outstanding.data,
    positionId,
    months,
    fromMs,
    toMs,
    issues,
  });
  return FarmingControlPositionEarningsSchema.parse({
    positionId,
    walletVisibilityRevision,
    fromMs,
    toMs,
    asOfMs: Math.max(toMs, period.data?.toMs ?? toMs, accounting.data?.asOfMs ?? toMs),
    periodEarnings: {
      state: earnedContribution ? "available" : "unavailable",
      fromMs,
      toMs: period.data?.toMs ?? null,
      methodology: "per_position_accrual_measure_delta",
      contribution: earnedContribution,
    },
    monthlyRecovery: {
      state:
        !monthlyAvailable || !months.some((month) => month.contribution !== null)
          ? "unavailable"
          : months.every((month) => month.contribution !== null)
            ? "available"
            : "partial",
      requested: monthlyRequested,
      calendar: "utc",
      months,
    },
    harvest: {
      state: !accounting.data
        ? "unavailable"
        : coverageComplete && totals
          ? "available"
          : "partial",
      methodology: "confirmed_reward_disposal_ledger_usd",
      scope: "selected_position_recorded_realizations_in_window",
      coverageComplete,
      realizedUsd: totals?.realizedUsd ?? null,
      costsUsd: totals?.costsUsd ?? null,
      netRealizedUsd: totals?.netRealizedUsd ?? null,
      realizationCount: entries.length,
      entries: entries.slice(0, 100),
      entriesTruncated: entries.length > 100,
    },
    economicScorecard,
    issues,
  });
}

function uniquePositions(rows: readonly { positionId: string }[]): boolean {
  return new Set(rows.map((row) => row.positionId)).size === rows.length;
}

function validMonthWindow(month: {
  month: string;
  fromMs: number;
  toMs: number;
  completeCalendarMonth: boolean;
}): boolean {
  const date = new Date(month.fromMs);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
  return (
    Number.isFinite(start) &&
    date.toISOString().slice(0, 7) === month.month &&
    month.toMs <= end &&
    (!month.completeCalendarMonth || (month.fromMs === start && month.toMs === end))
  );
}

/** Combine only canonical residuals with recorded net disposals, never with earned mark deltas. */
function buildEconomicScorecard(input: {
  recorded: z.infer<typeof accountingSource> | null;
  outstanding: z.infer<typeof outstandingSource> | null;
  positionId: string;
  months: FarmingControlPositionEarnings["monthlyRecovery"]["months"];
  fromMs: number;
  toMs: number;
  issues: string[];
}): FarmingControlPositionEarnings["economicScorecard"] {
  const { recorded, outstanding, positionId, months, fromMs, toMs, issues } = input;
  const recordedEntries =
    recorded?.entries.filter((entry) => entry.positionId === positionId) ?? [];
  const rows = [
    ...(outstanding?.components.flatMap((component) => component.contributions) ?? []),
    ...(outstanding?.rewardComponents ?? []),
  ].filter((row) => row.positionId === positionId);
  const harvestAttributionComplete = recorded?.walletVisibilityCoverage.complete === true;
  const outstandingAttributionComplete = outstanding?.walletVisibilityCoverage.complete === true;
  const projection = outstanding?.projectionStates.find((row) => row.positionId === positionId);
  const projectionPending = !projection || projection.pending || projection.cursorGap;
  const usable = rows.filter(
    (row) => row.valueUsd !== null && (row.quality === "current" || row.quality === "fallback"),
  );
  const outstandingComplete =
    rows.length > 0 &&
    usable.length === rows.length &&
    outstandingAttributionComplete &&
    !projectionPending;
  let harvestedUsd: string | null = null;
  let harvestedCostsUsd: string | null = null;
  let harvestedNetUsd: string | null = null;
  let outstandingUsd: string | null = null;
  let knownAccountedNetUsd: string | null = null;
  let totalUnavailableReason: string | null = null;
  try {
    if (recorded && (recordedEntries.length || harvestAttributionComplete)) {
      harvestedUsd = exactSum(recordedEntries.map((entry) => entry.realizedUsd));
      harvestedCostsUsd = exactSum(recordedEntries.map((entry) => entry.costUsd));
      harvestedNetUsd = exactSum(recordedEntries.map((entry) => entry.netRealizedUsd));
    }
    if (usable.length) outstandingUsd = exactSum(usable.map((row) => row.valueUsd!));
    const latestDisposalAtMs = recordedEntries.reduce(
      (latest, entry) => Math.max(latest, entry.occurredAtMs),
      0,
    );
    const compatible =
      outstandingComplete &&
      harvestAttributionComplete &&
      harvestedNetUsd !== null &&
      rows.every(
        (row) =>
          row.quantityObservedAtMs !== null &&
          row.quantityObservedAtMs >= latestDisposalAtMs &&
          (row.type !== "embedded" || row.principalRaw !== null),
      );
    if (compatible && outstandingUsd !== null)
      knownAccountedNetUsd = exactSum([harvestedNetUsd!, outstandingUsd]);
    else if (!recorded) totalUnavailableReason = "The recorded-realization source is unavailable.";
    else if (!harvestAttributionComplete)
      totalUnavailableReason = "Recorded realizations have incomplete wallet attribution.";
    else if (!outstanding)
      totalUnavailableReason = "The current outstanding-return source is unavailable.";
    else if (!outstandingAttributionComplete)
      totalUnavailableReason = "Outstanding returns have incomplete wallet attribution.";
    else if (!rows.length)
      totalUnavailableReason =
        "No attributable residual-return scope is available; its absence is unknown, not zero.";
    else if (usable.length !== rows.length)
      totalUnavailableReason =
        "At least one residual-return scope has unknown or invalidated valuation.";
    else if (projectionPending)
      totalUnavailableReason = !projection
        ? "The selected position has no verified projection state."
        : projection.cursorGap
          ? "The outstanding-return projection has a cursor gap."
          : "The outstanding-return projection is pending.";
    else if (rows.some((row) => row.type === "embedded" && row.principalRaw === null))
      totalUnavailableReason = "Protected principal is missing for an embedded-return scope.";
    else if (rows.some((row) => row.quantityObservedAtMs === null))
      totalUnavailableReason = "A residual quantity has no observation timestamp.";
    else if (rows.some((row) => row.quantityObservedAtMs! < latestDisposalAtMs))
      totalUnavailableReason =
        "Residual quantity evidence predates a recorded disposal and may overlap the harvested amount.";
    else totalUnavailableReason = "The recorded net-realization subtotal is unavailable.";
  } catch {
    totalUnavailableReason =
      "Exact-decimal aggregation exceeded its budget; source amounts remain available.";
    issues.push(totalUnavailableReason);
  }
  if (usable.some((row) => row.quality === "fallback"))
    issues.push(
      "Outstanding USD includes economically compatible dated fallback values. Their source timestamps remain authoritative; compatibility does not establish current freshness.",
    );
  const expectedFullMonths: string[] = [];
  let excludedPartialMonthCount = 0;
  const start = new Date(fromMs);
  for (
    let at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1), count = 0;
    at <= toMs && count < 120;
    count++
  ) {
    const d = new Date(at);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
    if (at >= fromMs && end <= toMs) expectedFullMonths.push(d.toISOString().slice(0, 7));
    else excludedPartialMonthCount++;
    at = end + 1;
  }
  const selected = months.filter(
    (month) =>
      expectedFullMonths.includes(month.month) &&
      month.completeCalendarMonth &&
      month.contribution !== null,
  );
  const methods = new Set(
    selected.map((month) =>
      JSON.stringify([
        month.contribution!.measure,
        month.contribution!.realization,
        month.contribution!.calculation ?? null,
      ]),
    ),
  );
  let averageUsd: string | null = null;
  let summedEarnedUsd: string | null = null;
  if (selected.length && methods.size === 1) {
    try {
      const values = selected.map((month) => month.contribution!.earnedUsd);
      summedEarnedUsd = exactSum(values);
      averageUsd = exactMean(values);
    } catch {
      issues.push("Monthly USD averaging exceeded the exact-decimal budget.");
    }
  } else if (methods.size > 1)
    issues.push(
      "Full-month earned contributions use different calculation methods; their USD average is withheld.",
    );
  const missingFullMonthCount = expectedFullMonths.length - selected.length;
  if (missingFullMonthCount)
    issues.push(
      "The monthly USD mean covers supported full UTC months only; missing months are unknown and partial months are excluded.",
    );
  return {
    currency: "USD",
    scope: "all_recorded_realizations_and_current_outstanding",
    state:
      knownAccountedNetUsd !== null
        ? "available"
        : harvestedUsd !== null || outstandingUsd !== null
          ? "partial"
          : "unavailable",
    asOfMs: outstanding?.asOfMs ?? recorded?.asOfMs ?? null,
    harvestedUsd,
    harvestedCostsUsd,
    harvestedNetUsd,
    outstandingUsd,
    knownAccountedNetUsd,
    totalMethodology: "recorded_net_disposals_plus_compatible_current_residual",
    totalUnavailableReason,
    lifetimeEarningsComplete: false,
    coverage: {
      harvestAttributionComplete,
      outstandingAttributionComplete,
      outstandingComplete,
      fallbackContributionCount: rows.filter((row) => row.quality === "fallback").length,
      unknownContributionCount: rows.length - usable.length,
      projectionPending,
    },
    outstandingContributions: rows.map(({ positionId: _positionId, ...row }) => row),
    monthlyAverage: {
      state: averageUsd === null ? "unavailable" : missingFullMonthCount ? "partial" : "available",
      methodology: "equal_weight_observed_full_utc_calendar_month_earned_usd",
      scope: "requested_history_window_supported_months_only",
      averageUsd,
      summedEarnedUsd,
      includedMonths: selected.map((month) => month.month),
      missingFullMonthCount,
      excludedPartialMonthCount,
      maximumFractionDigits: 18,
      rounding: "toward_zero",
    },
    sources: ["/harvest/accounting", "/harvest/outstanding", "/portfolio/metrics/earned/monthly"],
  };
}
