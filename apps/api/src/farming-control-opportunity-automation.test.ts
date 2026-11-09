import type { JobPublisher } from "@rakazo/adapter-kit";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { ensureFarmingControlOpportunityAutomation } from "./farming-control-opportunity-automation.js";

function fixture() {
  const rows = new Map<string, Record<string, unknown>>();
  const actor = {
    userId: "owner",
    spaceId: "personal",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const bot = {
    id: farmingControlBotId("personal", "opportunities"),
    userId: actor.userId,
    spaceId: actor.spaceId,
    spawnKey: farmingControlSpawnKey("opportunities"),
    thread: {
      id: "dm",
      userId: actor.userId,
      spaceId: actor.spaceId,
      groupId: null,
      externalConversationId: null,
    },
  };
  const prisma = {
    bot: { findFirst: vi.fn(async () => bot) },
    routine: {
      upsert: vi.fn(async ({ where, update, create }) => {
        expect(update).toEqual({});
        if (!rows.has(where.id)) rows.set(where.id, create);
        return rows.get(where.id)!;
      }),
    },
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: jobs as unknown as JobPublisher,
    farmingControlOpportunitiesEnabled: true,
    farmingControlOpportunityRefreshEnabled: false,
  };
  return { rows, actor, bot, prisma, jobs, deps };
}

it("provisions two deterministic schedules repeat-safely and preserves operator pause", async () => {
  const { rows, actor, jobs, deps } = fixture();
  await ensureFarmingControlOpportunityAutomation(deps, actor);
  expect(rows.size).toBe(2);
  for (const row of rows.values())
    expect(row).toMatchObject({
      timezone: "UTC",
      active: true,
      notify: true,
      webhookEnabled: false,
      githubEnabled: false,
    });
  const first = [...rows.values()][0]!;
  first.active = false;
  first.nextRunAt = null;
  jobs.enqueue.mockClear();
  await ensureFarmingControlOpportunityAutomation(deps, actor);
  expect(rows.size).toBe(2);
  expect(first.active).toBe(false);
  expect(jobs.enqueue).toHaveBeenCalledOnce();
  deps.farmingControlOpportunityRefreshEnabled = true;
  await ensureFarmingControlOpportunityAutomation(deps, actor);
  expect(rows.size).toBe(3);
  const refresh = [...rows.values()].find(
    (row) => row.name === "Daily opportunity source refresh",
  )!;
  expect(refresh).toMatchObject({
    crons: ["0 8 * * *"],
    timezone: "UTC",
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
  });
});

it("converges concurrent initialization and preserves custom routine state on reopen", async () => {
  const { rows, actor, jobs, deps } = fixture();
  await Promise.all([
    ensureFarmingControlOpportunityAutomation(deps, actor),
    ensureFarmingControlOpportunityAutomation(deps, actor),
  ]);
  expect(rows.size).toBe(2);
  const first = [...rows.values()][0]!;
  Object.assign(first, {
    active: false,
    prompt: "Owner's custom research scope",
    crons: ["0 12 * * 2"],
    timezone: "Europe/Lisbon",
    notify: false,
  });
  const paused = { ...first };
  jobs.enqueue.mockClear();
  await ensureFarmingControlOpportunityAutomation(deps, actor);
  expect(first).toEqual(paused);
  expect(jobs.enqueue).toHaveBeenCalledOnce();
});

it("recovers a failed wake publication using the saved routine identity and date", async () => {
  const { rows, actor, jobs, deps } = fixture();
  jobs.enqueue.mockRejectedValueOnce(new Error("synthetic wake failure"));
  await expect(ensureFarmingControlOpportunityAutomation(deps, actor)).rejects.toThrow(
    "synthetic wake failure",
  );
  const saved = { ...[...rows.values()][0]! };
  const failedJob = jobs.enqueue.mock.calls[0];
  jobs.enqueue.mockClear();
  await ensureFarmingControlOpportunityAutomation(deps, actor);
  expect(rows.size).toBe(2);
  expect(rows.get(String(saved.id))).toEqual(saved);
  expect(jobs.enqueue.mock.calls[0]).toEqual(failedJob);
});

it.each(["group", "external", "foreign-owner", "foreign-space", "missing-thread"])(
  "does not provision or enqueue routines for a %s specialist chat",
  async (mode) => {
    const { actor, bot, prisma, jobs, deps } = fixture();
    if (mode === "group") Object.assign(bot.thread, { groupId: "group" });
    if (mode === "external") Object.assign(bot.thread, { externalConversationId: "external" });
    if (mode === "foreign-owner") bot.thread.userId = "other-owner";
    if (mode === "foreign-space") bot.thread.spaceId = "other-space";
    if (mode === "missing-thread") Object.assign(bot, { thread: null });
    await expect(ensureFarmingControlOpportunityAutomation(deps, actor)).rejects.toThrow(
      "specialist is unavailable",
    );
    expect(prisma.routine.upsert).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  },
);
