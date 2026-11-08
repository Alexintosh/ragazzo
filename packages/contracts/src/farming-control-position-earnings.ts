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
  issues: z.array(z.string().max(4_000)),
});
export type FarmingControlPositionEarnings = z.infer<typeof FarmingControlPositionEarningsSchema>;
