import * as z from "zod";
import { FarmingControlDecimalSchema } from "./farming-control.js";
import { FarmingControlAprHistoryPointSchema } from "./farming-control-entities.js";

const ms = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const issue = z.string().max(4_000);
/** Native dated quoted rates; neither an earned return nor a held-period average. */
export const FarmingControlPositionTrendPointSchema = FarmingControlAprHistoryPointSchema.extend({
  adapterKey: z.string().max(500),
  adapterVersion: z.string().max(500),
});
export type FarmingControlPositionTrendPoint = z.infer<
  typeof FarmingControlPositionTrendPointSchema
>;
export const FarmingControlPositionTrendMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  fromMs: ms,
  toMs: ms,
  firstRate: FarmingControlPositionTrendPointSchema.nullable(),
  lastRate: FarmingControlPositionTrendPointSchema.nullable(),
  minimumRate: FarmingControlPositionTrendPointSchema.nullable(),
  maximumRate: FarmingControlPositionTrendPointSchema.nullable(),
  adapterVersions: z.array(z.string().max(500)),
  observedPointCount: count,
  retrievalComplete: z.boolean(),
  truncated: z.boolean(),
  methodologyComparable: z.boolean(),
  methodologyCount: count,
  issues: z.array(issue),
});
export const FarmingControlPositionTrendSchema = z.object({
  positionId: z.string().min(1).max(500),
  walletVisibilityRevision: ms,
  fromMs: ms,
  toMs: ms,
  state: z.enum(["available", "partial", "unavailable"]),
  earliestRate: FarmingControlPositionTrendPointSchema.nullable(),
  latestRate: FarmingControlPositionTrendPointSchema.nullable(),
  // Entire retrieved range, withheld for incomplete retrieval or mixed rate methodologies.
  minimumRate: FarmingControlPositionTrendPointSchema.nullable(),
  maximumRate: FarmingControlPositionTrendPointSchema.nullable(),
  meanQuotedRatePercentPerYear: FarmingControlDecimalSchema.nullable(),
  meanWeighting: z.literal("equal_weight_per_saved_observation"),
  meanMaximumFractionDigits: z.literal(18),
  meanRounding: z.literal("toward_zero"),
  latestRateFreshness: z.enum(["current", "stale", "unknown"]),
  observedPointCount: count,
  pagesRead: count,
  retrievalComplete: z.boolean(),
  truncated: z.boolean(),
  sampling: z.literal("first_and_last_saved_rate_per_utc_month"),
  windowMeaning: z.literal("provider_rate_window_not_holding_period"),
  adapterVersions: z.array(z.string().max(500)),
  months: z.array(FarmingControlPositionTrendMonthSchema).max(240),
  /** Native observations sampled for display, chronologically, including the range boundaries. */
  chartPoints: z.array(FarmingControlPositionTrendPointSchema).max(366).optional(),
  methodologyComparable: z.boolean(),
  methodologyCount: count,
  issues: z.array(issue),
});
export type FarmingControlPositionTrend = z.infer<typeof FarmingControlPositionTrendSchema>;
