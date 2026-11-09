import * as z from "zod";
import {
  FarmingControlDecimalSchema,
  FarmingControlRiskExposureSchema,
} from "./farming-control.js";

const ms = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const text = z.string().max(4_000);
const status = z.enum(["unknown", "healthy", "attention", "action_required"]);
const assessment = z.object({
  family: text,
  subjectKey: text.nullable(),
  status,
  severity: text,
  summary: text,
  indicators: z
    .record(z.string().max(200), FarmingControlDecimalSchema.max(512))
    .refine((value) => Object.keys(value).length <= 128),
});
const point = assessment.extend({ observedAtMs: ms });
export const FarmingControlRiskReviewInputSchema = z
  .object({
    window: z.enum(["24h", "7d"]).optional(),
    monitorKey: z.string().min(1).max(500).optional(),
  })
  .strict();
export type FarmingControlRiskReviewInput = z.infer<typeof FarmingControlRiskReviewInputSchema>;

/** Generic Monitoring evidence; holdings and wallet display scope are deliberately not inferred. */
export const FarmingControlMonitoringEvidenceSchema = z.object({
  schemaVersion: z.literal("hot-monitoring-evidence.v1"),
  asOfMs: ms,
  window: z.enum(["24h", "7d"]),
  requestedFromMs: ms,
  executionEligible: z.literal(false),
  population: z.object({
    configuredCount: count,
    runningDesiredCount: count,
    excludedStoppedCount: count,
    basis: z.literal("all_desired_running_monitors"),
  }),
  items: z
    .array(
      z.object({
        monitorKey: z.string().min(1).max(500),
        label: text,
        exposureRole: z.literal("not_evaluated"),
        current: z.object({
          status: z.enum(["live", "unavailable"]),
          observedAtMs: ms.nullable(),
          collectedAtMs: ms.nullable(),
          assessments: z.array(assessment).max(256),
        }),
        emergency: z.object({ status }),
        history: z.object({
          status: z.enum(["ready", "disabled", "degraded"]),
          recordsRead: count,
          truncated: z.boolean(),
          oldestObservedAtMs: ms.nullable(),
          newestObservedAtMs: ms.nullable(),
          sampleCount: count,
          transitionCount: count,
        }),
        trend: z.object({
          status: z.enum(["worsening", "improving", "mixed", "unchanged", "insufficient_evidence"]),
          materialSignals: z
            .array(
              z.object({
                family: text,
                lineageKey: text,
                metric: text,
                direction: z.enum(["worsening", "improving"]),
                firstValue: FarmingControlDecimalSchema.max(512),
                lastValue: FarmingControlDecimalSchema.max(512),
                absoluteDelta: FarmingControlDecimalSchema.max(512),
                relativeDelta: FarmingControlDecimalSchema.max(512).nullable(),
                unit: z.enum(["raw_asset_units", "fraction", "reference_per_lp"]),
                threshold: z.object({
                  kind: z.enum(["relative", "absolute"]),
                  value: FarmingControlDecimalSchema.max(512),
                  minDistinctObservations: z.literal(3),
                  minSpanMs: z.literal(1_800_000),
                }),
                distinctObservations: count,
                fromMs: ms,
                throughMs: ms,
                reason: text,
              }),
            )
            .max(256),
          families: z
            .array(
              z.object({
                family: text,
                lineageKey: text,
                currentLineage: z.boolean().optional(),
                first: point,
                last: point,
                sampleCount: count,
              }),
            )
            .max(256),
        }),
        limitations: z.array(text).max(128),
      }),
    )
    .max(1_000),
});
export type FarmingControlMonitoringEvidence = z.infer<
  typeof FarmingControlMonitoringEvidenceSchema
