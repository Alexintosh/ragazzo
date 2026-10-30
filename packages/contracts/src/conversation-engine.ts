import { z } from "zod";

const score = z.number().min(0).max(1);
const grade = z.number().int().min(1).max(3);
const timestamp = z.string().max(128);
const text = z.string().max(65_536);
const singleLine = /^[^\p{Cc}\u2028\u2029]*$/u;
const boundedLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max * 2)
    .regex(singleLine)
    .refine((value) => [...value].length <= max);

export const ConversationEngineMemoryScopeSchema = z.enum([
  "full",
  "neutral_and_relationship",
  "relationship_only",
  "neutral_only",
  "insights_only",
  "none",
]);
export const ConversationEngineAffinityScopeSchema = z.union([
  z.enum(["full", "bond_and_chemistry", "bond", "chemistry", "none"]),
  z.array(z.enum(["warmth", "trust", "intrigue", "intimacy", "patience", "tension"])).max(6),
]);
/** Native request defaults; these affect prompt context, not extraction writes. */
export const ConversationEngineSettingsSchema = z
  .object({
    tier: z
      .string()
      .regex(/^[a-z0-9_]{1,32}$/)
      .optional(),
    promptTraits: z
      .array(
        z
          .object({
            tag: z.string().regex(/^[a-z0-9_]{1,32}$/),
            text: boundedLine(2000),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    memoryScope: ConversationEngineMemoryScopeSchema.optional(),
    affinityScope: ConversationEngineAffinityScopeSchema.optional(),
    outfit: boundedLine(64).optional(),
  })
  .strict();
export type ConversationEngineSettings = z.infer<typeof ConversationEngineSettingsSchema>;
export const ConversationEngineSettingsStateSchema = z.object({
  revision: z.number().int().min(0),
  values: ConversationEngineSettingsSchema,
});
export type ConversationEngineSettingsState = z.infer<typeof ConversationEngineSettingsStateSchema>;
export const UpdateConversationEngineSettingsInput = z.object({
  botId: z.string().min(1),
  historyGeneration: z.number().int().min(0),
  expectedRevision: z.number().int().min(0),
  settings: ConversationEngineSettingsSchema,
});
export type UpdateConversationEngineSettings = z.infer<
  typeof UpdateConversationEngineSettingsInput
>;

export const ConversationEngineLifeEventSchema = z.object({
  kind: z.string().max(120),
  category: z.enum(["short", "mid", "body", "trip"]),
  offline: z.boolean(),
  startedAt: timestamp,
  endsAt: timestamp,
});
export type ConversationEngineLifeEvent = z.infer<typeof ConversationEngineLifeEventSchema>;
export const ConversationEngineItemNameSchema = boundedLine(64);
export const ConversationEngineItemSchema = z.object({
  id: z.uuid().nullable(),
  kind: z.enum(["item", "clothing"]),
  // Presets are operator-authored and are not subject to the native POST limit.
  name: text,
  source: z.enum(["preset", "gift", "caller"]),
  createdAt: timestamp.nullable(),
});
export type ConversationEngineItem = z.infer<typeof ConversationEngineItemSchema>;
export const ConversationEngineActionResultSchema = z.object({
  message: z
    .object({
      id: z.uuid(),
      text,
      sentAt: timestamp,
      occasion: z.enum([
        "holiday",
        "birthday",
        "first_meet",
        "returning",
        "just_opened",
        "event",
        "life_choice",
      ]),
    })
    .nullable(),
  event: ConversationEngineLifeEventSchema.nullable(),
});
export type ConversationEngineActionResult = z.infer<typeof ConversationEngineActionResultSchema>;

const profileSchema = z.object({
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
});

export const ConversationEngineGenerationSchema = z.object({
  tasks: z
    .array(
      z.object({
        name: z.string().max(80),
        models: z.array(z.string().max(256)).max(16),
        fallback: z.array(z.string().max(256)).max(16),
        temperature: z.number().nullable(),
        maxTokens: z.number().int().nullable(),
      }),
    )
    .max(16),
  profiles: z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).max(64),
});

export const ConversationEngineTimeSchema = z.object({
  timezone: z.string().max(120).nullable(),
  currentTime: timestamp,
  localTime: z.string().max(128).nullable(),
  affinityElapsedHours: z.number().min(0).nullable(),
  feelingElapsedHours: z.number().min(0).nullable(),
});
export const ConversationEngineEditBlockedReasonSchema = z.enum([
  "missing_affinity",
  "processing",
  "settling",
  "unacknowledged_turn",
]);

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
  profile: profileSchema,
  userProfile: profileSchema.optional(),
  needs: z
    .object({
      hunger: z.enum(["low", "mid", "high"]),
      social: z.enum(["low", "mid", "high"]),
      stamina: z.enum(["low", "mid", "high"]),
      emotional: z.enum(["low", "mid", "high"]),
      outing: z.enum(["low", "mid", "high"]),
      indulgence: z.enum(["low", "mid", "high"]),
    })
    .nullable()
    .optional(),
  effects: z
    .array(
      z.object({
        item: z.string().max(64),
        name: boundedLine(64).optional(),
        quantity: z.number().int().min(1).max(99),
        level: z.number().int().min(1).max(4),
        phase: z.enum(["rising", "peak", "fading"]),
        step: z.number().int().min(1).max(5),
        steps: z.number().int().min(1).max(5),
      }),
    )
    .max(1000)
    .optional(),
  lifeEvent: ConversationEngineLifeEventSchema.nullable().optional(),
  backgroundEvent: ConversationEngineLifeEventSchema.nullable().optional(),
  items: z.array(ConversationEngineItemSchema).max(5000).optional(),
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
      time: ConversationEngineTimeSchema.nullable().optional(),
      generation: ConversationEngineGenerationSchema.nullable().optional(),
      editBlockedReason: ConversationEngineEditBlockedReasonSchema.nullable().optional(),
      retryAfterSeconds: z.number().int().min(0).max(30).nullable().optional(),
    })
    .nullable(),
});
export type ConversationEngineInspection = z.infer<typeof ConversationEngineInspectionSchema>;

export const ConversationEngineStateSchema = z.object({
  status: z.enum(["uninitialized", "ready"]),
  engineId: z.literal("eros"),
  character: z.object({ id: z.uuid(), name: z.string() }),
  historyGeneration: z.number().int().min(0),
  settings: ConversationEngineSettingsStateSchema,
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
  elapsedHours: z.number().min(0).max(720).optional(),
});
export type UpdateConversationEngineState = z.infer<typeof UpdateConversationEngineStateInput>;
