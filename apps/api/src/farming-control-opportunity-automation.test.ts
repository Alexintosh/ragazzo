import type { JobPublisher } from "@rakazo/adapter-kit";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { ensureFarmingControlOpportunityAutomation } from "./farming-control-opportunity-automation.js";

it("provisions two deterministic schedules repeat-safely and preserves operator pause", async () => {
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
