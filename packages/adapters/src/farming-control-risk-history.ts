import type { FarmingControlRiskEpisodeHistory } from "@rakazo/contracts";
import * as z from "zod";

export type FarmingControlRiskHistoryPath = `/monitoring/hot/monitors/${string}/history?${string}`;
const ms = z.number().int().nonnegative().safe();
const text = z.string().min(1).max(500);
const episode = z.object({
  policyKey: text,
  subjectKey: text,
  openedAtMs: ms,
  severity: z.enum(["critical", "warning", "info"]),
});
const transition = z.object({
  kind: z.literal("transition"),
  id: text.max(256),
  runtimeInstanceId: text.max(256),
  monitorKey: text,
  subjectKey: text,
  occurredAtMs: ms,
  recordedAtMs: ms,
  transitionKind: z.enum(["opened", "updated", "resolved"]),
  finality: z.enum(["latest", "finalized"]).nullable(),
  blockNumberDecimal: z.string().max(256).nullable(),
  blockHash: z.string().max(256).nullable(),
  payload: z.unknown(),
});
const pageSchema = z.object({
  schemaVersion: z.literal("hot-monitoring-history-read.v1"),
  monitorKey: text,
  status: z.enum(["ready", "disabled", "degraded"]),
  items: z.array(z.unknown()).max(200),
  nextCursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
const identity = z.object({
  kind: z.enum(["opened", "updated", "resolved"]),
  episode: episode.nullable(),
  previous: episode.nullable(),
});

/** Existing bounded history GET only. Recording order is never forwarded as event chronology. */
export async function readFarmingControlRiskHistory(input: {
  monitorKey: string;
  fromMs: number;
  throughMs: number;
  enabled: boolean;
  read<T>(
    path: FarmingControlRiskHistoryPath,
    schema: z.ZodType<T>,
    limits: {
      signal: AbortSignal;
      onBytes(bytes: number): void;
    },
  ): Promise<{ data: T | null; issue: string | null }>;
}): Promise<FarmingControlRiskEpisodeHistory> {
  const result: FarmingControlRiskEpisodeHistory = {
    state: input.enabled ? "partial" : "disabled",
    coverage: "unknown",
    fromMs: input.fromMs,
    throughMs: input.throughMs,
    recordsRead: 0,
    truncated: false,
    transitions: [],
    limitations: [
      "Dated retained transitions do not establish present health, complete interval coverage or Risk delivery. Missing history remains unknown.",
      "Sparse rows may omit original policy or episode identity; recording time and runtime lineage are preserved separately.",
    ],
  };
  if (!input.enabled) return result;
  const signal = AbortSignal.timeout(6_000);
  let bytes = 0;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  const seenRows = new Set<string>();
  for (let pages = 0; pages < 2; pages++) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const response = await input.read(
      `/monitoring/hot/monitors/${encodeURIComponent(input.monitorKey)}/history?${query}`,
      pageSchema.refine((page) => page.monitorKey === input.monitorKey),
      {
        signal,
        onBytes(size) {
          bytes += size;
          if (bytes > 2 * 1024 * 1024) throw Error("history_budget");
        },
      },
    );
    if (!response.data || response.data.status === "degraded") {
      result.state = result.recordsRead ? "partial" : "unavailable";
      result.truncated = true;
      break;
    }
    if (response.data.status === "disabled") {
      result.state = result.recordsRead ? "partial" : "disabled";
      break;
    }
    result.recordsRead += response.data.items.length;
    for (const raw of response.data.items) {
      const parsed = transition.safeParse(raw);
      if (!parsed.success) continue;
      const row = parsed.data;
      if (
        row.monitorKey !== input.monitorKey ||
        row.occurredAtMs < input.fromMs ||
        row.occurredAtMs > input.throughMs
      )
        continue;
      const rowKey = JSON.stringify([row.runtimeInstanceId, row.id]);
      if (seenRows.has(rowKey)) continue;
      seenRows.add(rowKey);
      const parsedIdentity = identity.safeParse(row.payload);
      const detail =
        parsedIdentity.success && parsedIdentity.data.kind === row.transitionKind
          ? parsedIdentity.data
          : null;
      const e = row.transitionKind === "resolved" ? detail?.previous : detail?.episode;
      const valid = e?.subjectKey === row.subjectKey && e.openedAtMs <= row.occurredAtMs ? e : null;
      if (result.transitions.length === 200) {
        result.truncated = true;
        continue;
      }
      result.transitions.push({
        id: row.id,
        monitorKey: row.monitorKey,
        runtimeInstanceId: row.runtimeInstanceId,
        subjectKey: row.subjectKey,
        policyKey: valid?.policyKey ?? null,
        episodeOpenedAtMs: valid?.openedAtMs ?? null,
        occurredAtMs: row.occurredAtMs,
        recordedAtMs: row.recordedAtMs,
        transition: row.transitionKind,
        severity:
          row.transitionKind === "resolved" ? (valid ? "info" : null) : (valid?.severity ?? null),
        finality: row.finality,
        blockNumber: row.blockNumberDecimal,
        blockHash: row.blockHash,
      });
    }
    cursor = response.data.nextCursor;
    if (!cursor) break;
    result.truncated = true;
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    // Reading a second page may finish the bounded archive, but never proves coverage.
    result.truncated = result.transitions.length === 200;
  }
  if (cursor) result.truncated = true;
  result.transitions.sort(
    (a, b) => a.occurredAtMs - b.occurredAtMs || a.recordedAtMs - b.recordedAtMs,
  );
  return result;
}
