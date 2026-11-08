import * as z from "zod";
import { FarmingControlPositionTrendSchema } from "./farming-control-position-trend.js";
import { FarmingControlPositionEarningsSchema } from "./farming-control-position-earnings.js";

export const FARMING_CONTROL_HISTORY_PERIODS = ["since_opening", "7d", "30d", "90d"] as const;
export const FarmingControlPositionHistoryInputSchema = z
  .object({
    positionId: z.string().min(1).max(500),
    period: z.enum(FARMING_CONTROL_HISTORY_PERIODS).optional(),
  })
  .strict();
export type FarmingControlPositionHistoryInput = z.infer<
  typeof FarmingControlPositionHistoryInputSchema
>;

const ms = z.number().int().nonnegative();
export const FarmingControlPositionHistorySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    positionId: z.string(),
    label: z.string(),
    lifecycle: z.string(),
    period: z.enum(FARMING_CONTROL_HISTORY_PERIODS),
    startEvidence: z.object({
      kind: z.enum([
        "confirmed_open",
        "confirmed_deposit",
        "tracking_started",
        "first_saved_rate",
        "unknown",
      ]),
      atMs: ms.nullable(),
    }),
    walletVisibilityRevision: ms,
    requestedThroughMs: ms,
    trend: FarmingControlPositionTrendSchema,
    earnings: FarmingControlPositionEarningsSchema.nullable(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string(),
  }),
]);
export type FarmingControlPositionHistory = z.infer<typeof FarmingControlPositionHistorySchema>;
