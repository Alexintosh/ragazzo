import { z } from "zod";
import { ConversationEngineItemNameSchema } from "./conversation-engine.js";

const name = ConversationEngineItemNameSchema;
export const ConversationEngineActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("open"),
      occasion: z.enum(["first_meet", "returning", "just_opened"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      kinds: z
        .array(z.string().regex(/^[a-z_]{1,64}$/))
        .max(40)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("add_item"), itemKind: z.enum(["item", "clothing"]), name }).strict(),
  z.object({ kind: z.literal("delete_item"), itemId: z.uuid() }).strict(),
]);
export type ConversationEngineAction = z.infer<typeof ConversationEngineActionSchema>;
export const RunConversationEngineActionInput = z.object({
  botId: z.string().min(1),
  historyGeneration: z.number().int().min(0),
  actionId: z.uuid(),
  action: ConversationEngineActionSchema,
});
export type RunConversationEngineAction = z.infer<typeof RunConversationEngineActionInput>;
export const ConversationEngineActionOutcomeSchema = z.object({
  status: z.enum(["completed", "uncertain"]),
  message: z.string().max(65_536).nullable(),
});
export type ConversationEngineActionOutcome = z.infer<typeof ConversationEngineActionOutcomeSchema>;
