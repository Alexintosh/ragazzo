import * as z from "zod";
import { FarmingControlDecimalSchema } from "./farming-control.js";
import { FarmingControlPeriodEarningsContributionSchema } from "./farming-control-entities.js";

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(500);
const amount = FarmingControlDecimalSchema.max(12_000);
const state = z.enum(["available", "partial", "unavailable"]);

/** Preserve the source measure: baseline/current fields are native quantities for balance measures. */
export const FarmingControlHistoricalEarnedContributionSchema =
  FarmingControlPeriodEarningsContributionSchema.extend({
    calculation: z.string().max(500).optional(),
    nativeDeltas: z
      .array(
        z.object({
          componentKey: z.string().max(1_000),
          unit: z.union([
            z.object({
              kind: z.literal("token"),
              chainId: z.number().int().positive(),
              address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
              decimals: z.number().int().min(0).max(255),
              symbol: z.string().max(200).nullable(),
            }),
            z.object({
              kind: z.literal("steth_equivalent"),
              decimals: z.literal(18),
              symbol: z.literal("stETH"),
            }),
          ]),
          amountRaw: z
            .string()
            .regex(/^-?\d+$/)
            .max(12_000),
        }),
      )
      .max(100)
      .optional(),
  });

export const FarmingControlHarvestRealizationEntrySchema = z.object({
  activityId: id,
  positionId: id,
  occurredAtMs: ms,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  chainId: z.number().int().positive().nullable(),
  destination: z
    .object({
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .nullish(),
      symbol: z.string().max(200).nullish(),
      decimals: z.number().int().min(0).max(255).nullish(),
      amountDecimal: amount.nullish(),
    })
    .nullable(),
  realizedUsd: amount,
  costUsd: amount,
  netRealizedUsd: amount,
  valuationSource: z.string().max(4_000).nullable(),
});
export type FarmingControlHarvestRealizationEntry = z.infer<
  typeof FarmingControlHarvestRealizationEntrySchema
>;

/** Current native residuals are not period deltas or protocol rate projections. */
const outstandingContribution = z.object({
  economicId: id,
  type: z.enum(["reward", "embedded"]),
  chainId: z.number().int().nonnegative().nullable(),
  asset: z.string().max(500).nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  symbol: z.string().max(200).nullable(),
  amount: amount.nullable(),
  amountRaw: z.string().max(12_000).nullable(),
  principalRaw: z.string().max(12_000).nullable(),
  valueUsd: amount.nullable(),
  quality: z.enum(["current", "fallback", "unknown", "invalidated"]),
  quantityObservedAtMs: ms.nullable(),
  priceObservedAtMs: ms.nullable(),
  sourceObservationId: id.nullable(),
  priceSource: z.string().max(4_000).nullable(),
});
export const FarmingControlEconomicScorecardSchema = z.object({
  currency: z.literal("USD"),
  // These totals intentionally have their own scope, independent of the requested history window.
  scope: z.literal("all_recorded_realizations_and_current_outstanding"),
  state,
  asOfMs: ms.nullable(),
  harvestedUsd: amount.nullable(),
  harvestedCostsUsd: amount.nullable(),
  harvestedNetUsd: amount.nullable(),
  outstandingUsd: amount.nullable(),
  knownAccountedNetUsd: amount.nullable(),
  totalMethodology: z.literal("recorded_net_disposals_plus_compatible_current_residual"),
  totalUnavailableReason: z.string().max(4_000).nullable(),
  // Ledger/valuation coverage does not establish complete lifetime cashflow history.
  lifetimeEarningsComplete: z.literal(false),
  coverage: z.object({
    harvestAttributionComplete: z.boolean(),
    outstandingAttributionComplete: z.boolean(),
    outstandingComplete: z.boolean(),
    fallbackContributionCount: z.number().int().nonnegative(),
    unknownContributionCount: z.number().int().nonnegative(),
    projectionPending: z.boolean(),
  }),
  outstandingContributions: z.array(outstandingContribution).max(1_000),
  monthlyAverage: z.object({
    state,
    methodology: z.literal("equal_weight_observed_full_utc_calendar_month_earned_usd"),
    scope: z.literal("requested_history_window_supported_months_only"),
    averageUsd: amount.nullable(),
    summedEarnedUsd: amount.nullable(),
    includedMonths: z.array(z.string().regex(/^\d{4}-\d{2}$/)).max(120),
    missingFullMonthCount: z.number().int().nonnegative(),
    excludedPartialMonthCount: z.number().int().nonnegative(),
    maximumFractionDigits: z.literal(18),
    rounding: z.literal("toward_zero"),
  }),
  sources: z.tuple([
    z.literal("/harvest/accounting"),
    z.literal("/harvest/outstanding"),
    z.literal("/portfolio/metrics/earned/monthly"),
  ]),
});

/** Historical accrual, confirmed USD realizations and current residual marks must remain separate. */
export const FarmingControlPositionEarningsSchema = z.object({
  positionId: id,
  walletVisibilityRevision: ms,
  fromMs: ms,
  toMs: ms,
  asOfMs: ms,
  periodEarnings: z.object({
    state,
    fromMs: ms,
    toMs: ms.nullable(),
    methodology: z.literal("per_position_accrual_measure_delta"),
    contribution: FarmingControlHistoricalEarnedContributionSchema.nullable(),
  }),
  monthlyRecovery: z.object({
    state,
    requested: z.boolean(),
    calendar: z.literal("utc"),
    months: z
      .array(
        z.object({
          month: z.string().regex(/^\d{4}-\d{2}$/),
          fromMs: ms,
          toMs: ms,
          completeCalendarMonth: z.boolean(),
          state: z.enum(["available", "unavailable"]),
          contribution: FarmingControlHistoricalEarnedContributionSchema.nullable(),
        }),
      )
      .max(120),
  }),
  harvest: z.object({
    state,
    methodology: z.literal("confirmed_reward_disposal_ledger_usd"),
    scope: z.literal("selected_position_recorded_realizations_in_window"),
    coverageComplete: z.boolean(),
    realizedUsd: amount.nullable(),
    costsUsd: amount.nullable(),
    netRealizedUsd: amount.nullable(),
    realizationCount: z.number().int().nonnegative(),
    entries: z.array(FarmingControlHarvestRealizationEntrySchema).max(100),
    entriesTruncated: z.boolean(),
  }),
  economicScorecard: FarmingControlEconomicScorecardSchema,
  issues: z.array(z.string().max(4_000)),
});
export type FarmingControlPositionEarnings = z.infer<typeof FarmingControlPositionEarningsSchema>;
