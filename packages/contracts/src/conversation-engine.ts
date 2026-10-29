import { z } from "zod";

const score = z.number().min(0).max(1);
const grade = z.number().int().min(1).max(3);
const timestamp = z.string().max(128);
const text = z.string().max(65_536);

export const ConversationEngineAxesSchema = z.object({
  trust: score,
  intrigue: score,
  intimacy: score,
  tension: score,
});
export type ConversationEngineAxes = z.infer<typeof ConversationEngineAxesSchema>;

const sixAxes = ConversationEngineAxesSchema.extend({ warmth: score, patience: score });
const deltas = z.object({
  warmth: z.number(),
  trust: z.number(),
  intrigue: z.number(),
  intimacy: z.number(),
  patience: z.number(),
  tension: z.number(),
});

/** Explicit public projection; upstream identities, credentials and arbitrary JSON stay private. */
export const ConversationEngineInspectionSchema = z.object({
  profile: z.object({
    location: text.nullable(),
    occupation: text.nullable(),
    currentSituation: text.nullable(),
    desires: text.nullable(),
    vulnerabilities: text.nullable(),
    habits: text.nullable(),
    personalValues: text.nullable(),
    likes: z.array(text).max(500),
    dislikes: z.array(text).max(500),
    relationships: z.array(text).max(500),
    updatedAt: timestamp.nullable(),
  }),
  affinity: sixAxes
    .extend({
      ghostStreak: z.number().int().min(0),
      totalGhosts: z.number().int().min(0),
      bond: score,
      chemistry: score,
      bondTier: z.number().int().min(1).max(5),
      chemistryTier: z.number().int().min(1).max(5),
      bondLabel: z.string().max(120),
      chemistryLabel: z.string().max(120),
      updatedAt: timestamp,
    })
    .nullable(),
  latestEvent: z
    .object({
      type: z.string().max(120),
      createdAt: timestamp,
      deltas,
      bondDelta: z.number().optional(),
      chemistryDelta: z.number().optional(),
      warmthGrade: grade.optional(),
      patienceGrade: grade.optional(),
    })
    .nullable(),
  emotionalNeed: z.enum(["low", "mid", "high"]).nullable(),
  asOf: timestamp,
  changesAt: timestamp.nullable(),
  observedAt: timestamp,
  debug: z
    .object({
      feeling: text.nullable(),
      feelingUpdatedAt: timestamp.nullable(),
      persona: z.object({
        name: z.string().max(512),
        systemPrompt: text,
        tipPersonality: text.nullable(),
        timezone: z.string().max(120).nullable(),
      }),
      axes: ConversationEngineAxesSchema.nullable(),
      warmthGrade: grade.nullable(),
      patienceGrade: grade.nullable(),
      revision: z.string().min(1).max(128).nullable(),
      editable: z.boolean(),
    })
    .nullable(),
});
export type ConversationEngineInspection = z.infer<typeof ConversationEngineInspectionSchema>;

export const ConversationEngineStateSchema = z.object({
  status: z.enum(["uninitialized", "ready"]),
  engineId: z.literal("eros"),
  character: z.object({ id: z.uuid(), name: z.string() }),
  historyGeneration: z.number().int().min(0),
  inspection: ConversationEngineInspectionSchema.nullable(),
});
export type ConversationEngineState = z.infer<typeof ConversationEngineStateSchema>;

export const UpdateConversationEngineStateInput = z.object({
  botId: z.string().min(1),
  historyGeneration: z.number().int().min(0),
  expectedRevision: z.string().min(1).max(128),
  axes: ConversationEngineAxesSchema,
  warmthGrade: grade,
  patienceGrade: grade,
});
export type UpdateConversationEngineState = z.infer<typeof UpdateConversationEngineStateInput>;
