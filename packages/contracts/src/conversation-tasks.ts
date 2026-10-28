import * as z from "zod";
import { Id, RunStatus } from "./ids.js";

export const TaskWriteSubdirectorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => !!part && part !== "." && part !== ".."),
    "Choose an existing project subdirectory",
  );

export const ConversationTaskSchema = z.object({
  id: Id,
  threadId: Id,
  botId: Id,
  botName: z.string(),
  prompt: z.string(),
  writeSubdirectory: TaskWriteSubdirectorySchema.nullable().optional(),
  status: RunStatus,
  runId: Id,
  originThreadId: Id.nullable(),
  originBotId: Id.optional(),
  originGroupId: Id.optional(),
  originTaskId: Id.optional(),
  recoveryOfRunId: Id.nullable(),
  createdAt: z.string(),
});
export type ConversationTask = z.infer<typeof ConversationTaskSchema>;

export const StoppedConversationRunSchema = z.object({
  runId: Id,
  taskId: Id,
  botId: Id,
  botName: z.string(),
  prompt: z.string(),
  status: z.enum(["failed", "cancelled"]),
  error: z.string().nullable(),
  recoveredTaskId: Id.nullable(),
  createdAt: z.string(),
});
export type StoppedConversationRun = z.infer<typeof StoppedConversationRunSchema>;
