import type { ConversationEngineInspection } from "@rakazo/contracts";
import {
  ConversationEngineAxesSchema,
  ConversationEngineEditBlockedReasonSchema,
  ConversationEngineInspectionSchema,
  ConversationEngineTimeSchema,
} from "@rakazo/contracts";
import { z } from "zod";

const timestamp = z.string().min(1).max(128);
const text = z.string().max(65_536);
const score = z.number().min(0).max(1);
const grade = z.number().int().min(1).max(3);
const axes = ConversationEngineAxesSchema.extend({ warmth: score, patience: score });

export function parseErosInspection(
  sessionId: string,
  instanceId: string,
  characterId: string,
  raw: Record<string, unknown>[],
  debug: Record<string, unknown> | null,
): ConversationEngineInspection {
  const profile = z
    .object({
      instance_id: z.literal(instanceId),
      location: text.nullable(),
      occupation: text.nullable(),
      current_situation: text.nullable(),
      desires: text.nullable(),
      vulnerabilities: text.nullable(),
      habits: text.nullable(),
      personal_values: text.nullable(),
      likes: z.array(text).max(500),
      dislikes: z.array(text).max(500),
      relationships: z.array(text).max(500),
      updated_at: timestamp.nullable(),
    })
    .parse(raw[0]);
  const affinity = z
    .object({
      session_id: z.literal(sessionId),
      affinity: axes
        .extend({
          ghost_streak: z.number().int().min(0),
          total_ghosts: z.number().int().min(0),
          updated_at: timestamp,
          bond: score,
          chemistry: score,
          bond_tier: z.number().int().min(1).max(5),
          chem_tier: z.number().int().min(1).max(5),
          bond_label: z.string().max(120),
          chemistry_label: z.string().max(120),
        })
        .nullable(),
    })
    .parse(raw[1]).affinity;
  const event = z
    .object({
      session_id: z.literal(sessionId),
      event: z
        .object({
          event_type: z.string().max(120),
          created_at: timestamp,
          effective_deltas: z.object({
            warmth: z.number(),
            trust: z.number(),
            intrigue: z.number(),
            intimacy: z.number(),
            patience: z.number(),
            tension: z.number(),
          }),
          effective_deltas_computed: z
            .object({ bond: z.number(), chemistry: z.number() })
            .nullish(),
          state_after: z
            .object({ warmth_grade: grade.optional(), patience_grade: grade.optional() })
            .nullish(),
        })
        .nullable(),
    })
    .parse(raw[2]).event;
  const effects = z
    .object({
      needs: z.object({ emotional: z.enum(["low", "mid", "high"]) }).nullable(),
      as_of: timestamp,
      changes_at: timestamp.nullable(),
    })
    .parse(raw[3]);
  const extended =
    debug === null ? null : parseErosDebug(sessionId, instanceId, characterId, debug);
  return ConversationEngineInspectionSchema.parse({
    profile: {
      location: profile.location,
      occupation: profile.occupation,
      currentSituation: profile.current_situation,
      desires: profile.desires,
      vulnerabilities: profile.vulnerabilities,
      habits: profile.habits,
      personalValues: profile.personal_values,
      likes: profile.likes,
      dislikes: profile.dislikes,
      relationships: profile.relationships,
      updatedAt: profile.updated_at,
    },
    affinity:
      affinity === null
        ? null
        : {
            warmth: affinity.warmth,
            trust: affinity.trust,
            intrigue: affinity.intrigue,
            intimacy: affinity.intimacy,
            patience: affinity.patience,
            tension: affinity.tension,
            ghostStreak: affinity.ghost_streak,
            totalGhosts: affinity.total_ghosts,
            updatedAt: affinity.updated_at,
            bond: affinity.bond,
            chemistry: affinity.chemistry,
            bondTier: affinity.bond_tier,
            chemistryTier: affinity.chem_tier,
            bondLabel: affinity.bond_label,
            chemistryLabel: affinity.chemistry_label,
          },
    latestEvent:
      event === null
        ? null
        : {
            type: event.event_type,
            createdAt: event.created_at,
            deltas: event.effective_deltas,
            ...(event.effective_deltas_computed
              ? {
                  bondDelta: event.effective_deltas_computed.bond,
                  chemistryDelta: event.effective_deltas_computed.chemistry,
                }
              : {}),
            ...(event.state_after
              ? {
                  warmthGrade: event.state_after.warmth_grade,
                  patienceGrade: event.state_after.patience_grade,
                }
              : {}),
          },
    emotionalNeed: effects.needs?.emotional ?? null,
    asOf: effects.as_of,
    changesAt: effects.changes_at,
    observedAt: new Date().toISOString(),
    debug: extended,
  });
}

export function parseErosDebug(
  sessionId: string,
  instanceId: string,
  characterId: string,
  raw: Record<string, unknown>,
) {
  const result = z
    .object({
      sessionId: z.literal(sessionId),
      instanceId: z.literal(instanceId),
      characterId: z.literal(characterId),
      characterName: z.string().max(512),
      systemPrompt: text,
      tipPersonality: text.nullable(),
      timezone: z.string().max(120).nullable(),
      feelingClause: text.nullable(),
      feelingClauseAt: timestamp.nullable(),
      axes: ConversationEngineAxesSchema.nullable(),
      warmthGrade: grade.nullable(),
      patienceGrade: grade.nullable(),
      revision: z.string().min(1).max(128).nullable(),
      editable: z.boolean(),
      time: ConversationEngineTimeSchema.nullable().optional(),
      editBlockedReason: ConversationEngineEditBlockedReasonSchema.nullable().optional(),
      retryAfterSeconds: z.number().int().min(0).max(30).nullable().optional(),
    })
    .parse(raw);
  if (
    result.editable &&
    (!result.axes ||
      result.warmthGrade === null ||
      result.patienceGrade === null ||
      result.revision === null)
  )
    throw new Error("Invalid debug state");
  return {
    feeling: result.feelingClause,
    feelingUpdatedAt: result.feelingClauseAt,
    persona: {
      name: result.characterName,
      systemPrompt: result.systemPrompt,
      tipPersonality: result.tipPersonality,
      timezone: result.timezone,
    },
    axes: result.axes,
    warmthGrade: result.warmthGrade,
    patienceGrade: result.patienceGrade,
    revision: result.revision,
    editable: result.editable,
    time: result.time ?? null,
    editBlockedReason: result.editBlockedReason ?? null,
    retryAfterSeconds: result.retryAfterSeconds ?? null,
  };
}
