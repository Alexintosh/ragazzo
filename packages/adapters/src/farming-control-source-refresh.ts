import * as z from "zod";

const source = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().nullable(),
});
const jobFields = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "dead", "cancelled"]),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  runAfterMs: z.number().int().nonnegative(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});
export const sourceRefreshReply = z.object({
  requestedSourceKeys: z.array(z.string().min(1)).max(1_000),
  jobs: z.array(z.object({ source, job: jobFields, deduplicated: z.boolean() })).max(1_000),
});

/** Deliberately exclude provider error text, cursor/config, leases and worker details. */
export function sourceRefreshStatus(value: unknown, expectedJobId: string) {
  const job = jobFields
    .extend({
      source,
      lastError: z.unknown().optional(),
      result: z.object({ status: z.string().optional(), reason: z.string().optional() }).nullable(),
      sourceSync: z
        .object({
          id: z.string().min(1),
          sourceId: z.string().min(1),
          status: z.enum(["running", "succeeded", "failed"]),
          startedAtMs: z.number().int().nonnegative(),
          finishedAtMs: z.number().int().nonnegative().nullable(),
        })
        .nullable(),
    })
    .parse(value);
  if (
    job.id !== expectedJobId ||
    job.source.id !== job.sourceId ||
    (job.sourceSync && job.sourceSync.sourceId !== job.sourceId)
  )
    throw new Error("Refresh identity mismatch");
  const error = z
    .object({
      code: z.enum(["worker_shutdown_requeued", "worker_sync_collision", "source_sync_failed"]),
    })
    .safeParse(job.lastError);
  const terminal = ["completed", "dead", "cancelled"].includes(job.status);
  const skipped = job.status === "completed" && job.result?.status === "skipped";
  const outcome = !terminal
    ? "pending"
    : job.status === "cancelled"
      ? "cancelled"
      : job.status === "dead"
        ? "failed"
        : skipped
          ? "skipped"
          : job.sourceSync?.status === "succeeded" && job.sourceSync.finishedAtMs !== null
            ? "succeeded"
            : job.sourceSync?.status === "failed"
              ? "failed"
              : "unconfirmed";
  return {
    ...jobFields.parse(job),
    source: job.source,
    sourceSync: job.sourceSync,
    terminal,
    outcome,
    errorCode: error.success ? error.data.code : null,
    failureClass:
      job.status === "dead"
        ? "refresh_job_failed"
        : job.sourceSync?.status === "failed"
          ? "source_sync_failed"
          : null,
    issues: [
      ...(skipped
        ? ["The worker skipped this source; no successful source refresh was confirmed."]
        : []),
      ...(outcome === "unconfirmed"
        ? ["The terminal job has no confirmed terminal source-sync result."]
        : []),
      "Nonfatal source warnings and eligibility counts are not retained by the durable refresh status contract.",
    ],
  };
}
