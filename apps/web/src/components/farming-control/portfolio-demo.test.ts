import type { FarmingControlPortfolio } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { presentPortfolioAmounts } from "./portfolio-demo";

type Position = FarmingControlPortfolio["positions"][number];
function position(id: string, overrides: Partial<Position> = {}): Position {
  return {
    id,
    label: id,
    state: "active",
    adapter: { key: "test" },
    current: {
      valueUsd: "99999999",
      capitalBaselineUsd: "88888888",
      observedAtMs: 1,
      nature: "observed",
    },
    apr: { percentPerYear: "12", observedAtMs: 1, projectionOnly: true, rateType: "apr" },
    projectedRewards: {
      status: "available",
      rateType: "apr",
      usd: { day: "100", month: "3000", year: "36500" },
    },
    dataQuality: {
      hasObservations: true,
      lastObservedAtMs: 1,
      rateObservedAtMs: 1,
      valueFreshness: "current",
      aprFreshness: "current",
      maxObservationAgeMs: 1000,
    },
    ...overrides,
  };
}
function portfolio(
  positions = [position("a"), position("b"), position("closed", { state: "exited" })],
): FarmingControlPortfolio {
  return {
    state: "available",
    fetchedAtMs: 1000,
    asOfMs: 1000,
    issues: [],
    sources: [],
    scope: {
      assetSetKey: null,
      label: "All",
      includedPositionIds: positions.map((p) => p.id),
      availableAssetSets: [],
    },
    walletVisibility: null,
    positions,
    totals: {
      currentPricedValueUsd: "200000000",
      currentBlendedApr: { valueDecimal: "0.12", percentPerYear: "12" },
      expectedYield30dUsd: "6000",
      projected30DayRoi: { percent: "1" },
      liveEarnedUsd: "1000",
      liveEarnedBreakdownUsd: {
        unrealized: "800",
        claimableNotRealized: "200",
        nature: "current_observed_marks_not_realized_roi",
        valuationComplete: true,
      },
      coverage: {
        projectionCoverageRatio: "1",
        includedPositionIds: positions.filter((p) => p.state === "active").map((p) => p.id),
        excluded: [],
        earnedExcludedPositionIds: [],
        earnedExcluded: [],
        lifecycleExcludedPositionIds: [],
      },
    },
    history: [0, 1].map((n) => ({
      snapshotId: String(n),
      sampledAtMs: n * 86400000,
      recordedAtMs: n * 86400000,
      quality: "complete",
      currentBlendedApr: { percentPerYear: "12" },
      expectedYield30dUsd: "3000",
      liveEarnedUsd: "1000",
      coverage: { currentPricedValueUsd: "200000000", projectionCoverageRatio: "1" },
    })),
    historyTruncated: false,
    historyRange: {
      fromMs: 0,
      toMs: 86400000,
      windowDays: 90,
      sampling: "last_saved_sample_per_utc_day_with_boundary_points",
      observedPointCount: 2,
      returnedPointCount: 2,
      retrievalComplete: true,
      windows: [],
    },
  };
}
const cents = (value: string) => BigInt(value.replace(".", ""));

