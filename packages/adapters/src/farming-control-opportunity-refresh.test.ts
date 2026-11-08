import { expect, it, vi } from "vitest";
import { refreshOpportunitySources } from "./farming-control-opportunity-refresh.js";

it("queues enabled pulls once per UTC day and leaves active jobs with FC", async () => {
  const time = Date.UTC(2026, 3, 10, 8);
  const source = {
    key: "eligible",
    enabled: true,
    mode: "pull",
    available: true,
    pullSyncable: true,
    activeRefreshJob: null,
    latestRefreshJob: null,
  };
  const items = [
    source,
    { ...source, key: "push", mode: "push" },
    { ...source, key: "disabled", enabled: false },
    { ...source, key: "unknown", available: false },
    { ...source, key: "live", activeRefreshJob: { id: "active" } },
    { ...source, key: "today", latestRefreshJob: { createdAtMs: time - 1000 } },
  ];
  const post = vi.fn(async () => ({
    jobs: [{ source: { key: "eligible" }, deduplicated: false }],
  }));
  const get = vi.fn(async () => ({ items }));
  expect(await refreshOpportunitySources(time, { get, post })).toEqual({
    eligible: 3,
    queued: 1,
    alreadyRequested: 1,
    busy: 1,
  });
  expect(post).toHaveBeenCalledWith("/intelligence/sources/refresh", { sourceKeys: ["eligible"] });
  items[0] = { ...source, latestRefreshJob: { createdAtMs: time + 1 } };
  expect(await refreshOpportunitySources(time, { get, post })).toEqual({
    eligible: 3,
    queued: 0,
    alreadyRequested: 2,
    busy: 1,
  });
  expect(post).toHaveBeenCalledTimes(1);
});
