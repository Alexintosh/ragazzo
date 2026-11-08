import * as z from "zod";
import {
  FARMING_CONTROL_RISK_SELECTION_LIMIT,
  FarmingControlDecimalSchema,
  FarmingControlPositionSchema,
  FarmingControlRiskExposureSchema,
} from "./farming-control.js";

export const FarmingControlEntityKindSchema = z.enum(["position", "wallet", "protocol", "risk"]);
export type FarmingControlEntityKind = z.infer<typeof FarmingControlEntityKindSchema>;
/** Source identities only; labels never select a subject or expand authority. */
export const FarmingControlEntitySelectionSchema = z
  .object({
    kind: FarmingControlEntityKindSchema,
    id: z.string().min(1).max(500),
    signalKey: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.kind === "risk" || value.signalKey === undefined, {
    message: "signalKey requires a risk subject",
  })
  .refine((value) => value.kind !== "risk" || value.id.length <= 200, {
    message: "Risk id exceeds 200 characters",
  });
export type FarmingControlEntitySelection = z.infer<typeof FarmingControlEntitySelectionSchema>;
export const FarmingControlEntityContextSchema = z
  .object({
    selections: z
      .array(FarmingControlEntitySelectionSchema)
      .min(1)
      .max(FARMING_CONTROL_RISK_SELECTION_LIMIT),
  })
  .strict();
export type FarmingControlEntityContext = z.infer<typeof FarmingControlEntityContextSchema>;
export const FarmingControlEntitySchema = z.object({
  selection: FarmingControlEntitySelectionSchema,
  label: z.string().max(4_000),
  detail: z.string().max(4_000).nullable(),
  aliases: z.array(z.string().max(4_000)).max(64),
  positionIds: z.array(z.string().max(500)).max(2_000),
});
export type FarmingControlEntity = z.infer<typeof FarmingControlEntitySchema>;
export const FarmingControlEntityCatalogInputSchema = z
  .object({
    query: z.string().max(500).optional(),
    kinds: z.array(FarmingControlEntityKindSchema).min(1).max(4).optional(),
    positionId: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type FarmingControlEntityCatalogInput = z.infer<
  typeof FarmingControlEntityCatalogInputSchema
>;
export const FarmingControlMentionTargetsInputSchema =
  FarmingControlEntityCatalogInputSchema.extend({
    botId: z.string().min(1).max(500),
  });
const meta = {
  state: z.enum(["available", "partial", "unavailable"]),
  fetchedAtMs: z.number().int().nonnegative(),
  asOfMs: z.number().int().nonnegative().nullable(),
  walletVisibilityRevision: z.number().int().nonnegative().nullable(),
  sources: z.array(z.string()),
  issues: z.array(z.string().max(4_000)),
};
export const FarmingControlEntityCatalogSchema = z.object({
  ...meta,
  entities: z.array(FarmingControlEntitySchema).max(100),
  truncated: z.boolean(),
});
export type FarmingControlEntityCatalog = z.infer<typeof FarmingControlEntityCatalogSchema>;
const yieldAmount = FarmingControlDecimalSchema.nullable();
const yieldWindows = z.object({
  day: yieldAmount,
  month: yieldAmount,
  year: yieldAmount,
  lifetime: yieldAmount,
});
export const FarmingControlRealizedPerformanceSchema = z.object({
  methodology: z.literal("confirmed_disposal_proceeds_net_of_attributed_costs"),
  roiMethodology: z.literal("net_realized_return_over_time_weighted_deployed_capital"),
  byAssetSet: z.record(
    z.string().max(500),
    z.object({
      realizedGross: yieldWindows,
      attributedCosts: yieldWindows,
      realizedNet: yieldWindows,
      currentCapitalBasis: yieldAmount,
      averageCapitalBasis: yieldWindows,
      realizedRoiPercent: yieldWindows,
    }),
  ),
});
export const FarmingControlAprHistoryPointSchema = z.object({
  observationId: z.string().max(500),
  observedAtMs: z.number().int().nonnegative(),
  percentPerYear: FarmingControlDecimalSchema,
  rateType: z.enum(["apr", "apy"]),
  source: z.string().max(4_000),
  window: z.string().max(4_000).nullable(),
});
export const FarmingControlPeriodEarningsContributionSchema = z.object({
  positionId: z.string().max(500),
  measure: z.enum(["claimable", "flow", "value", "steth_balance", "base_balance"]),
  realization: z.enum(["claim", "withdrawal_required"]),
  baselineUsd: FarmingControlDecimalSchema,
  currentUsd: FarmingControlDecimalSchema,
  claimsUsd: FarmingControlDecimalSchema,
  earnedUsd: FarmingControlDecimalSchema,
});
/** Saved evidence only. Quoted rates, earned mark deltas and realized ROI are distinct. */
export const FarmingControlYieldEvidenceSchema = z.object({
  positionId: z.string().max(500),
  asOfMs: z.number().int().nonnegative(),
  walletVisibilityRevision: z.number().int().nonnegative(),
  // FC has no held-period average aggregate. Never turn a sampled rate into earned ROI.
  heldPeriodAverageAprPercent: z.null(),
  periodEarnings: z.object({
    window: z.literal("rolling_30d"),
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative().nullable(),
    state: z.enum(["available", "unavailable"]),
    methodology: z.literal("per_position_accrual_measure_delta"),
    contribution: FarmingControlPeriodEarningsContributionSchema.nullable(),
  }),
  realizedGrossUnit: z.literal("source_asset_quantities_grouped_by_asset_set"),
  realized: FarmingControlRealizedPerformanceSchema.nullable(),
  aprHistory: z.object({
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative(),
    state: z.enum(["available", "partial", "unavailable"]),
    latestRate: FarmingControlAprHistoryPointSchema.nullable(),
    latestRateFreshness: z.enum(["current", "stale", "unknown"]),
    dayPriorRate: FarmingControlAprHistoryPointSchema.nullable(),
    observedPointCount: z.number().int().nonnegative(),
    sampling: z.literal("bounded_saved_points_with_boundaries"),
    points: z.array(FarmingControlAprHistoryPointSchema).max(12),
    truncated: z.boolean(),
  }),
  issues: z.array(z.string().max(4_000)),
});
export type FarmingControlYieldEvidence = z.infer<typeof FarmingControlYieldEvidenceSchema>;
export const FarmingControlEntityReadSchema = z.object({
  ...meta,
  selection: FarmingControlEntitySelectionSchema,
  selectionStatus: z.enum(["matched", "missing", "discovery_partial", "discovery_unavailable"]),
  entity: FarmingControlEntitySchema.nullable(),
  yieldEvidence: FarmingControlYieldEvidenceSchema.optional(),
  positions: z.array(FarmingControlPositionSchema).max(2_000),
  risk: FarmingControlRiskExposureSchema.nullable(),
  // All connected cards for a selected position; risk is populated only when unambiguous.
  relatedRisks: z.array(FarmingControlRiskExposureSchema).max(64).optional(),
});
export type FarmingControlEntityRead = z.infer<typeof FarmingControlEntityReadSchema>;
