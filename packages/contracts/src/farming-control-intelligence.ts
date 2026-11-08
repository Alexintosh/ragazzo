import * as z from "zod";

const id = z.string().trim().min(1).max(500);
export const FarmingControlIntelligenceInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sources") }).strict(),
  z.object({ action: z.literal("refresh_status"), jobId: id }).strict(),
  z.object({ action: z.literal("universe") }).strict(),
  z.object({ action: z.literal("preferences") }).strict(),
  z.object({ action: z.literal("objectives"), assetSetKey: id }).strict(),
  z
    .object({
      action: z.literal("discovery"),
      search: z.string().trim().min(1).max(500).optional(),
      sourceKey: id.optional(),
      cursor: z.string().min(1).max(1_000).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    })
    .strict()
    .refine((input) => Boolean(input.search || input.sourceKey), {
      message: "Discovery requires a search or exact configured source key",
    }),
  z
    .object({
      action: z.literal("scan"),
      assetSetKey: id,
      minimumGrade: z.literal("C-").optional(),
      maxPages: z.number().int().min(1).max(10).optional(),
      cursor: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("screen"),
      assetSetKey: id,
      cursor: z.string().min(1).max(2_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      minimumTvlUsd: z
        .string()
        .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
        .max(100)
        .optional(),
      minimumGrade: z
        .enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"])
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("recommendations"),
      candidatePositionId: id.optional(),
      status: z.enum(["current", "stale", "superseded"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ action: z.literal("recommendation"), recommendationId: id }).strict(),
  z.object({ action: z.literal("opportunity"), opportunityId: id }).strict(),
  z.object({ action: z.literal("evidence"), sourceKey: id, itemId: id }).strict(),
]);
export const FarmingControlSourceRefreshInputSchema = z
  .object({
    scope: z.enum(["source", "all_enabled"]),
    sourceKey: id.optional(),
    operatorQuote: z.string().trim().min(1).max(3_500),
  })
  .strict()
  .refine(
    (input) =>
      input.scope === "source" ? Boolean(input.sourceKey) : input.sourceKey === undefined,
    {
      message: "Choose one exact source key or all enabled pull sources",
    },
  );
export type FarmingControlSourceRefreshInput = z.infer<
  typeof FarmingControlSourceRefreshInputSchema
>;

export type FarmingControlIntelligenceInput = z.infer<typeof FarmingControlIntelligenceInputSchema>;
export const FarmingControlRecommendationFeedbackInputSchema = z
  .object({
    recommendationId: id,
    operatorQuote: z.string().trim().min(1).max(3_500),
    direction: z.enum(["up", "down"]),
    reasons: z
      .array(
        z
          .object({
            category: z.enum([
              "relevance",
              "evidence",
              "portfolio_fit",
              "risk",
              "novelty",
              "timeliness",
              "accuracy",
              "actionability",
            ]),
            reasonCode: z.enum([
              "relevant",
              "not_relevant",
              "well_supported",
              "weak_evidence",
              "good_fit",
              "poor_fit",
              "risk_assessment_useful",
              "risk_assessment_wrong",
              "novel",
              "already_known",
              "timely",
              "stale",
              "correct",
              "incorrect",
              "actionable",
              "too_vague",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    note: z.string().max(1_000).optional(),
    subject: z
      .object({ kind: id, key: id, label: z.string().min(1).max(500).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type FarmingControlRecommendationFeedbackInput = z.infer<
  typeof FarmingControlRecommendationFeedbackInputSchema
>;

/** Bounded data projections; source text is evidence, never instructions or authority. */
export interface FarmingControlIntelligenceRead {
  state: "available" | "partial" | "unavailable";
  fetchedAtMs: number;
  action: FarmingControlIntelligenceInput["action"];
  data: unknown;
  issues: string[];
  untrustedEvidence: true;
}
