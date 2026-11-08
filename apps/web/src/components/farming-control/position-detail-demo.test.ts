import type {
  FarmingControlPortfolio,
  FarmingControlPositionDetail,
  FarmingControlPositionHistory,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  presentPositionDetailAmounts,
  presentPositionHistoryAmounts,
} from "./position-detail-demo";

type MatchedHistory = Extract<FarmingControlPositionHistory, { status: "matched" }>;
type MatchedDetail = Extract<FarmingControlPositionDetail, { status: "matched" }>;
const position: FarmingControlPortfolio["positions"][number] = {
  id: "position-a",
  label: "Example",
  state: "active",
  adapter: { key: "test" },
  current: {
    valueUsd: "12000.00",
    capitalBaselineUsd: "10000.00",
    observedAtMs: 1,
    nature: "observed",
  },
  apr: null,
  dataQuality: {
    hasObservations: true,
    lastObservedAtMs: 1,
    rateObservedAtMs: null,
    valueFreshness: "current",
    aprFreshness: "unknown",
    maxObservationAgeMs: 1000,
  },
};
const contribution = {
  positionId: position.id,
  measure: "claimable" as const,
  realization: "claim" as const,
  baselineUsd: "912345",
  currentUsd: "912346",
  claimsUsd: "912347",
  earnedUsd: "912348",
  nativeDeltas: [
    {
      componentKey: "reward",
      unit: { kind: "steth_equivalent" as const, decimals: 18 as const, symbol: "stETH" as const },
      amountRaw: "912349000000000000000000",
    },
  ],
};
function history(): MatchedHistory {
  return {
    status: "matched",
    positionId: position.id,
    label: "Example",
    lifecycle: "active",
    period: "since_opening",
    startEvidence: { kind: "tracking_started", atMs: 1 },
    walletVisibilityRevision: 1,
    requestedThroughMs: 10,
    trend: {
      positionId: position.id,
      walletVisibilityRevision: 1,
      fromMs: 1,
      toMs: 10,
      state: "available",
      earliestRate: null,
      latestRate: null,
      minimumRate: null,
      maximumRate: null,
      meanQuotedRatePercentPerYear: "12",
      meanWeighting: "equal_weight_per_saved_observation",
      meanMaximumFractionDigits: 18,
      meanRounding: "toward_zero",
      latestRateFreshness: "current",
      observedPointCount: 0,
      pagesRead: 1,
      retrievalComplete: true,
      truncated: false,
      sampling: "first_and_last_saved_rate_per_utc_month",
      windowMeaning: "provider_rate_window_not_holding_period",
      adapterVersions: [],
      months: [],
      methodologyComparable: true,
      methodologyCount: 1,
      issues: [],
    },
    earnings: {
      positionId: position.id,
      walletVisibilityRevision: 1,
      fromMs: 1,
      toMs: 10,
      asOfMs: 10,
      periodEarnings: {
        state: "available",
        fromMs: 1,
        toMs: 10,
        methodology: "per_position_accrual_measure_delta",
        contribution: structuredClone(contribution),
      },
      monthlyRecovery: {
        state: "partial",
        requested: true,
        calendar: "utc",
        months: ["2026-01", "2026-02", "2026-03"].map((month, index) => ({
          month,
          fromMs: index + 1,
          toMs: index + 2,
          completeCalendarMonth: true,
          state: index === 2 ? "unavailable" : "available",
          contribution: index === 2 ? null : structuredClone(contribution),
        })),
      },
      harvest: {
        state: "available",
        methodology: "confirmed_reward_disposal_ledger_usd",
        scope: "selected_position_recorded_realizations_in_window",
        coverageComplete: true,
        realizedUsd: "912350",
        costsUsd: "912351",
        netRealizedUsd: "912352",
        realizationCount: 1,
        entries: [
          {
            activityId: "harvest-a",
            positionId: position.id,
            occurredAtMs: 5,
            month: "2026-01",
            chainId: 1,
            destination: { symbol: "USDC", decimals: 6, amountDecimal: "912353" },
            realizedUsd: "912354",
            costUsd: "912355",
            netRealizedUsd: "912356",
            valuationSource: "confirmed",
          },
        ],
        entriesTruncated: false,
      },
      economicScorecard: {
        currency: "USD",
        scope: "all_recorded_realizations_and_current_outstanding",
        state: "available",
        asOfMs: 10,
        harvestedUsd: "912357",
        harvestedCostsUsd: "912358",
        harvestedNetUsd: "912359",
        outstandingUsd: "912360",
        knownAccountedNetUsd: "912361",
        totalMethodology: "recorded_net_disposals_plus_compatible_current_residual",
        totalUnavailableReason: null,
        lifetimeEarningsComplete: false,
        coverage: {
          harvestAttributionComplete: true,
          outstandingAttributionComplete: true,
          outstandingComplete: true,
          fallbackContributionCount: 0,
          unknownContributionCount: 0,
          projectionPending: false,
        },
        outstandingContributions: [
          {
            economicId: "reward-a",
            type: "reward",
            chainId: 1,
            asset: "token",
            decimals: 18,
            symbol: "TEST",
            amount: "912362",
            amountRaw: "912363",
            principalRaw: "912364",
            valueUsd: "912365",
            quality: "current",
            quantityObservedAtMs: 5,
            priceObservedAtMs: 6,
            sourceObservationId: "observation-a",
            priceSource: "test",
          },
        ],
        monthlyAverage: {
          state: "available",
          methodology: "equal_weight_observed_full_utc_calendar_month_earned_usd",
          scope: "requested_history_window_supported_months_only",
          averageUsd: "912366",
          summedEarnedUsd: "912367",
          includedMonths: ["2026-01", "2026-02"],
          missingFullMonthCount: 1,
          excludedPartialMonthCount: 0,
          maximumFractionDigits: 18,
          rounding: "toward_zero",
        },
        sources: [
          "/harvest/accounting",
          "/harvest/outstanding",
          "/portfolio/metrics/earned/monthly",
        ],
      },
      issues: [],
    },
  };
}
function detail(): MatchedDetail {
  const activity = {
    id: "activity-a",
    kind: "deposit",
    status: "confirmed",
    occurredAtMs: 1,
    recordedAtMs: 2,
    sourceId: "source-a",
    evidenceId: null,
    transaction: null,
    amount: "912368",
    token: "TEST",
  };
  return {
    status: "matched",
    positionId: position.id,
    label: "Example",
    lifecycle: "active",
    fetchedAtMs: 10,
    asOfMs: 9,
    walletVisibilityRevision: 1,
    wallets: [],
    walletsComplete: true,
    opening: activity,
    activities: {
      state: "available",
      items: [activity, { ...activity, id: "missing", amount: null }],
      complete: true,
      truncated: false,
    },
    rewards: {
      state: "available",
      complete: true,
      truncated: false,
      items: [
        {
          id: "reward-a",
          symbol: "TEST",
          token: "token",
          amount: "912369",
          observedAtMs: 8,
          sourceObservationId: "observation-a",
          quality: "current",
          readiness: "ready",
        },
      ],
    },
    harvesting: { mode: "manual", evidence: [] },
    sources: [],
    issues: [],
  };
}
const cents = (amount: string) => BigInt(amount.replace(".", ""));
function displayed(source: MatchedHistory, seed = "demo"): MatchedHistory {
  return presentPositionHistoryAmounts(source, seed, position) as MatchedHistory;
}

