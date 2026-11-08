import * as z from "zod";
import { Id } from "./ids.js";

export const QueueTextSchema = z.string().trim().min(1).max(20_000);
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
});
export type ThreadQueue = z.infer<typeof ThreadQueueSchema>;
