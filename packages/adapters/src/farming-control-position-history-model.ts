import type {
  FarmingControlPositionHistory,
  FarmingControlPositionTrendPoint,
} from "@rakazo/contracts";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

function iso(ms: number | null) {
  return ms === null ? null : new Date(ms).toISOString();
}
function quote(point: FarmingControlPositionTrendPoint | null) {
  return (
    point && {
      at: iso(point.observedAtMs),
      percent: point.percentPerYear,
      rateType: point.rateType,
      source: point.source,
      providerLookback: point.window,
    }
  );
}

/** Preserve both ends of long histories in the model's bounded tool-result window. */
function milestones<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  return Array.from(
    { length: limit },
    (_, i) => items[Math.floor((i * (items.length - 1)) / (limit - 1))]!,
  );
}

function richProjection(evidence: FarmingControlPositionHistory) {
  if (evidence.status !== "matched") return evidence;
  const { trend, earnings } = evidence;
  const comparable = trend.methodologyComparable;
  const monthPoint = (point: FarmingControlPositionTrendPoint | null) =>
    !comparable
      ? quote(point)
      : point && { at: iso(point.observedAtMs)?.slice(0, 10), percent: point.percentPerYear };
  return {
    positionId: evidence.positionId,
    label: evidence.label,
    lifecycle: evidence.lifecycle,
    period: evidence.period,
    startEvidence: { kind: evidence.startEvidence.kind, at: iso(evidence.startEvidence.atMs) },
    through: iso(evidence.requestedThroughMs),
    rateHistory: {
      first: quote(trend.earliestRate),
      latest: quote(trend.latestRate),
      latestFreshness: trend.latestRateFreshness,
      meaning:
        "Each quote is the annual rate reported at that date. The provider lookback belongs to that quote.",
      methodologyComparable: comparable,
      retrievalComplete: trend.retrievalComplete,
      observedPoints: trend.observedPointCount,
      monthsInSeries: trend.months.length,
      displayedMonthsSampled: trend.months.length > 12,
      months: milestones(trend.months, 12).map((m) => ({
        month: m.month,
        points: m.observedPointCount,
        fullyRead: m.retrievalComplete,
        first: monthPoint(m.firstRate),
        last: monthPoint(m.lastRate),
        low: monthPoint(m.minimumRate),
        high: monthPoint(m.maximumRate),
      })),
      issues: trend.issues,
    },
    accrualAndHarvest: earnings && {
      periodEarnedUsd: earnings.periodEarnings.contribution?.earnedUsd ?? null,
      periodMeasure: earnings.periodEarnings.contribution?.measure ?? null,
      periodStart: iso(earnings.periodEarnings.fromMs),
      periodEnd: iso(earnings.periodEarnings.toMs),
      recoveryMonthCount: earnings.monthlyRecovery.months.length,
      monthlyAccrual: milestones(earnings.monthlyRecovery.months, 12).map((m) => ({
        month: m.month,
        start: iso(m.fromMs),
        end: iso(m.toMs),
        state: m.state,
        measure: m.contribution?.measure ?? null,
        earnedUsd: m.contribution?.earnedUsd ?? null,
        calculation: m.contribution?.calculation ?? null,
      })),
      confirmedHarvest: {
        coverageComplete: earnings.harvest.coverageComplete,
        count: earnings.harvest.realizationCount,
        netRealizedUsd: earnings.harvest.netRealizedUsd,
        grossUsd: earnings.harvest.realizedUsd,
        costsUsd: earnings.harvest.costsUsd,
        examples: milestones(earnings.harvest.entries, 5).map((entry) => ({
          at: iso(entry.occurredAtMs),
          netUsd: entry.netRealizedUsd,
          token: entry.destination?.symbol ?? null,
          tokenQuantity: entry.destination?.amountDecimal ?? null,
        })),
      },
      issues: earnings.issues,
    },
  };
}

type MatchedHistory = Extract<FarmingControlPositionHistory, { status: "matched" }>;
type Projection = Record<string, unknown>;

function fits(value: unknown): boolean {
  // Leave room for the sampling flags that are finalized after filling optional rows.
  return JSON.stringify(value).length <= TOOL_RESULT_TEXT_LIMIT - 128;
}

function compactQuote(point: FarmingControlPositionTrendPoint | null) {
  return (
    point && {
      at: iso(point.observedAtMs),
      percent: point.percentPerYear,
      rateType: point.rateType,
    }
  );
}

/** Keep whole exact amounts. A pathological scalar can itself exceed the tool budget. */
function fitCore(core: Projection): void {
  const withheld: string[] = [];
  core.withheldExactNumbers = withheld;
  const scalars: { object: Projection; key: string; path: string; length: number }[] = [];
  function visit(object: Projection, path: string) {
    for (const [key, value] of Object.entries(object)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof value === "string" && /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(value)) {
        scalars.push({ object, key, path: nextPath, length: value.length });
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value as Projection, nextPath);
      }
    }
  }
  // Only these nested records contain financial/rate decimals. Never remove subject IDs.
  for (const key of ["rateHistory", "accrualAndHarvest"]) {
    const value = core[key];
    if (value && typeof value === "object") visit(value as Projection, key);
  }
  for (const scalar of scalars.sort((a, b) => b.length - a.length)) {
    if (fits(core)) break;
    scalar.object[scalar.key] = null;
    withheld.push(scalar.path);
  }
}