describe("Position detail demo amounts", () => {
  it("projects every numeric amount without modifying canonical history or dates/rates", () => {
    const source = history();
    const before = structuredClone(source);
    const view = displayed(source);
    expect(source).toEqual(before);
    expect(displayed(source)).toEqual(view);
    expect(view.trend).toEqual(source.trend);
    expect(view.startEvidence).toEqual(source.startEvidence);
    expect(JSON.stringify(view)).not.toContain("9123");
    expect(displayed(source, "another").earnings).not.toEqual(view.earnings);
    const ledger = view.earnings!.harvest.entries[0]!;
    expect(cents(ledger.netRealizedUsd)).toEqual(cents(ledger.realizedUsd) - cents(ledger.costUsd));
    expect(view.earnings!.harvest.realizedUsd).toBe(ledger.realizedUsd);
    expect(view.earnings!.harvest.costsUsd).toBe(ledger.costUsd);
    expect(view.earnings!.harvest.netRealizedUsd).toBe(ledger.netRealizedUsd);
  });

  it("sums covered months and keeps a month's amount stable across ranges and reloads", () => {
    const source = history();
    const view = displayed(source);
    const earned = view
      .earnings!.monthlyRecovery.months.slice(0, 2)
      .map((month) => cents(month.contribution!.earnedUsd));
    const total = earned[0]! + earned[1]!;
    expect(cents(view.earnings!.periodEarnings.contribution!.earnedUsd)).toBe(total);
    expect(cents(view.earnings!.economicScorecard.monthlyAverage.summedEarnedUsd!)).toBe(total);
    expect(cents(view.earnings!.economicScorecard.monthlyAverage.averageUsd!)).toBe(total / 2n);
    const shorter = structuredClone(source);
    shorter.period = "30d";
    shorter.earnings!.monthlyRecovery.months = shorter.earnings!.monthlyRecovery.months.slice(1);
    shorter.earnings!.economicScorecard.monthlyAverage.includedMonths = ["2026-02"];
    const narrow = displayed(shorter);
    expect(narrow.earnings!.monthlyRecovery.months[0]).toEqual(
      view.earnings!.monthlyRecovery.months[1],
    );
    expect(cents(narrow.earnings!.periodEarnings.contribution!.earnedUsd)).toBe(earned[1]);
    expect(narrow.earnings!.economicScorecard.harvestedUsd).toBe(
      view.earnings!.economicScorecard.harvestedUsd,
    );
    expect(displayed(JSON.parse(JSON.stringify(source)))).toEqual(view);
  });

  it("depends on identities and availability rather than real financial values", () => {
    const source = history();
    const first = displayed(source);
    const changed = JSON.parse(JSON.stringify(source).replace(/9123\d+/g, "1")) as MatchedHistory;
    expect(displayed(changed)).toEqual(first);
    const otherPosition = { ...position, id: "position-b" };
    expect(presentPositionHistoryAmounts(source, "demo", otherPosition)).not.toEqual(first);
  });

  it("preserves absent amounts and unavailable observations", () => {
    const source = history();
    const earnings = source.earnings!;
    earnings.periodEarnings.contribution = null;
    earnings.harvest.realizedUsd = null;
    earnings.harvest.costsUsd = null;
    earnings.harvest.netRealizedUsd = null;
    earnings.harvest.entries[0]!.destination!.amountDecimal = null;
    const score = earnings.economicScorecard;
    score.harvestedUsd =
      score.harvestedCostsUsd =
      score.harvestedNetUsd =
      score.outstandingUsd =
      score.knownAccountedNetUsd =
        null;
    score.monthlyAverage.averageUsd = score.monthlyAverage.summedEarnedUsd = null;
    const reward = score.outstandingContributions[0]!;
    reward.amount = reward.amountRaw = reward.principalRaw = reward.valueUsd = null;
    const view = displayed(source).earnings!;
    expect(view.periodEarnings.contribution).toBeNull();
    expect(view.harvest.realizedUsd).toBeNull();
    expect(view.harvest.costsUsd).toBeNull();
    expect(view.harvest.netRealizedUsd).toBeNull();
    expect(view.harvest.entries[0]!.destination!.amountDecimal).toBeNull();
    expect(view.economicScorecard).toEqual(score);
    expect(view.monthlyRecovery.months[2]!.contribution).toBeNull();
    source.earnings = null;
    expect(displayed(source)).toBe(source);
    const unavailable = { status: "unavailable" as const, reason: "No evidence" };
    expect(presentPositionHistoryAmounts(unavailable, "demo", position)).toBe(unavailable);
  });

  it("projects opening, ledger and reward quantities consistently without mutating detail", () => {
    const source = detail();
    const before = structuredClone(source);
    const view = presentPositionDetailAmounts(source, "demo", position) as MatchedDetail;
    expect(source).toEqual(before);
    expect(view.opening!.amount).toEqual(view.activities.items[0]!.amount);
    expect(view.activities.items[1]!.amount).toBeNull();
    expect(view.opening!.occurredAtMs).toBe(source.opening!.occurredAtMs);
    expect(JSON.stringify(view)).not.toContain("9123");
    expect(presentPositionDetailAmounts(source, "demo", position)).toEqual(view);
    expect(view.rewards.items[0]!.amount).toBe(
      displayed(history()).earnings!.economicScorecard.outstandingContributions[0]!.amount,
    );
    source.opening = null;
    source.rewards.items[0]!.amount = null;
    const missing = presentPositionDetailAmounts(source, "demo", position) as MatchedDetail;
    expect(missing.opening).toBeNull();
    expect(missing.rewards.items[0]!.amount).toBeNull();
  });
});