>;
/** Dated archive evidence only; never a current health or transport projection. */
export const FarmingControlRiskEpisodeHistorySchema = z.object({
  state: z.enum(["not_requested", "partial", "unavailable", "disabled"]),
  coverage: z.literal("unknown"),
  fromMs: ms,
  throughMs: ms,
  recordsRead: count,
  truncated: z.boolean(),
  transitions: z
    .array(
      z.object({
        id: z.string().max(256),
        monitorKey: z.string().max(500),
        runtimeInstanceId: z.string().max(256),
        subjectKey: z.string().max(500),
        policyKey: z.string().max(500).nullable(),
        episodeOpenedAtMs: ms.nullable(),
        occurredAtMs: ms,
        recordedAtMs: ms,
        transition: z.enum(["opened", "updated", "resolved"]),
        severity: z.enum(["info", "warning", "critical"]).nullable(),
        finality: z.enum(["latest", "finalized"]).nullable(),
        blockNumber: z.string().max(256).nullable(),
        blockHash: z.string().max(256).nullable(),
      }),
    )
    .max(200),
  limitations: z.array(text).max(8),
});
export type FarmingControlRiskEpisodeHistory = z.infer<
  typeof FarmingControlRiskEpisodeHistorySchema
>;

export const FarmingControlRiskInterpretationsSchema = z.object({
  state: z.enum(["not_requested", "partial", "unavailable"]),
  asOfMs: ms,
  truncated: z.boolean(),
  runs: z
    .array(
      z.object({
        runId: z.string().max(500),
        eventId: z.string().max(600),
        kind: z.enum(["emergency", "material_trend", "weekly_review"]),
        scope: z.enum(["selected_monitor", "monitoring_universe"]),
        triggeredAtMs: ms,
        occurredAtMs: ms.nullable(),
        episodeOpenedAtMs: ms.nullable(),
        subjectKey: z.string().max(500).nullable(),
        policyKey: z.string().max(500).nullable(),
        transition: z.enum(["opened", "updated", "resolved"]).nullable(),
        runStatus: z.string().max(100).nullable(),
        analysisStatus: z.enum(["pending", "failed", "indeterminate"]),
        messageId: z.null(),
      }),
    )
    .max(40),
  limitations: z.array(text).max(8),
});
export type FarmingControlRiskInterpretations = z.infer<
  typeof FarmingControlRiskInterpretationsSchema
>;

export const FarmingControlRiskReviewSchema = z.object({
  state: z.enum(["available", "partial", "unavailable"]),
  fetchedAtMs: ms,
  asOfMs: ms.nullable(),
  sources: z.array(text),
  issues: z.array(text),
  selectionStatus: z.enum(["all_subjects", "matched", "absent_subject", "unavailable"]),
  evidence: FarmingControlMonitoringEvidenceSchema.nullable(),
  exposureAssociationStatus: z.enum([
    "not_requested",
    "matched_visible_holding",
    "unproven",
    "unavailable",
  ]),
  linkedExposure: FarmingControlRiskExposureSchema.nullable(),
  currentFinality: z.literal("not_exposed").optional(),
  episodeHistory: FarmingControlRiskEpisodeHistorySchema.optional(),
  interpretations: FarmingControlRiskInterpretationsSchema.optional(),
});
export type FarmingControlRiskReview = z.infer<typeof FarmingControlRiskReviewSchema>;

export const FarmingControlRiskResearchSchema = z.object({
  fetchedAtMs: ms,
  untrusted: z.literal(true),
  scope: z.literal("fixed_official_public_sources"),
  sources: z
    .array(
      z.object({
        key: text,
        protocol: text,
        url: z.string().url(),
        state: z.enum(["available", "unavailable"]),
        fetchedAtMs: ms,
        title: text.nullable(),
        publishedAtMs: ms.nullable(),
        modifiedAtMs: ms.nullable(),
        contentHash: z.string().nullable(),
        text: z.string().max(12_000).nullable(),
        truncated: z.boolean(),
        issue: text.nullable(),
      }),
    )
    .max(5),
  limitations: z.array(text),
});
export type FarmingControlRiskResearch = z.infer<typeof FarmingControlRiskResearchSchema>;
