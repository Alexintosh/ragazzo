import * as z from "zod";

// Financial values are exact source strings, including scientific decimal notation.
export const FarmingControlDecimalSchema = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/);
const amount = FarmingControlDecimalSchema.nullable();
const ms = z.number().int().nonnegative();
const text = z.string().max(4_000);
const count = z.number().int().nonnegative();
const meta = {
  state: z.enum(["available", "partial", "unavailable"]),
  fetchedAtMs: ms,
  asOfMs: ms.nullable(),
  issues: z.array(text),
  sources: z.array(z.string()),
};
export const FarmingControlSectionSchema = z.enum(["portfolio", "harvest", "risk", "accounting"]);
export type FarmingControlSection = z.infer<typeof FarmingControlSectionSchema>;
export const FarmingControlStatusSchema = z.object({
  configured: z.boolean(),
  readOnly: z.literal(true),
  connection: z.enum(["connected", "unavailable", "not_configured"]),
  fetchedAtMs: ms,
});

const exclusion = z.object({ positionId: text, reasons: z.array(text) });
export const FarmingControlPortfolioTotalsSchema = z.object({
  currentPricedValueUsd: amount,
  currentBlendedApr: z.object({ valueDecimal: amount, percentPerYear: amount }).nullable(),
  expectedYield30dUsd: amount,
  liveEarnedUsd: amount,
  liveEarnedBreakdownUsd: z.object({
    unrealized: amount,
    claimableNotRealized: amount,
    nature: z.literal("current_observed_marks_not_realized_roi"),
    valuationComplete: z.boolean(),
  }),
  coverage: z.object({
    projectionCoverageRatio: amount,
    includedPositionIds: z.array(text),
    excluded: z.array(exclusion),
    earnedExcludedPositionIds: z.array(text),
    earnedExcluded: z.array(exclusion.extend({ component: z.literal("unrealized_usd") })),
    lifecycleExcludedPositionIds: z.array(text),
  }),
});
export const FarmingControlPositionSchema = z.object({
  id: text,
  label: text.nullable(),
  state: text,
  adapter: z.object({ key: text.nullable() }),
  current: z.object({
    valueUsd: amount,
    capitalBaselineUsd: amount,
    observedAtMs: ms.nullable(),
    nature: text,
  }),
  apr: z
    .object({ percentPerYear: amount, observedAtMs: ms.nullable(), projectionOnly: z.boolean() })
    .nullable(),
  dataQuality: z.object({
    hasObservations: z.boolean(),
    lastObservedAtMs: ms.nullable(),
    rateObservedAtMs: ms.nullable(),
    valueFreshness: z.enum(["current", "stale", "unknown"]),
    aprFreshness: z.enum(["current", "stale", "unknown"]),
    maxObservationAgeMs: ms,
  }),
});
export const FarmingControlHistoryPointSchema = z.object({
  snapshotId: text,
  sampledAtMs: ms,
  recordedAtMs: ms,
  quality: z.enum(["complete", "partial"]),
  currentBlendedApr: z.object({ percentPerYear: amount }).nullable(),
  expectedYield30dUsd: amount,
  liveEarnedUsd: amount,
  coverage: z.object({ currentPricedValueUsd: amount, projectionCoverageRatio: amount }),
});
export const FarmingControlHistoryRangeSchema = z.object({
  fromMs: ms,
  toMs: ms,
  windowDays: z.literal(90),
  sampling: z.literal("last_saved_sample_per_utc_day_with_boundary_points"),
  observedPointCount: count,
  returnedPointCount: count,
  retrievalComplete: z.boolean(),
  windows: z
    .array(
      z.object({
        fromMs: ms,
        toMs: ms,
        state: z.enum(["available", "partial", "unavailable"]),
        truncated: z.boolean(),
        observedPointCount: count,
        firstSampleAtMs: ms.nullable(),
        lastSampleAtMs: ms.nullable(),
      }),
    )
    .max(4),
});
export const FarmingControlPortfolioSchema = z.object({
  ...meta,
  totals: FarmingControlPortfolioTotalsSchema.nullable(),
  positions: z.array(FarmingControlPositionSchema),
  history: z.array(FarmingControlHistoryPointSchema),
  historyTruncated: z.boolean(),
  historyRange: FarmingControlHistoryRangeSchema,
});
export type FarmingControlPortfolio = z.infer<typeof FarmingControlPortfolioSchema>;

