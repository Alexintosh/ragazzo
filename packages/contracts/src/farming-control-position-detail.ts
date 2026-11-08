import * as z from "zod";
import { FarmingControlDecimalSchema } from "./farming-control.js";

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4_000);
const id = z.string().min(1).max(500);
const state = z.enum(["available", "partial", "unavailable"]);
export const FarmingControlPositionDetailInputSchema = z.object({ positionId: id }).strict();
export type FarmingControlPositionDetailInput = z.infer<
  typeof FarmingControlPositionDetailInputSchema
>;
const transaction = z.object({
  chainId: z.string().max(100).nullable(),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  explorerUrl: z.string().url().nullable(),
});
const activity = z.object({
  id,
  kind: text,
  status: text,
  occurredAtMs: ms.nullable(),
  recordedAtMs: ms.nullable(),
  sourceId: text,
  evidenceId: id.nullable(),
  transaction: transaction.nullable(),
  amount: FarmingControlDecimalSchema.max(12_000).nullable(),
  token: text.nullable(),
});
export const FarmingControlPositionDetailSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    positionId: id,
    label: text,
    lifecycle: text,
    fetchedAtMs: ms,
    asOfMs: ms.nullable(),
    walletVisibilityRevision: ms,
    wallets: z
      .array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), label: text }))
      .max(2_000),
    walletsComplete: z.boolean(),
    opening: activity.nullable(),
    activities: z.object({
      state,
      items: z.array(activity).max(100),
      complete: z.boolean(),
      truncated: z.boolean(),
    }),
    rewards: z.object({
      state,
      complete: z.boolean(),
      truncated: z.boolean(),
      items: z
        .array(
          z.object({
            id,
            symbol: text.nullable(),
            token: text.nullable(),
            amount: FarmingControlDecimalSchema.max(12_000).nullable(),
            observedAtMs: ms.nullable(),
            sourceObservationId: id.nullable(),
            quality: z.enum(["current", "fallback", "unknown", "invalidated"]),
            readiness: text,
          }),
        )
        .max(100),
    }),
    harvesting: z.object({
      mode: z.enum(["auto", "manual", "mixed", "unknown"]),
      evidence: z.array(text).max(100),
    }),
    sources: z.array(text).max(10),
    issues: z.array(text).max(100),
  }),
  z.object({ status: z.literal("unavailable"), reason: text }),
]);
export type FarmingControlPositionDetail = z.infer<typeof FarmingControlPositionDetailSchema>;
