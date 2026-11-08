import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  FC_OPPORTUNITY_AUTOMATIONS,
  FC_OPPORTUNITY_REFRESH_AUTOMATION,
  FC_OPPORTUNITY_REFRESH_PROMPT,
  farmingControlOpportunityAutomaticPrompt,
  farmingControlOpportunityRoutineId,
  wakeFarmingControlOpportunityRoutine,
} from "./farming-control-opportunity-automation.js";

const appended = vi.hoisted(() => vi.fn(async () => ({ seq: 1 })));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appendEventInTransaction: appended,
}));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const definition = FC_OPPORTUNITY_AUTOMATIONS[0];
  const scheduledAt = new Date("2026-11-06T09:00:00Z");
  const bot = {
    id: farmingControlBotId("personal", "opportunities"),
    spaceId: "personal",
    userId: "owner",
    spawnKey: farmingControlSpawnKey("opportunities"),
    archivedAt: null,
    thread: {
      id: "dm",
      userId: "owner",
      spaceId: "personal",
      groupId: null,
      externalConversationId: null,
    },
  };
  const routine = {
    id: farmingControlOpportunityRoutineId("personal", definition.kind),
    spaceId: "personal",
    userId: "owner",
    botId: bot.id,
    threadId: "dm",
    active: true,
    nextRunAt: scheduledAt,
    updatedAt: scheduledAt,
    prompt: farmingControlOpportunityAutomaticPrompt(definition.kind),
    crons: Array.from<string>(definition.crons),
    timezone: "UTC",
    watch: null,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
  };
  const tx = {
    routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { create: vi.fn(async () => ({ id: "task" })) },
    run: {
      findUnique: vi.fn(async () => null as { id: string } | null),
      create: vi.fn(async () => ({ id: "run" })),
    },
  };
  const prisma = {
    routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
    bot: { findFirst: vi.fn(async () => bot) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const authorize = vi.fn(async () => undefined);
  const jobs = { enqueue: vi.fn(async (_job: unknown) => undefined) };
  const deps = {
    prisma,
    jobs,
    farmingControlOpportunitiesEnabled: true,
    farmingControl: { authorize, intelligence: vi.fn() },
  } as unknown as ExecutorDeps;
  return { deps, prisma, tx, bot, routine, scheduledAt, jobs, authorize };
}
it("uses fixed daily and weekly UTC schedules and durable private-chat proof", async () => {
  expect(FC_OPPORTUNITY_AUTOMATIONS.map((d) => d.crons)).toEqual([["0 9 * * *"], ["30 9 * * 1"]]);
  const f = fixture();
  expect(
    await wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt),
  ).toBe(true);
  expect(f.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "owner", spaceId: "personal" }),
  );
  expect(f.tx.run.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      botId: f.bot.id,
      threadId: "dm",
      trigger: "routine",
      routineId: f.routine.id,
      clientNonce: `fc-opportunity:v1:daily_scan:${f.routine.id}:${f.scheduledAt.toISOString()}`,
    }),
  });
  expect(appended).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      type: "routine.fired",
      payload: {
        routineId: f.routine.id,
        farmingControlOpportunityTrigger: {
          schemaVersion: "fc-opportunity-trigger.v1",
          kind: "daily_scan",
          eventId: `${f.routine.id}:${f.scheduledAt.toISOString()}`,
        },
      },
    }),
  );
  expect(f.jobs.enqueue.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
    "run.continue",
    "routine.wakeup",
  ]);
});
it("claims a scheduled occurrence atomically and does not duplicate a persisted run", async () => {
  const f = fixture();
  f.tx.routine.updateMany.mockResolvedValueOnce({ count: 0 });
  await wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt);
  expect(f.tx.task.create).not.toHaveBeenCalled();
  f.tx.run.findUnique.mockResolvedValueOnce({ id: "existing-run" });
  await wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt);
  expect(f.tx.task.create).not.toHaveBeenCalled();
  expect(f.jobs.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "run.continue",
      payload: expect.objectContaining({ runId: "existing-run" }),
    }),
  );
});
it.each(["prompt", "timezone", "webhook", "disabled", "wrong-thread"])(
  "pauses an invalid or revoked routine: %s",
  async (change) => {
    const f = fixture();
    if (change === "prompt") f.routine.prompt = "arbitrary caller instruction";
    if (change === "timezone") f.routine.timezone = "Europe/Lisbon";
    if (change === "webhook") f.routine.webhookEnabled = true;
    if (change === "disabled") f.deps.farmingControlOpportunitiesEnabled = false;
    if (change === "wrong-thread") f.bot.thread.spaceId = "another-space";
    await wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt);
    expect(f.prisma.routine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, nextRunAt: null } }),
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
  },
);
it("rechecks FC owner authorization before creating scheduled work", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("revoked"));
  await expect(
    wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt),
  ).rejects.toThrow("revoked");
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

it("refreshes through the fixed FC service without creating an agent run", async () => {
  const f = fixture();
  f.routine.id = farmingControlOpportunityRoutineId("personal", "source_refresh");
  f.routine.prompt = FC_OPPORTUNITY_REFRESH_PROMPT;
  f.routine.crons = [...FC_OPPORTUNITY_REFRESH_AUTOMATION.crons];
  const refresh = vi.fn(async () => ({ eligible: 1, queued: 1, alreadyRequested: 0, busy: 0 }));
  f.deps.farmingControl!.refreshOpportunitySources = refresh;
  f.deps.farmingControlOpportunityRefreshEnabled = true;
  f.deps.farmingControlOpportunitiesEnabled = false;
  await wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt);
  expect(refresh).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "owner", spaceId: "personal" }),
    f.scheduledAt.getTime(),
  );
  expect(f.prisma.routine.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ lastRunAt: expect.any(Date) }) }),
  );
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
  expect(f.tx.task.create).not.toHaveBeenCalled();
  expect(f.tx.run.create).not.toHaveBeenCalled();
  expect(f.jobs.enqueue).toHaveBeenCalledOnce();
});
it("leaves source-refresh occurrence retryable after a transport failure", async () => {
  const f = fixture();
  f.routine.id = farmingControlOpportunityRoutineId("personal", "source_refresh");
  f.routine.prompt = FC_OPPORTUNITY_REFRESH_PROMPT;
  f.routine.crons = [...FC_OPPORTUNITY_REFRESH_AUTOMATION.crons];
  f.deps.farmingControl!.refreshOpportunitySources = vi.fn(async () => {
    throw new Error("transport");
  });
  f.deps.farmingControlOpportunityRefreshEnabled = true;
  await expect(
    wakeFarmingControlOpportunityRoutine(f.deps, f.routine as never, f.scheduledAt),
  ).rejects.toThrow("transport");
  expect(f.prisma.routine.updateMany).not.toHaveBeenCalled();
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
});
