import { z } from "zod";
import { ArtifactSchema } from "./domain.js";
import { Id } from "./ids.js";

export const ConversationFileSchema = ArtifactSchema.extend({
  familyId: Id,
  versionCount: z.number().int().positive(),
  origin: z.enum(["attachment", "generated", "file"]),
  /** Only a message in the authorized conversation which references this version. */
  messageId: Id.nullable(),
});
export type ConversationFile = z.infer<typeof ConversationFileSchema>;

export const ConversationFilesSchema = z.object({
  items: z.array(ConversationFileSchema),
  storage: z.object({
    /** Logical stored bytes, including all versions, rather than disk capacity. */
    bytes: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
});
export type ConversationFiles = z.infer<typeof ConversationFilesSchema>;
