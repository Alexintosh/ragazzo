import type {
  FarmingControlPortfolio,
  FarmingControlPositionDetail,
  FarmingControlPositionEarnings,
  FarmingControlPositionHistory,
} from "@rakazo/contracts";

type Position = FarmingControlPortfolio["positions"][number];
type Contribution = NonNullable<FarmingControlPositionEarnings["periodEarnings"]["contribution"]>;

function hash(seed: string, positionId: string, key: string): bigint {
  let value = 2166136261;
  for (const char of JSON.stringify([seed, positionId, key])) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  }
  return BigInt(value >>> 0);
}

function format(value: bigint, places = 2): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  if (places === 0) return `${sign}${absolute}`;
  const scale = 10n ** BigInt(places);
  return `${sign}${absolute / scale}.${String(absolute % scale).padStart(places, "0")}`;
}

/** Receives a position already projected by portfolio-demo; never reads canonical capital. */
function amounts(seed: string, position: Position) {
  const capital = BigInt((position.current.valueUsd ?? "10000.00").replace(".", ""));
  const cents = (key: string) =>
    (capital * (20n + (hash(seed, position.id, key) % 180n))) / 10_000n;
  const quantity = (key: string) =>
    format(10_000n + (hash(seed, position.id, key) % 5_000_000n), 6);
  const raw = (key: string, decimals: number) => {
    const millionths = 10_000n + (hash(seed, position.id, key) % 5_000_000n);
    return String(
      decimals >= 6
        ? millionths * 10n ** BigInt(decimals - 6)
        : millionths / 10n ** BigInt(6 - decimals),
    );
  };
  return { cents, quantity, raw };
}

function contribution(
  source: Contribution | null,
  key: string,
  earned: bigint,
  demo: ReturnType<typeof amounts>,
): Contribution | null {
  if (source === null) return null;
  const baseline = demo.cents(`${key}:baseline`) * 20n;
  return {
    ...source,
    baselineUsd: format(baseline),
    currentUsd: format(baseline + earned),
    claimsUsd: "0.00",
    earnedUsd: format(earned),
    ...(source.nativeDeltas === undefined
      ? {}
      : {
          nativeDeltas: source.nativeDeltas.map((delta) => ({
            ...delta,
            amountRaw: demo.raw(`${key}:${delta.componentKey}:delta`, delta.unit.decimals),
          })),
        }),
  };
}

/** Display copies only. Never put this result in query caches or agent context. */
export function presentPositionHistoryAmounts(
  history: FarmingControlPositionHistory,
  seed: string,
  position: Position,
): FarmingControlPositionHistory {
  if (history.status !== "matched" || history.earnings === null) return history;
  const source = history.earnings;
  const demo = amounts(seed, position);
  const monthEarned = (month: string) => demo.cents(`month:${month}`);
  const months = source.monthlyRecovery.months.map((month) => ({
    ...month,
    contribution: contribution(
      month.contribution,
      `month:${month.month}`,
      monthEarned(month.month),
      demo,
    ),
  }));
  const coveredEarned = months.reduce(
    (sum, month) => sum + (month.contribution === null ? 0n : monthEarned(month.month)),
    0n,
  );
  const entries = source.harvest.entries.map((entry) => {
    const realized = demo.cents(`ledger:${entry.activityId}:proceeds`);
    const cost = demo.cents(`ledger:${entry.activityId}:cost`) / 20n;
    return {
      ...entry,
      destination:
        entry.destination === null
          ? null
          : {
              ...entry.destination,
              ...(entry.destination.amountDecimal == null
                ? {}
                : {
                    amountDecimal: demo.quantity(`ledger:${entry.activityId}:quantity`),
                  }),
            },
      realizedUsd: format(realized),
      costUsd: format(cost),
      netRealizedUsd: format(realized - cost),
    };
  });
  const realized = entries.reduce(
    (sum, entry) => sum + BigInt(entry.realizedUsd.replace(".", "")),
    0n,
  );
  const costs = entries.reduce((sum, entry) => sum + BigInt(entry.costUsd.replace(".", "")), 0n);
  const scorecard = source.economicScorecard;
  const outstanding = scorecard.outstandingContributions.map((item) => {
    const key = `reward:${item.economicId}`;
    return {
      ...item,
      amount: item.amount === null ? null : demo.quantity(key),
      amountRaw: item.amountRaw === null ? null : demo.raw(key, item.decimals ?? 18),
      principalRaw:
        item.principalRaw === null ? null : demo.raw(`${key}:principal`, item.decimals ?? 18),
      valueUsd: item.valueUsd === null ? null : format(demo.cents(`${key}:usd`)),
    };
  });
  const outstandingUsd = outstanding.reduce(
    (sum, item) => sum + (item.valueUsd === null ? 0n : BigInt(item.valueUsd.replace(".", ""))),
    0n,
  );
  // The scorecard covers all recorded disposals, independent of the selected history range.
  const harvested = demo.cents("scorecard:harvested") * 12n;
  const harvestedCosts = demo.cents("scorecard:costs") / 10n;
  const average = scorecard.monthlyAverage;
  const summedMonths = average.includedMonths.reduce((sum, month) => sum + monthEarned(month), 0n);
  return {
    ...history,
    earnings: {
      ...source,
      periodEarnings: {
        ...source.periodEarnings,
        contribution: contribution(
          source.periodEarnings.contribution,
          "period",
          coveredEarned,
          demo,
        ),
      },
      monthlyRecovery: { ...source.monthlyRecovery, months },
      harvest: {
        ...source.harvest,
        entries,
        realizedUsd: source.harvest.realizedUsd === null ? null : format(realized),
        costsUsd: source.harvest.costsUsd === null ? null : format(costs),
        netRealizedUsd: source.harvest.netRealizedUsd === null ? null : format(realized - costs),
      },
      economicScorecard: {
        ...scorecard,
        harvestedUsd: scorecard.harvestedUsd === null ? null : format(harvested),
        harvestedCostsUsd: scorecard.harvestedCostsUsd === null ? null : format(harvestedCosts),
        harvestedNetUsd:
          scorecard.harvestedNetUsd === null ? null : format(harvested - harvestedCosts),
        outstandingUsd: scorecard.outstandingUsd === null ? null : format(outstandingUsd),
        knownAccountedNetUsd:
          scorecard.knownAccountedNetUsd === null
            ? null
            : format(harvested - harvestedCosts + outstandingUsd),
        outstandingContributions: outstanding,
        monthlyAverage: {
          ...average,
          summedEarnedUsd: average.summedEarnedUsd === null ? null : format(summedMonths),
          averageUsd:
            average.averageUsd === null || average.includedMonths.length === 0
              ? null
              : format(summedMonths / BigInt(average.includedMonths.length)),
        },
      },
    },
  };
}

export function presentPositionDetailAmounts(
  detail: FarmingControlPositionDetail,
  seed: string,
  position: Position,
): FarmingControlPositionDetail {
  if (detail.status !== "matched") return detail;
  const demo = amounts(seed, position);
  const activity = (item: NonNullable<typeof detail.opening>) => ({
    ...item,
    amount: item.amount === null ? null : demo.quantity(`activity:${item.id}`),
  });
  return {
    ...detail,
    opening: detail.opening === null ? null : activity(detail.opening),
    activities: { ...detail.activities, items: detail.activities.items.map(activity) },
    rewards: {
      ...detail.rewards,
      items: detail.rewards.items.map((item) => ({
        ...item,
        amount: item.amount === null ? null : demo.quantity(`reward:${item.id}`),
      })),
    },
  };
}