describe("Portfolio demo amounts", () => {
  it("is deterministic, changes with its seed, and never mutates API/query data", () => {
    const source = portfolio();
    const original = structuredClone(source);
    const display = presentPortfolioAmounts(source, "one");
    expect(presentPortfolioAmounts(source, "one")).toEqual(display);
    expect(presentPortfolioAmounts(source, "two").positions[0]!.current.valueUsd).not.toEqual(
      display.positions[0]!.current.valueUsd,
    );
    expect(source).toEqual(original);
    expect(display.positions[0]!.current.valueUsd).not.toEqual(
      source.positions[0]!.current.valueUsd,
    );
    expect(display.positions.map((p) => p.apr)).toEqual(source.positions.map((p) => p.apr));
    expect(display.totals!.currentBlendedApr).toEqual(source.totals!.currentBlendedApr);
    expect(display.totals!.projected30DayRoi).toEqual(source.totals!.projected30DayRoi);
  });

  it("keeps per-position amounts independent of source USD and scoped subset/order", () => {
    const source = portfolio();
    const full = presentPortfolioAmounts(source, "demo");
    source.positions[0]!.current.valueUsd = "0.000001";
    source.positions[0]!.current.capitalBaselineUsd = "1e30";
    source.positions[0]!.projectedRewards!.usd = { day: "1e20", month: "1e21", year: "1e22" };
    const scoped = portfolio([source.positions[0]!]);
    scoped.scope!.assetSetKey = "eth";
    const display = presentPortfolioAmounts(scoped, "demo");
    expect(display.positions[0]).toEqual(full.positions[0]);
    expect(display.totals!.currentPricedValueUsd).toEqual(display.positions[0]!.current.valueUsd);
    expect(display.totals!.expectedYield30dUsd).toEqual(
      display.positions[0]!.projectedRewards!.usd!.month,
    );
    expect(
      presentPortfolioAmounts(portfolio([...source.positions].reverse()), "demo").positions.at(-1),
    ).toEqual(full.positions[0]);
  });

  it("sums active rows, projection coverage, and earned components exactly", () => {
    const source = portfolio();
    source.totals!.coverage.includedPositionIds = ["a"];
    const display = presentPortfolioAmounts(source, "demo");
    const [a, b] = display.positions;
    expect(cents(display.totals!.currentPricedValueUsd!)).toEqual(
      cents(a!.current.valueUsd!) + cents(b!.current.valueUsd!),
    );
    expect(display.totals!.expectedYield30dUsd).toEqual(a!.projectedRewards!.usd!.month);
    const earned = display.totals!.liveEarnedBreakdownUsd;
    expect(cents(display.totals!.liveEarnedUsd!)).toEqual(
      cents(earned.unrealized!) + cents(earned.claimableNotRealized!),
    );
    expect(cents(a!.projectedRewards!.usd!.year)).toEqual(
      (cents(a!.current.valueUsd!) * 12n) / 100n,
    );
    expect(cents(a!.projectedRewards!.usd!.month)).toEqual(
      (cents(a!.current.valueUsd!) * 12n * 30n) / (100n * 365n),
    );
    expect(display.history.at(-1)!.coverage.currentPricedValueUsd).toEqual(
      display.totals!.currentPricedValueUsd,
    );
  });

  it("preserves absent/null observations, projections, and incomplete coverage", () => {
    const source = portfolio([
      position("missing", {
        current: {
          valueUsd: null,
          capitalBaselineUsd: null,
          observedAtMs: null,
          nature: "missing",
        },
        apr: null,
        projectedRewards: { status: "unavailable", usd: null },
      }),
    ]);
    source.totals!.currentPricedValueUsd = null;
    source.totals!.expectedYield30dUsd = null;
    source.totals!.liveEarnedUsd = null;
    source.totals!.liveEarnedBreakdownUsd.unrealized = null;
    source.history[0]!.coverage.currentPricedValueUsd = null;
    source.history[0]!.expectedYield30dUsd = null;
    source.history[0]!.liveEarnedUsd = null;
    const display = presentPortfolioAmounts(source, "demo");
    expect(display.positions[0]).toEqual(source.positions[0]);
    expect(display.totals!.currentPricedValueUsd).toBeNull();
    expect(display.totals!.expectedYield30dUsd).toBeNull();
    expect(display.totals!.liveEarnedUsd).toBeNull();
    expect(display.totals!.liveEarnedBreakdownUsd.unrealized).toBeNull();
    expect(display.history[0]!.coverage.currentPricedValueUsd).toBeNull();
    expect(display.history[0]!.expectedYield30dUsd).toBeNull();
    expect(display.history[0]!.liveEarnedUsd).toBeNull();
    source.totals = null;
    expect(presentPortfolioAmounts(source, "demo").totals).toBeNull();
  });

  it("respects APY compounding while preserving the source rate", () => {
    const apy = position("apy");
    apy.apr!.percentPerYear = "2.1e1";
    apy.apr!.rateType = "apy";
    apy.projectedRewards!.rateType = "apy";
    const display = presentPortfolioAmounts(portfolio([apy]), "demo").positions[0]!;
    const capital = Number(display.current.valueUsd);
    expect(Number(display.projectedRewards!.usd!.month)).toBeCloseTo(
      capital! * (1.21 ** (30 / 365) - 1),
      1,
    );
    expect(display.apr).toEqual(apy.apr);
  });
});
