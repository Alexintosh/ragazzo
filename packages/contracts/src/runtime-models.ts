import { z } from "zod";
import { RuntimeKindSchema } from "./domain.js";
import { Id, ThinkingLevelSchema } from "./ids.js";

export const RuntimeModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(256),
  thinkingLevels: z.array(ThinkingLevelSchema),
  defaultThinkingLevel: ThinkingLevelSchema.nullable(),
  isDefault: z.boolean(),
});
export const RuntimeModelsSchema = z.object({
  runtimeKind: RuntimeKindSchema,
  available: z.boolean(),
  models: z.array(RuntimeModelSchema).max(1000),
  defaultModelId: z.string().nullable(),
  defaultThinkingLevel: ThinkingLevelSchema.nullable().optional(),
  reason: z.enum(["unsupported-runtime", "host-unavailable", "login-required"]).optional(),
});
export type RuntimeModels = z.infer<typeof RuntimeModelsSchema>;
export const SetRuntimeModelInput = z
  .object({
    botId: Id,
    modelId: z.string().trim().min(1).max(200).nullable(),
    thinkingLevel: ThinkingLevelSchema.nullable(),
  })
  .refine((value) => value.modelId !== null || value.thinkingLevel === null, {
    message: "Choose a model before setting reasoning effort",
    path: ["thinkingLevel"],
  });
export type SetRuntimeModelInput = z.infer<typeof SetRuntimeModelInput>;
