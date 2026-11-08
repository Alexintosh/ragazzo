import type { FarmingControlPositionEarnings } from "@rakazo/contracts";
import {
  FarmingControlHarvestRealizationEntrySchema,
  FarmingControlHistoricalEarnedContributionSchema,
  FarmingControlPositionEarningsSchema,
} from "@rakazo/contracts";
import * as z from "zod";

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

export type FarmingControlPositionEarningsPath =
  | `/portfolio/metrics/earned/since?${string}`
  | `/portfolio/metrics/earned/monthly?${string}`
  | `/harvest/accounting?${string}`;
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
  if (!Number.isSafeInteger(fromMs) || fromMs < 0 || !Number.isSafeInteger(toMs) || toMs < fromMs) {
    throw new RangeError("Invalid historical earnings window");
  }
  const scope = new URLSearchParams({
    walletVisibility: "visible",
    walletVisibilityRevision: String(walletVisibilityRevision),
    fromMs: String(fromMs),
  });
  const accountingQuery = new URLSearchParams(scope);
  accountingQuery.set("toMs", String(toMs));
  const [period, accounting] = await Promise.all([
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
  ]);
  const issues = [period.issue, accounting.issue].filter(
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
    // A bounded fallback can recover supported later months without reconstructing remote history.
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
    issues,
  });
}

function uniquePositions(rows: readonly { positionId: string }[]): boolean {
  return new Set(rows.map((row) => row.positionId)).size === rows.length;
}

/** Exact decimal addition; exponent arithmetic controls scale only, never monetary values. */
function exactSum(values: readonly string[]): string {
  const parts = values.map((value) => {
    const match = /^([+-]?)(\d*(?:\.\d*)?)(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match) throw new Error("invalid_decimal");
    const exponent = Number(match[3] ?? "0");
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000)
      throw new Error("decimal_budget");
    const [whole = "", fraction = ""] = (match[2] ?? "").split(".");
    let coefficient = BigInt(`${whole}${fraction}`);
    if (match[1] === "-") coefficient = -coefficient;
    const scale = fraction.length - exponent;
    if (Math.abs(scale) > 10_000) throw new Error("decimal_budget");
    return { coefficient, scale };
  });
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  let sum = 0n;
  for (const part of parts) sum += part.coefficient * 10n ** BigInt(scale - part.scale);
  const sign = sum < 0n ? "-" : "";
  const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${sign}${digits}`;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return `${sign}${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ""}`;
}
