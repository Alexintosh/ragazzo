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
