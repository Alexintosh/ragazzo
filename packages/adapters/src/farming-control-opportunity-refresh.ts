import * as z from "zod";

const refreshSource = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
  mode: z.string(),
  available: z.boolean(),
  pullSyncable: z.boolean(),
  activeRefreshJob: z.object({ id: z.string() }).nullable(),
  latestRefreshJob: z.object({ createdAtMs: z.number().int().nonnegative() }).nullable(),
});

// Only the deployment-provisioned scheduler uses this capability. FC owns provider
// credentials, job leases, sync results, retries and source eligibility.
export async function refreshOpportunitySources(
  scheduledAtMs: number,
  transport: {
    get(path: string): Promise<unknown>;
    post(path: string, body: unknown): Promise<unknown>;
  },
) {
  const slot = new Date(z.number().int().nonnegative().max(8.64e15).parse(scheduledAtMs));
  slot.setUTCHours(0, 0, 0, 0);
  const { items } = z
    .object({ items: z.array(refreshSource) })
    .parse(await transport.get("/intelligence/sources"));
  const eligible = items.filter(
    (s) => s.enabled && s.mode === "pull" && s.available && s.pullSyncable,
  );
  let busy = 0;
  let alreadyRequested = 0;
  let queued = 0;
  const keys = eligible.flatMap((s) => {
    if (s.activeRefreshJob) {
      busy++;
      return [];
    }
    if (s.latestRefreshJob && s.latestRefreshJob.createdAtMs >= slot.getTime()) {
      alreadyRequested++;
      return [];
    }
    return [s.key];
  });
  // One validated request per batch. On retry the FC job ledger covers even jobs
  // that committed and completed before the worker received the POST response.
  for (let offset = 0; offset < keys.length; offset += 100) {
    const sourceKeys = keys.slice(offset, offset + 100);
    const reply = z
      .object({
        jobs: z.array(
          z.object({
            source: z.object({ key: z.string() }),
            deduplicated: z.boolean(),
          }),
        ),
      })
      .parse(await transport.post("/intelligence/sources/refresh", { sourceKeys }));
    const returned = new Set(reply.jobs.map((job) => job.source.key));
    if (reply.jobs.length !== sourceKeys.length || sourceKeys.some((key) => !returned.has(key)))
      throw new Error("Farming Control did not acknowledge the requested source batch.");
    for (const job of reply.jobs) {
      if (job.deduplicated) busy++;
      else queued++;
    }
  }
  return { eligible: eligible.length, queued, alreadyRequested, busy };
}
