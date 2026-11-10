import * as z from "zod";
import { Id } from "./ids.js";

export const QueueTextSchema = z.string().trim().min(1).max(20_000);
/** Read-time hint only. Actions still require the existing server checks. */
export const WaitingDetailSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("waiting"), runId: Id }),
  z.object({
    reason: z.literal("question"),
    runId: Id,
    messageId: Id,
    action: z.literal("answer"),
  }),
  z.object({
    reason: z.literal("approval"),
    runId: Id,
    messageId: Id,
    action: z.literal("review_approval"),
  }),
  z.object({
    reason: z.literal("secret"),
    runId: Id,
    messageId: Id,
    action: z.literal("provide_secret"),
  }),
  z.object({
    reason: z.literal("takeover"),
    runId: Id,
    messageId: Id,
    action: z.literal("takeover").optional(),
  }),
]);
export type WaitingDetail = z.infer<typeof WaitingDetailSchema>;
export const ThreadQueueEntrySchema = z.object({
  id: Id,
  messageId: Id,
  botId: Id,
  botName: z.string(),
  text: z.string(),
  position: z.number().int(),
  canSteer: z.boolean(),
});
export const ThreadQueueSchema = z.object({
  revision: z.number().int().nonnegative(),
  entries: z.array(ThreadQueueEntrySchema),
  canSteer: z.boolean(),
  waitingReason: z.enum(["ready", "running", "approval", "computer"]),
  waitingDetail: WaitingDetailSchema.optional(),
});
export type ThreadQueue = z.infer<typeof ThreadQueueSchema>;