export const FarmingControlHarvestContributionSchema = z.object({
  positionId: text,
  positionLabel: text,
  economicId: text,
  type: z.enum(["reward", "embedded"]),
  symbol: text.nullable(),
  amount: amount,
  amountRaw: z.string().nullable(),
  valueUsd: amount,
  quality: z.enum(["current", "fallback", "unknown", "invalidated"]),
  quantityObservedAtMs: ms.nullable(),
  priceObservedAtMs: ms.nullable(),
  reason: text.nullable(),
  readiness: text,
});
export const FarmingControlHarvestTotalsSchema = z.object({
  totalOutstandingUsd: amount,
  claimableUsd: amount,
  embeddedUsd: amount,
  currentOutstandingUsd: amount,
  fallbackOutstandingUsd: amount,
  unknownEmbeddedCount: count,
  unknownRewardCount: count,
  invalidatedContributionCount: count,
});
export const FarmingControlHarvestSchema = z.object({
  ...meta,
  complete: z.boolean().nullable(),
  totals: FarmingControlHarvestTotalsSchema.nullable(),
  contributions: z.array(FarmingControlHarvestContributionSchema),
});
export type FarmingControlHarvest = z.infer<typeof FarmingControlHarvestSchema>;

export const FarmingControlAlertSchema = z.object({
  id: text,
  subjectKey: text,
  status: text,
  severity: text,
  title: text,
  openedAtMs: ms,
  lastSeenAtMs: ms,
});
export const FarmingControlAssessmentSchema = z.object({
  id: text,
  subjectKey: text,
  status: text,
  severity: text,
  summary: text,
  evaluatedAtMs: ms,
  canonical: z.boolean(),
});
export const FarmingControlMonitorSchema = z.object({
  monitorKey: text,
  actualState: text,
  health: text,
  asOfMs: ms,
  desiredState: text,
  supervisorReachable: z.boolean(),
});
export const FarmingControlSourceAvailabilitySchema = z.object({
  state: z.enum(["available", "unavailable", "retired"]),
  asOfMs: ms.nullable(),
  returnedCount: count.nullable(),
  truncated: z.boolean(),
});
export const FarmingControlRiskSchema = z.object({
  ...meta,
  alerts: z.array(FarmingControlAlertSchema),
  assessments: z.array(FarmingControlAssessmentSchema),
  monitors: z.array(FarmingControlMonitorSchema),
  sourceAvailability: z.object({
    alerts: FarmingControlSourceAvailabilitySchema,
    assessments: FarmingControlSourceAvailabilitySchema,
    monitors: FarmingControlSourceAvailabilitySchema,
  }),
  complete: z.literal(false),
});
export type FarmingControlRisk = z.infer<typeof FarmingControlRiskSchema>;

export const FarmingControlAccountingTotalsSchema = z.object({
  realizedUsd: amount,
  costsUsd: amount,
  netRealizedUsd: amount,
  realizationCount: count,
});
export const FarmingControlAccountingMonthSchema = FarmingControlAccountingTotalsSchema.extend({
  month: z.string(),
});
export const FarmingControlTaxInfoSchema = z.object({
  state: z.enum(["enabled", "disabled", "unavailable"]),
  moduleVersion: text.nullable(),
  moduleSchemaStatus: text.nullable(),
  features: z.record(z.string(), z.boolean()),
});
export const FarmingControlAccountingSchema = z.object({
  ...meta,
  totals: FarmingControlAccountingTotalsSchema.nullable(),
  months: z.array(FarmingControlAccountingMonthSchema),
  tax: FarmingControlTaxInfoSchema,
});
export type FarmingControlAccounting = z.infer<typeof FarmingControlAccountingSchema>;
export type FarmingControlRead =
  | FarmingControlPortfolio
  | FarmingControlHarvest
  | FarmingControlRisk
  | FarmingControlAccounting;
export const FarmingControlTeamSchema = z.object({
  groupId: text,
  coordinatorId: text,
  bots: z.array(z.object({ id: text, role: text, name: text })),
});
