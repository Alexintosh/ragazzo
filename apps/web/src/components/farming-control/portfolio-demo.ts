import type { FarmingControlPortfolio } from "@rakazo/contracts";

type Position = FarmingControlPortfolio["positions"][number];
const RATE_SCALE = 1_000_000_000_000n;

function hash(seed: string, key: string): bigint {
  let value = 2166136261;
  for (const char of JSON.stringify([seed, key])) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  }
  return BigInt(value >>> 0);
}

function amount(cents: bigint): string {
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function decimal(value: string, places: number): bigint {
  const match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return 0n;
  const [whole = "0", fraction = ""] = match[2]!.split(".");
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return 0n;
  const digits = BigInt(whole + fraction);
  const shift = places + exponent - fraction.length;
  const scaled = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return match[1] === "-" ? -scaled : scaled;
}

function sum(values: (string | null | undefined)[]): bigint {
  return values.reduce<bigint>(
    (total, value) => total + (value == null ? 0n : decimal(value, 2)),
    0n,
  );
}

function projected(
  capital: bigint,
  percent: string | null | undefined,
  days: number,
  apy: boolean,
): bigint {
  if (percent == null) return 0n;
  if (apy && days !== 365) {
    // Only the dimensionless APY exponent uses Number; all USD arithmetic is integer cents.
    const factor = Math.expm1((Math.log1p(Number(percent) / 100) * days) / 365);
    if (!Number.isFinite(factor)) return 0n;
    return (capital * decimal(factor.toFixed(12), 12)) / RATE_SCALE;
  }
  return (capital * decimal(percent, 12) * BigInt(days)) / (100n * RATE_SCALE * 365n);
}

function positionAmounts(position: Position, seed: string): Position {
  const capital = 500_000n + (hash(seed, `${position.id}:capital`) % 4_500_001n);
  const gainBps = 100n + (hash(seed, `${position.id}:gain`) % 1_100n);
  const baseline = (capital * 10_000n) / (10_000n + gainBps);
  const rate = position.apr?.percentPerYear;
  const rewards = position.projectedRewards;
  const apy = (rewards?.rateType ?? position.apr?.rateType) === "apy";
  return {
    ...position,
    current: {
      ...position.current,
      valueUsd: position.current.valueUsd === null ? null : amount(capital),
      capitalBaselineUsd: position.current.capitalBaselineUsd === null ? null : amount(baseline),
    },
    ...(rewards
      ? {
          projectedRewards: {
            ...rewards,
            ...(rewards.usd
              ? {
                  usd: {
                    day: amount(projected(capital, rate, 1, apy)),
                    month: amount(projected(capital, rate, 30, apy)),
                    year: amount(projected(capital, rate, 365, apy)),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Display-only demo projection. Never store this result in query data or send it to FC/chat.
 * USD amounts depend on the seed and position identity, never the operator's real capital.
 * Availability, percentages, lifecycle, scope, and observation metadata remain canonical.
 */
export function presentPortfolioAmounts(
  data: FarmingControlPortfolio,
  seed: string,
): FarmingControlPortfolio {
  const positions = data.positions.map((position) => positionAmounts(position, seed));
  const active = positions.filter((position) => position.state === "active");
  const currentCapital = sum(active.map((position) => position.current.valueUsd));
  const included = new Set(data.totals?.coverage.includedPositionIds);
  const excludedClaimable = new Set(data.totals?.coverage.earnedExcludedPositionIds);
  const excludedEarned = new Set([
    ...(data.totals?.coverage.earnedExcludedPositionIds ?? []),
    ...(data.totals?.coverage.earnedExcluded.map((entry) => entry.positionId) ?? []),
  ]);
  const unrealized = active.reduce((total, position) => {
    if (
      excludedEarned.has(position.id) ||
      position.current.valueUsd === null ||
      position.current.capitalBaselineUsd === null
    )
      return total;
    return (
      total +
      decimal(position.current.valueUsd, 2) -
      decimal(position.current.capitalBaselineUsd, 2)
    );
  }, 0n);
  const claimable = active.reduce((total, position) => {
    if (excludedClaimable.has(position.id) || position.current.valueUsd === null) return total;
    return (
      total +
      (decimal(position.current.valueUsd, 2) *
        (20n + (hash(seed, `${position.id}:claimable`) % 80n))) /
        10_000n
    );
  }, 0n);
  const sourceTotals = data.totals;
  const totals =
    sourceTotals === null
      ? null
      : {
          ...sourceTotals,
          currentPricedValueUsd:
            sourceTotals.currentPricedValueUsd === null ? null : amount(currentCapital),
          expectedYield30dUsd:
            sourceTotals.expectedYield30dUsd === null
              ? null
              : amount(
                  sum(
                    active
                      .filter((position) => included.has(position.id))
                      .map((position) => position.projectedRewards?.usd?.month),
                  ),
                ),
          liveEarnedUsd:
            sourceTotals.liveEarnedUsd === null
              ? null
              : amount(
                  (sourceTotals.liveEarnedBreakdownUsd.unrealized === null ? 0n : unrealized) +
                    (sourceTotals.liveEarnedBreakdownUsd.claimableNotRealized === null
                      ? 0n
                      : claimable),
                ),
          liveEarnedBreakdownUsd: {
            ...sourceTotals.liveEarnedBreakdownUsd,
            unrealized:
              sourceTotals.liveEarnedBreakdownUsd.unrealized === null ? null : amount(unrealized),
            claimableNotRealized:
              sourceTotals.liveEarnedBreakdownUsd.claimableNotRealized === null
                ? null
                : amount(claimable),
          },
        };
  const latestSample = Math.max(...data.history.map((point) => point.sampledAtMs));
  const history = data.history.map((point) => {
    const daysBeforeLatest = BigInt(
      Math.max(0, Math.floor((latestSample - point.sampledAtMs) / 86_400_000)),
    );
    const changeBps =
      point.sampledAtMs === latestSample
        ? 0n
        : daysBeforeLatest * 3n + (hash(seed, `${point.snapshotId}:history`) % 100n);
    const historicalCapital =
      (currentCapital * (10_000n - (changeBps > 2_500n ? 2_500n : changeBps))) / 10_000n;
    const historicalEarned =
      currentCapital === 0n
        ? 0n
        : (decimal(totals?.liveEarnedUsd ?? amount(unrealized + claimable), 2) *
            historicalCapital) /
          currentCapital;
    return {
      ...point,
      expectedYield30dUsd:
        point.expectedYield30dUsd === null
          ? null
          : amount(
              projected(historicalCapital, point.currentBlendedApr?.percentPerYear, 30, false),
            ),
      liveEarnedUsd: point.liveEarnedUsd === null ? null : amount(historicalEarned),
      coverage: {
        ...point.coverage,
        currentPricedValueUsd:
          point.coverage.currentPricedValueUsd === null ? null : amount(historicalCapital),
      },
    };
  });
  return { ...data, positions, totals, history };
}
