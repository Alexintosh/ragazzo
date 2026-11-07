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

export const FarmingControlPortfolioInputSchema = z
  .object({
    assetSetKey: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();
export type FarmingControlPortfolioInput = z.infer<typeof FarmingControlPortfolioInputSchema>;
export const FARMING_CONTROL_RISK_SELECTION_LIMIT = 16;

/** Opaque selectors from Risk chips; amounts and labels are always read from FC. */
export const FarmingControlRiskSelectionSchema = z
  .object({
    exposureId: z.string().min(1).max(200),
    signalKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type FarmingControlRiskSelection = z.infer<typeof FarmingControlRiskSelectionSchema>;
export const FarmingControlRiskContextSchema = z
  .object({
    selections: z
      .array(FarmingControlRiskSelectionSchema)
      .min(1)
      .max(FARMING_CONTROL_RISK_SELECTION_LIMIT),
  })
  .strict();
export type FarmingControlRiskContext = z.infer<typeof FarmingControlRiskContextSchema>;
export const FarmingControlWalletVisibilitySchema = z.object({
  revision: ms,
  active: z.boolean(),
  hiddenWalletCount: count,
});
export const FarmingControlPortfolioScopeSchema = z.object({
  assetSetKey: text.nullable(),
  label: text,
  includedPositionIds: z.array(text),
  availableAssetSets: z.array(z.object({ key: text, label: text })),
});
const exclusion = z.object({ positionId: text, reasons: z.array(text) });
export const FarmingControlPortfolioTotalsSchema = z.object({
  currentPricedValueUsd: amount,
  currentBlendedApr: z.object({ valueDecimal: amount, percentPerYear: amount }).nullable(),
  expectedYield30dUsd: amount,
  projected30DayRoi: z.object({ percent: amount }).nullable().optional(),
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
  assetSetKeys: z.array(text).optional(),
  current: z.object({
    valueUsd: amount,
    capitalBaselineUsd: amount,
    observedAtMs: ms.nullable(),
    nature: text,
  }),
  apr: z
    .object({
      percentPerYear: amount,
      observedAtMs: ms.nullable(),
      projectionOnly: z.boolean(),
      rateType: z.enum(["apr", "apy"]).optional(),
      source: text.nullable().optional(),
      window: text.nullable().optional(),
    })
    .nullable(),
  projectedRewards: z
    .object({
      status: z.enum(["available", "unavailable"]),
      rateType: z.enum(["apr", "apy"]).optional(),
      usd: z
        .object({
          day: FarmingControlDecimalSchema,
          month: FarmingControlDecimalSchema,
          year: FarmingControlDecimalSchema,
        })
        .nullable()
        .optional(),
      reasons: z.array(text).optional(),
    })
    .optional(),
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
export const FarmingControlWalletAttributionSchema = z.object({
  complete: z.boolean(),
});
export const FarmingControlPortfolioSchema = z.object({
  ...meta,
  scope: FarmingControlPortfolioScopeSchema.nullable(),
  walletVisibility: FarmingControlWalletVisibilitySchema.nullable(),
  walletAttribution: FarmingControlWalletAttributionSchema.optional(),
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
const riskSeverity = z.enum(["info", "warning", "critical"]);
export const FarmingControlRiskSignalSchema = z.object({
  key: text,
  family: text.optional(),
  label: text,
  status: text,
  severity: riskSeverity.nullable(),
  sourceSeverity: text.nullable(),
  coverage: z.enum(["current", "partial", "unknown", "unavailable"]),
  value: amount,
  format: z.enum(["fraction", "ratio", "amount", "text"]),
  unit: text.nullable(),
  summary: text,
  metrics: z
    .array(
      z.object({
        key: text,
        label: text,
        value: amount,
        format: z.enum(["fraction", "ratio", "amount", "text"]),
        unit: text.nullable(),
      }),
    )
    .max(8)
    .optional(),
});
export type FarmingControlRiskSignal = z.infer<typeof FarmingControlRiskSignalSchema>;
/** Dated source evidence; it never establishes a current assessment or execution readiness. */
export const FarmingControlRiskObservationSchema = z.object({
  observedAtMs: ms,
  collectedAtMs: ms,
  blockNumber: z.string().regex(/^\d+$/).max(128),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  metrics: z.object({
    accountAssets: amount.default(null),
    withdrawableAssets: amount.default(null),
    liquidityAssets: amount.default(null),
    withdrawableFraction: amount,
    exitBufferRatio: amount,
    utilizationFraction: amount,
    largestAllocationFraction: amount,
  }),
});
export const FarmingControlRiskMonitorControlSchema = z.object({
  desiredState: z.enum(["stopped", "running", "unknown"]),
  actualState: z.enum([
    "stopped",
    "starting",
    "warming_up",
    "running",
    "stopping",
    "degraded",
    "unavailable",
    "unknown",
  ]),
  controlSync: z.enum(["in_sync", "pending", "unavailable", "unknown"]),
});
export const FarmingControlRiskHistorySchema = z.object({
  status: z.enum(["ready", "disabled", "degraded"]),
  window: z.enum(["1h", "24h", "7d"]).optional(),
  requestedFromMs: ms,
  requestedThroughMs: ms,
  truncated: z.boolean(),
  recordsRead: count,
});
export const FarmingControlRiskExposureSchema = z.object({
  id: text,
  protocol: z.enum(["Morpho Blue", "Morpho vault", "Curve pool"]),
  kind: z.enum(["market", "vault", "pool"]),
  label: text,
  chainId: z.number().int().positive(),
  monitorKey: text,
  subject: z.object({
    kind: z.enum(["market", "vault", "pool"]),
    id: text,
    address: text.nullable(),
  }),
  positions: z.array(z.object({ id: text, label: text })).max(64),
  dataStatus: text,
  assetSymbol: text.optional(),
  capacityState: z.enum(["verified", "lower_bound", "unavailable", "blocked"]).optional(),
  capacityMethod: text.nullable().optional(),
  monitorControl: FarmingControlRiskMonitorControlSchema.nullable().optional(),
  currentObservation: FarmingControlRiskObservationSchema.nullable().optional(),
  lastKnownObservation: FarmingControlRiskObservationSchema.extend({
    source: z.enum(["accepted_finalized_history", "aged_live"]),
  })
    .nullable()
    .optional(),
  history: FarmingControlRiskHistorySchema.optional(),
  observedAtMs: ms.nullable(),
  collectedAtMs: ms.nullable(),
  blockNumber: text.nullable(),
  blockHash: text.nullable(),
  signals: z.array(FarmingControlRiskSignalSchema).max(64),
  // Maximum verified native assessment severity, never an overall safety rating.
  maxSeverity: riskSeverity.nullable(),
  coverage: z.enum(["partial", "unknown"]),
  limitations: z.array(text).max(64),
});
export type FarmingControlRiskExposure = z.infer<typeof FarmingControlRiskExposureSchema>;
export type FarmingControlRiskCard = FarmingControlRiskExposure;

export const FarmingControlRiskSchema = z.object({
  exposures: z.array(FarmingControlRiskExposureSchema).max(64),
  exposureScope: z.object({
    discovery: z.enum(["complete", "partial", "unavailable"]),
    walletVisibilityRevision: ms.nullable(),
    activePositionCount: count.nullable(),
    coveredPositionCount: count,
    uncoveredPositionCount: count.nullable(),
  }),
  ...meta,
  alerts: z.array(FarmingControlAlertSchema),
  assessments: z.array(FarmingControlAssessmentSchema),
  monitors: z.array(FarmingControlMonitorSchema),
  sourceAvailability: z.object({
    morpho: FarmingControlSourceAvailabilitySchema,
    curve: FarmingControlSourceAvailabilitySchema,
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
