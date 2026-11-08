import { createHash } from "node:crypto";
import type {
  FarmingControlIntelligenceInput,
  FarmingControlIntelligenceRead,
  FarmingControlRecommendationFeedbackInput,
  FarmingControlSourceRefreshInput,
} from "@rakazo/contracts";
import {
  FarmingControlIntelligenceInputSchema,
  FarmingControlRecommendationFeedbackInputSchema,
  FarmingControlSourceRefreshInputSchema,
} from "@rakazo/contracts";
import { farmingControlBaseUrl } from "./farming-control.js";
import {
  opportunityPublicationInput,
  publishOpportunityLead,
} from "./farming-control-opportunity-publication.js";
import { refreshOpportunitySources } from "./farming-control-opportunity-refresh.js";
import { scanOpportunityPopulation } from "./farming-control-opportunity-scan.js";

import { sourceRefreshReply, sourceRefreshStatus } from "./farming-control-source-refresh.js";

const MAX_BYTES = 4 * 1024 * 1024;
const excludedKey =
  /(?:secret|password|credential|authorization|cookie|private.?key|api.?key|access.?token|refresh.?token|hiddenWallet|walletAddress|portfolioSnapshot|adapterConfig|^config$|^cursorBefore$|^cursorAfter$)/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid intelligence evidence");
  return value as Record<string, unknown>;
}
/** Secret-bearing transport/config fields never enter the model projection. */
function clean(value: unknown, depth = 0): unknown {
  if (depth > 18) throw new Error("Evidence nesting limit");
  if (typeof value === "string") {
    const safe = value.replace(/https?:\/\/[^\s<>"']+/g, (match) => {
      try {
        const url = new URL(match);
        if (url.username || url.password || url.search || url.hash) {
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.toString();
        }
      } catch {
        return "[invalid URL]";
      }
      return match;
    });
    return safe.length > 20_000 ? `${safe.slice(0, 20_000)} [excerpt truncated]` : safe;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Evidence collection limit");
    return value.map((entry) => clean(entry, depth + 1));
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !excludedKey.test(key))
        .map(([key, entry]) => [key, clean(entry, depth + 1)]),
    );
  return value;
}
function pick(value: unknown, fields: readonly string[]) {
  const data = object(value);
  return clean(
    Object.fromEntries(fields.filter((key) => key in data).map((key) => [key, data[key]])),
  ) as Record<string, unknown>;
}
function list(value: unknown, limit = 1_000): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("Invalid intelligence list");
  return value;
}
function recommendation(value: unknown) {
  const data = object(value);
  const result = pick(data, [
    "id",
    "opportunityId",
    "positionId",
    "analysisRunId",
    "reportId",
    "action",
    "status",
    "summary",
    "scoreDecimal",
    "confidenceDecimal",
    "validUntilMs",
    "createdAtMs",
  ]);
  if (typeof result.id !== "string" || typeof result.positionId !== "string")
    throw new Error("Invalid recommendation identity");
  result.payload = data.payload
    ? pick(data.payload, [
        "risks",
        "expectedImpact",
        "economics",
        "netEconomics",
        "unknowns",
        "counterarguments",
        "invalidationConditions",
        "evidence",
        "citations",
      ])
    : {};
  return result;
}
function candidateContext(value: unknown) {
  const data = object(value);
  return {
    metricSignals: list(data.metricSignals ?? []).map((item) =>
      pick(item, [
        "id",
        "positionId",
        "sourceId",
        "sourceItemId",
        "metricKey",
        "valueDecimal",
        "unit",
        "confidenceDecimal",
        "observedAtMs",
        "recordedAtMs",
        "metadata",
      ]),
    ),
    claims: list(data.claims ?? []).map((item) =>
      pick(item, [
        "id",
        "authoritySourceId",
        "sourceItemId",
        "assertionKind",
        "status",
        "summary",
        "confidenceDecimal",
        "observedAtMs",
        "validUntilMs",
        "citations",
      ]),
    ),
    report: data.report
      ? pick(data.report, [
          "id",
          "kind",
          "summary",
          "scoreDecimal",
          "confidenceDecimal",
          "observedAtMs",
          "recordedAtMs",
          "references",
        ])
      : null,
  };
}
function refreshJob(value: unknown) {
  if (!value) return null;
  const job = object(value);
  return {
    ...pick(job, [
      "id",
      "status",
      "attempts",
      "maxAttempts",
      "runAfterMs",
      "createdAtMs",
      "updatedAtMs",
    ]),
    failureClass: job.lastError == null ? null : "refresh_job_failed",
    sourceSync: job.sourceSync
      ? {
          ...pick(job.sourceSync, ["id", "status", "startedAtMs", "finishedAtMs"]),
          failureClass: object(job.sourceSync).error == null ? null : "source_sync_failed",
        }
      : null,
  };
}
function project(action: FarmingControlIntelligenceInput["action"], value: unknown): unknown {
  const data = object(value);
  if (action === "sources")
    return {
      items: list(data.items).map((item) => {
        const source = object(item);
        return {
          ...pick(source, [
            "id",
            "key",
            "label",
            "kind",
            "mode",
            "enabled",
            "available",
            "pullSyncable",
            "pushIngestable",
            "adapterKey",
            "updatedAtMs",
          ]),
          latestSync: source.latestSync
            ? {
                ...pick(source.latestSync, ["id", "status", "startedAtMs", "finishedAtMs"]),
                failed: object(source.latestSync).error != null,
              }
            : null,
          latestRefreshJob: refreshJob(source.latestRefreshJob),
          activeRefreshJob: refreshJob(source.activeRefreshJob),
        };
      }),
      adapters: list(data.adapters ?? []).map((item) =>
        pick(item, ["key", "version", "label", "kind"]),
      ),
      refreshed: false,
    };
  if (action === "universe")
    return {
      ...pick(data, ["contractVersion", "generatedAtMs", "activeVersionIds", "counts"]),
      sets: list(data.sets).map((item) => {
        const set = object(item);
        const memberships = Array.isArray(set.memberships) ? set.memberships : [];
        return {
          identity: pick(set.identity, ["id", "key", "archivedAtMs"]),
          version: pick(set.version, [
            "id",
            "label",
            "version",
            "intelligenceEnabled",
            "createdAtMs",
          ]),
          membershipCounts: {
            total: memberships.length,
            include: memberships.filter((member) => object(member).mode === "include").length,
            exclude: memberships.filter((member) => object(member).mode === "exclude").length,
          },
        };
      }),
    };
  if (action === "objectives")
    return {
      assetSet: pick(data.assetSet, ["key", "label", "archivedAtMs"]),
      objective: data.objective
        ? pick(data.objective, [
            "id",
            "version",
            "metricKey",
            "metricUnit",
            "boundarySemantics",
            "bands",
            "createdAtMs",
          ])
        : null,
      actualsIncluded: false,
      note: "Objective policy only. Compare against the separate saved-wallet-scoped portfolio read; canonical objective actuals are excluded.",
    };
  if (action === "preferences")
    return pick(data, [
      "profileKey",
      "version",
      "status",
      "label",
      "createdAtMs",
      "payload",
      "signals",
    ]);
  if (action === "screen")
    return {
      criteria: pick(data.criteria, [
        "assetSetKey",
        "assetSetVersionId",
        "assetSetVersion",
        "activeAssetSetVersionIds",
        "minimumTvlUsd",
        "minimumGrade",
        "networkFamily",
        "exposureScope",
        "sort",
        "direction",
      ]),
      items: list(data.items, 100).map((item) =>
        pick(item, [
          "id",
          "opportunityId",
          "positionId",
          "status",
          "summary",
          "sourceKey",
          "protocol",
          "chain",
          "exposure",
          "metrics",
          "enrichment",
          "predictive",
          "operatorFeedback",
          "protocolNotes",
          "operatorMetadata",
          "dataQuality",
          "evidenceIds",
        ]),
      ),
      page: pick(data.page, ["count", "total", "hasMore", "nextCursor"]),
      note: "Discovery evidence only. Missing enrichment requires diligence; APR and APY retain their source units. Follow nextCursor sequentially with identical filters before claiming complete comparison.",
    };
  if (action === "discovery")
    return {
      items: list(data.items, 25).map((item) =>
        pick(item, [
          "id",
          "opportunityId",
          "positionId",
          "status",
          "summary",
          "sourceKey",
          "kind",
          "protocol",
          "chain",
          "exposureAssets",
          "publicUrl",
          "apr",
          "apy",
          "tvlUsd",
          "pharos",
          "featured",
          "discoveredAtMs",
          "updatedAtMs",
        ]),
      ),
      page: pick(data.page, ["count", "total", "hasMore", "nextCursor"]),
      filters: pick(data.filters, ["sort", "direction", "featured"]),
      screened: false,
      publicationAuthorization: false,
      note: "Scoped Discovery includes APR-only evidence. It does not establish current Asset Set eligibility or a complete risk review. Preserve APR/APY units; resolve the exact Opportunity for follow-up. Only a separate current eligible screen can support publication.",
    };
  if (action === "recommendations")
    return {
      items: list(data.items, 100).map(recommendation),
      coverage: "bounded_recent_history",
      returnedCount: list(data.items, 100).length,
      completeHistory: false,
    };
  if (action === "recommendation")
    return {
      recommendation: recommendation(data.recommendation),
      candidate: data.candidate
        ? pick(data.candidate, ["id", "positionId", "status", "summary"])
        : null,
      candidateContext: candidateContext(data.candidateContext),
      feedback: clean(list(data.feedback ?? [])),
    };
  if (action === "opportunity")
    return {
      opportunity: pick(data.opportunity, ["id", "positionId", "status", "summary", "metadata"]),
      candidateContext: candidateContext(data.candidateContext),
      currentRecommendation: data.currentRecommendation
        ? recommendation(data.currentRecommendation)
        : null,
      recommendations: list(data.recommendations ?? []).map(recommendation),
      feedback: clean(list(data.feedback ?? [])),
    };
  // Only exact, operator-selected source items are available. No bulk artifact reads.
  const item = data.item ?? data;
  return pick(item, [
    "id",
    "sourceId",
    "externalKey",
    "version",
    "publishedAtMs",
    "observedAtMs",
    "fetchedAtMs",
    "locator",
    "contentHash",
    "contentType",
    "rawText",
    "raw",
    "extracted",
    "recordedAtMs",
  ]);
}
function readPath(input: FarmingControlIntelligenceInput): string {
  switch (input.action) {
    case "refresh_status":
      return `/intelligence/sources/refresh-jobs/${encodeURIComponent(input.jobId)}`;
    case "sources":
      return "/intelligence/sources";
    case "universe":
      return "/intelligence/asset-universe";
    case "preferences":
      return "/intelligence/preferences/profile";
    case "objectives":
      return `/asset-sets/${encodeURIComponent(input.assetSetKey)}/objective`;
    case "discovery": {
      const query = new URLSearchParams({
        sort: "updated",
        direction: "desc",
        limit: String(input.limit ?? 10),
      });
      if (input.search) query.set("search", input.search);
      if (input.sourceKey) query.set("sourceKey", input.sourceKey);
      if (input.cursor) query.set("cursor", input.cursor);
      return `/intelligence/discovery?${query}`;
    }
    case "scan":
      throw new Error("Scan uses sequential bounded screening");
    case "screen": {
      const { action: _action, ...filters } = input;
      const query = new URLSearchParams({
        minimumTvlUsd: "1000000",
        limit: "10",
        exposureScope: "single_set",
        evmOnly: "true",
        sort: "apy",
        direction: "desc",
      });
      for (const [key, value] of Object.entries(filters)) query.set(key, String(value));
      return `/intelligence/screening?${query}`;
    }
    case "recommendations": {
      const query = new URLSearchParams({ limit: String(input.limit ?? 20) });
      if (input.status) query.set("status", input.status);
      if (input.candidatePositionId) query.set("candidatePositionId", input.candidatePositionId);
      return `/intelligence/recommendations?${query}`;
    }
    case "recommendation":
      return `/intelligence/recommendations/${encodeURIComponent(input.recommendationId)}`;
    case "opportunity":
      return `/intelligence/opportunities/${encodeURIComponent(input.opportunityId)}`;
    case "evidence":
      return `/intelligence/sources/${encodeURIComponent(input.sourceKey)}/items/${encodeURIComponent(input.itemId)}`;
  }
}
async function bounded(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Intelligence unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Evidence too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function createFarmingControlIntelligence(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const origin = farmingControlBaseUrl(options.baseUrl);
  const http = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  async function performRequest(path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, origin);
    if (
      url.origin !== origin ||
      (!url.pathname.startsWith("/intelligence/") &&
        !(body === undefined && /^\/asset-sets\/[^/]+\/objective$/.test(url.pathname)))
    )
      throw new Error("Unsupported path");
    return bounded(
      await http(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      }),
    );
  }
  // The retained embedded-SQLite screen is one resource: pages must never overlap.
  let screenTail: Promise<unknown> = Promise.resolve();
  let feedbackTail: Promise<unknown> = Promise.resolve();
  function request(path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith("/intelligence/screening?")) return performRequest(path, body);
    const next = screenTail.then(() => performRequest(path, body));
    screenTail = next.catch(() => undefined);
    return next;
  }
  async function writeFeedback(raw: FarmingControlRecommendationFeedbackInput, requestKey: string) {
    const { recommendationId, operatorQuote, note, ...body } =
      FarmingControlRecommendationFeedbackInputSchema.parse(raw);
    const path = `/intelligence/recommendations/${encodeURIComponent(recommendationId)}`;
    const marker = `[rakazo-feedback:v1:${createHash("sha256").update(requestKey).update(recommendationId).digest("hex")}]`;
    const before = object(await request(path));
    if (object(before.recommendation).id !== recommendationId)
      throw new Error("Recommendation mismatch");
    const existing = list(before.feedback ?? []).find((item) =>
      String(object(item).comment ?? "").includes(marker),
    );
    let result: unknown = existing ? { feedback: existing, replayed: true } : null;
    if (!existing) {
      try {
        result = await request(`${path}/feedback`, {
          ...body,
          note: `${operatorQuote}${note ? `\n\n${note}` : ""}\n\n${marker}`,
        });
      } catch {
        /* Ambiguous POST: reread below, never retry the mutation. */
      }
    }
    const after = object(await request(path));
    if (object(after.recommendation).id !== recommendationId)
      throw new Error("Recommendation changed during feedback reread");
    const saved = list(after.feedback ?? []).find((item) =>
      String(object(item).comment ?? "").includes(marker),
    );
    if (saved && object(saved).targetId !== recommendationId)
      throw new Error("Feedback target mismatch");
    if (!saved)
      return {
        state: "uncertain",
        recommendationId,
        issues: [
          "Feedback could not be confirmed. Reread the exact recommendation before retrying; no automatic POST retry occurred.",
        ],
      };
    return {
      state: "recorded",
      recommendationId,
      feedback: clean(saved),
      replayed: Boolean(existing),
      recommendation: recommendation(after.recommendation),
      preferenceProfile: project("preferences", await request("/intelligence/preferences/profile")),
      resultConfirmed: result !== null,
    };
  }
  return {
    async refreshSources(raw: FarmingControlSourceRefreshInput) {
      const input = FarmingControlSourceRefreshInputSchema.parse(raw);
      // Pin eligibility before submitting exact keys. FC revalidates each whole
      // batch; this never enables/configures sources or expands the preflight set.
      const before = object(await request("/intelligence/sources"));
      const sources = list(before.items).map(object);
      const selected =
        input.scope === "source"
          ? sources.filter((source) => source.key === input.sourceKey)
          : sources.filter((source) => source.enabled === true);
      const reason = (source: Record<string, unknown>) =>
        source.enabled !== true
          ? "source_disabled"
          : source.mode !== "pull"
            ? "source_not_pull"
            : source.available !== true
              ? "source_unavailable"
              : source.pullSyncable !== true
                ? "source_not_refreshable"
                : null;
      const skipped = selected
        .filter((source) => reason(source) !== null)
        .map((source) => ({
          source: pick(source, ["id", "key", "label"]),
          reason: reason(source),
        }));
      const eligible = selected.filter((source) => reason(source) === null);
      if (input.scope === "source" && (selected.length !== 1 || skipped.length))
        return {
          state: "rejected",
          fetchedAtMs: now(),
          jobs: [],
          skipped,
          issues: [
            "The requested source must already exist and be an enabled, available pull source. No refresh request was sent.",
          ],
        };
      const requestedSourceKeys = eligible.map((source) => {
        if (typeof source.key !== "string" || typeof source.id !== "string")
          throw new Error("Invalid source identity");
        return source.key;
      });
      if (!requestedSourceKeys.length)
        return {
          state: "empty",
          fetchedAtMs: now(),
          jobs: [],
          skipped,
          requestedSourceKeys,
          issues: ["There are no enabled, available pull sources to refresh."],
        };
      const accepted: unknown[] = [];
      // The canonical endpoint accepts at most 100 explicit keys per request.
      for (let offset = 0; offset < requestedSourceKeys.length; offset += 100) {
        const sourceKeys = requestedSourceKeys.slice(offset, offset + 100);
        try {
          const reply = sourceRefreshReply.parse(
            await request("/intelligence/sources/refresh", { sourceKeys }),
          );
          const acknowledged = new Set(reply.requestedSourceKeys);
          if (
            reply.requestedSourceKeys.length !== sourceKeys.length ||
            acknowledged.size !== sourceKeys.length ||
            sourceKeys.some((key) => !acknowledged.has(key)) ||
            reply.jobs.length !== sourceKeys.length ||
            new Set(reply.jobs.map(({ source }) => source.key)).size !== sourceKeys.length ||
            reply.jobs.some(
              ({ source, job }) =>
                !acknowledged.has(source.key) ||
                job.sourceId !== source.id ||
                eligible.find((candidate) => candidate.key === source.key)?.id !== source.id,
            )
          )
            throw new Error("Refresh acknowledgement mismatch");
          accepted.push(...reply.jobs);
        } catch {
          // FC deduplicates active jobs only. Never replay an ambiguous POST: a
          // job may already have completed before the response was lost.
          let recovery: unknown = null;
          try {
            recovery = project("sources", await request("/intelligence/sources"));
          } catch {
            /* unavailable */
          }
          return {
            state: accepted.length ? "partial" : "uncertain",
            fetchedAtMs: now(),
            requestedSourceKeys,
            jobs: clean(accepted),
            skipped,
            sources: recovery,
            uncertainSourceKeys: sourceKeys,
            unrequestedSourceKeys: requestedSourceKeys.slice(offset + sourceKeys.length),
            issues: [
              "The current source batch could not be confirmed; later batches were not submitted. Poll accepted job IDs and inspect returned source job identities before any new request. No POST retry occurred; a latest job alone does not prove this request succeeded.",
            ],
            untrustedEvidence: true,
          };
        }
      }
      return {
        state: "accepted",
        fetchedAtMs: now(),
        requestedSourceKeys,
        jobs: clean(accepted),
        skipped,
        untrustedEvidence: true,
        issues: [
          "Accepted jobs are not successful source refreshes. Read refresh_status for every job ID until terminal, then inspect its provider outcome. No automatic completion notification is scheduled.",
        ],
      };
    },
    async refresh(scheduledAtMs: number) {
      return refreshOpportunitySources(scheduledAtMs, {
        get: (path) => request(path),
        post: (path, body) => {
          if (path !== "/intelligence/sources/refresh")
            throw new Error("Unsupported scheduled refresh");
          return request(path, body);
        },
      });
    },
    async read(raw: FarmingControlIntelligenceInput): Promise<FarmingControlIntelligenceRead> {
      const input = FarmingControlIntelligenceInputSchema.parse(raw);
      try {
        if (input.action === "scan") {
          const data = await scanOpportunityPopulation(
            input,
            async (path) => project("screen", await request(path)),
            now,
          );
          return {
            state: data.coverage.status === "complete" ? "available" : "partial",
            action: input.action,
            fetchedAtMs: now(),
            data,
            issues: data.coverage.reason ? [data.coverage.reason] : [],
            untrustedEvidence: true,
          };
        }
        const response = await request(readPath(input));
        if (input.action === "refresh_status") {
          const data = sourceRefreshStatus(response, input.jobId);
          return {
            state: "available",
            action: input.action,
            fetchedAtMs: now(),
            data: clean(data),
            issues: data.issues,
            untrustedEvidence: true,
          };
        }
        const data = object(response);
        if (input.action === "objectives" && object(data.assetSet).key !== input.assetSetKey)
          throw new Error("Objective scope mismatch");
        if (input.action === "screen" && object(data.criteria).assetSetKey !== input.assetSetKey)
          throw new Error("Screen scope mismatch");
        if (
          input.action === "recommendation" &&
          object(data.recommendation).id !== input.recommendationId
        )
          throw new Error("Recommendation identity mismatch");
        if (input.action === "opportunity" && object(data.opportunity).id !== input.opportunityId)
          throw new Error("Opportunity identity mismatch");
        if (
          input.action === "evidence" &&
          (object(data.item).id !== input.itemId ||
            object(data.source).key !== input.sourceKey ||
            object(data.item).sourceId !== object(data.source).id)
        )
          throw new Error("Source evidence identity mismatch");
        return {
          state: "available",
          action: input.action,
          fetchedAtMs: now(),
          data: project(input.action, response),
          issues: [],
          untrustedEvidence: true,
        };
      } catch {
        return {
          state: "unavailable",
          action: input.action,
          fetchedAtMs: now(),
          data: null,
          issues: [
            "The requested Intelligence evidence is unavailable or does not match the supported contract. No source refresh was performed.",
          ],
          untrustedEvidence: true,
        };
      }
    },
    async feedback(raw: FarmingControlRecommendationFeedbackInput, requestKey: string) {
      const next = feedbackTail.then(() => writeFeedback(raw, requestKey));
      feedbackTail = next.catch(() => undefined);
      return next;
    },
    async publish(input: unknown) {
      return publishOpportunityLead(opportunityPublicationInput.parse(input), {
        get: (path) => request(path),
        post: (path, body) => {
          if (path !== "/intelligence/reports") throw new Error("Unsupported research write");
          return request(path, body);
        },
      });
    },
  };
}
