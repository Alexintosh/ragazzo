import * as z from "zod";

export const AGENT_ACTIVITY_LIMIT = 160;
export const AgentActivityEntrySchema = z.object({
  id: z.string(),
  runId: z.string(),
  botId: z.string().optional(),
  seq: z.number().int(),
  updatedSeq: z.number().int(),
  kind: z.enum(["tool", "thinking", "reasoning", "progress"]),
  label: z.string(),
  text: z.string().optional(),
  status: z.enum(["running", "completed", "error", "paused", "stopped"]),
  durationMs: z.number().nonnegative().optional(),
});
export type AgentActivityEntry = z.infer<typeof AgentActivityEntrySchema>;

/** Provider-authored public summary, never encrypted or raw private reasoning. */
export const AgentReasoningPayloadSchema = z
  .object({
    id: z.string().min(1).max(200),
    text: z.string().max(16_384),
    done: z.boolean(),
  })
  .strict();