function compactProjection(evidence: MatchedHistory): Projection {
  const { trend, earnings } = evidence;
  const rateHistory = {
    first: compactQuote(trend.earliestRate),
    latest: compactQuote(trend.latestRate),
    latestFreshness: trend.latestRateFreshness,
    state: trend.state,
    methodologyComparable: trend.methodologyComparable,
    retrievalComplete: trend.retrievalComplete,
    truncated: trend.truncated,
    observedPoints: trend.observedPointCount,
    omittedIssueCount: trend.issues.length,
    monthsInSeries: trend.months.length,
    displayedMonthsSampled: trend.months.length > 0,
    months: [] as Projection[],
  };
  const accrualAndHarvest = earnings && {
    periodState: earnings.periodEarnings.state,
    periodEarnedUsd: earnings.periodEarnings.contribution?.earnedUsd ?? null,
    periodMeasure: earnings.periodEarnings.contribution?.measure ?? null,
    periodStart: iso(earnings.periodEarnings.fromMs),
    periodEnd: iso(earnings.periodEarnings.toMs),
    omittedIssueCount: earnings.issues.length,
    monthlyRecoveryState: earnings.monthlyRecovery.state,
    recoveryMonthCount: earnings.monthlyRecovery.months.length,
    availableRecoveryMonthCount: earnings.monthlyRecovery.months.filter(
      (m) => m.contribution !== null,
    ).length,
    monthlyAccrualSampled: earnings.monthlyRecovery.months.length > 0,
    monthlyAccrual: [] as Projection[],
    confirmedHarvest: {
      state: earnings.harvest.state,
      coverageComplete: earnings.harvest.coverageComplete,
      count: earnings.harvest.realizationCount,
      entriesTruncated: earnings.harvest.entriesTruncated,
      netRealizedUsd: earnings.harvest.netRealizedUsd,
      grossUsd: earnings.harvest.realizedUsd,
      costsUsd: earnings.harvest.costsUsd,
    },
  };
  const core: Projection = {
    positionId: evidence.positionId,
    label: evidence.label.slice(0, 160),
    labelShortened: evidence.label.length > 160,
    lifecycle: evidence.lifecycle.slice(0, 64),
    period: evidence.period,
    startEvidence: { kind: evidence.startEvidence.kind, at: iso(evidence.startEvidence.atMs) },
    through: iso(evidence.requestedThroughMs),
    rateHistory,
    accrualAndHarvest,
    compactedForModelBudget: true,
    caveats: [
      "Rates are dated annual quotes, not earned return or a holding-period average. Source/lookback detail and source issues are omitted to fit the tool budget; methodologyComparable still applies.",
      "Only fullyRead monthly rate rows establish saved monthly extrema. Missing rates or earnings are unknown, not zero.",
      "Harvest is recorded disposal USD proceeds and costs. Incomplete coverage means known subtotals. Do not add Harvest to accrual, which can already include it.",
      "Monthly accrual rows cover only their dated windows; sampled or unavailable months cannot establish lifetime earnings. Exact numbers listed in withheldExactNumbers could not fit and were omitted whole, never rounded.",
    ],
  };
  fitCore(core);

  // Reserve core figures before optional series detail. Every candidate is measured using
  // the same serialization and character limit as the model runtime.
  function addRows<T>(items: T[], target: Projection[], project: (item: T) => Projection): void {
    const rows = milestones(items, 12).map(project);
    const selected: number[] = [];
    // Reserve both endpoints first. One oversized row must not hide other known figures.
    const order =
      rows.length < 2 ? [0] : [0, rows.length - 1, ...rows.slice(1, -1).map((_, i) => i + 1)];
    for (const index of order) {
      if (!rows[index]) continue;
      target.push(rows[index]!);
      if (fits(core)) selected.push(index);
      else target.pop();
    }
    target.splice(0, target.length, ...selected.sort((a, b) => a - b).map((i) => rows[i]!));
  }
  if (earnings && accrualAndHarvest) {
    // Prioritize supported partial figures; unavailable-month counts remain in the core.
    const supported = earnings.monthlyRecovery.months.filter((m) => m.contribution !== null);
    addRows(supported, accrualAndHarvest.monthlyAccrual, (m) => ({
      month: m.month,
      start: iso(m.fromMs),
      end: iso(m.toMs),
      state: m.state,
      measure: m.contribution?.measure ?? null,
      earnedUsd: m.contribution?.earnedUsd ?? null,
    }));
    accrualAndHarvest.monthlyAccrualSampled =
      accrualAndHarvest.monthlyAccrual.length < earnings.monthlyRecovery.months.length;
  }
  addRows(trend.months, rateHistory.months, (m) => ({
    month: m.month,
    points: m.observedPointCount,
    fullyRead: m.retrievalComplete,
    comparable: m.methodologyComparable,
    first: compactQuote(m.firstRate),
    last: compactQuote(m.lastRate),
    low: compactQuote(m.minimumRate),
    high: compactQuote(m.maximumRate),
  }));
  rateHistory.displayedMonthsSampled = rateHistory.months.length < trend.months.length;
  return core;
}

export function positionHistoryForModel(evidence: FarmingControlPositionHistory) {
  const rich = richProjection(evidence);
  return evidence.status !== "matched" || fits(rich) ? rich : compactProjection(evidence);
}
