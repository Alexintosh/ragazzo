import { describe, expect, it, vi } from "vitest";
import type { FarmingControlRiskReview } from "@rakazo/contracts";
import { FarmingControlRiskReviewSchema } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  FC_RISK_AUTOMATIONS,
  farmingControlAutomaticToolDenied,
  farmingControlRiskAutomaticPrompt,
  farmingControlRiskRoutineId,
  riskTrendFingerprint,
  wakeFarmingControlRiskRoutine,
} from "./farming-control-risk-automation.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  farmingControlRiskReviewTool,
  farmingControlRiskResearchTool,
  authorizeFarmingControlRun,
} from "./run-tools-farming-control.js";

const appended = vi.hoisted(() => vi.fn(async () => ({ seq: 1 })));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appendEventInTransaction: appended,
}));
const bot = {
  id: farmingControlBotId("personal", "risk"),
  spaceId: "personal",
  userId: "owner",
  spawnKey: farmingControlSpawnKey("risk"),
  archivedAt: null,
};
function review(status = "worsening", time = 100): FarmingControlRiskReview {
  const point = {
    family: "liquidity",
    subjectKey: "pool",
    status: "healthy",
    severity: "info",
    summary: "source",
    indicators: { utilization: "0.95" },
    observedAtMs: time,
  };
  return FarmingControlRiskReviewSchema.parse({
    state: "available", fetchedAtMs: time + 1, asOfMs: time + 1,
    sources: ["/monitoring/hot/evidence?window=24h"], issues: [], selectionStatus: "all_subjects",
    exposureAssociationStatus: "not_requested", linkedExposure: null,
    evidence: { schemaVersion: "hot-monitoring-evidence.v1", asOfMs: time + 1, window: "24h",
      requestedFromMs: 0, executionEligible: false,
      population: { configuredCount: 1, runningDesiredCount: 1, excludedStoppedCount: 0,
        basis: "all_desired_running_monitors" },
      items: [{ monitorKey: "watch-only-pool", label: "Example pool", exposureRole: "not_evaluated",
        current: { status: "live", observedAtMs: time + 1, collectedAtMs: time + 1, assessments: [point] },
        emergency: { status: "attention" },
        history: { status: "ready", recordsRead: 2, truncated: false, oldestObservedAtMs: time,
          newestObservedAtMs: time + 1, sampleCount: 2, transitionCount: 1 },
        trend: { materialSignals: [], status,
          families: [{ family: "liquidity", lineageKey: "fixture", first: point,
            last: { ...point, status: "attention", observedAtMs: time + 1 }, sampleCount: 2 }] },
        limitations: [],
      }],
    },
  });
}
function authFixture() {
  const proof = {
    schemaVersion: "fc-risk-trigger.v1",
    kind: "weekly_review",
    eventId: "week-1",
    monitorKey: null,
  };
  const live = {
    id: "run",
    trigger: "routine",
    clientNonce: "fc-risk:v1:weekly_review:week-1",
    bot,
    thread: {
      id: "dm",
      userId: "owner",
      spaceId: "personal",
      botId: bot.id,
      groupId: null,
      externalConversationId: null,
    },
    sourceMessage: null,
  };
  const prisma = {
    run: { findFirst: vi.fn(async () => live) },
    event: { findFirst: vi.fn(async () => ({ payload: { farmingControlRiskTrigger: proof } })) },
    steeringMessage: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
  };
  const authorize = vi.fn(async () => undefined);
  const deps = {
    prisma,
    farmingControl: { authorize },
    farmingControlRiskAutomationEnabled: true,
  } as unknown as ExecutorDeps;
  const run = { id: "run", botId: bot.id, spaceId: "personal", userId: "owner", threadId: "dm" };
  return { deps, run, live, prisma, proof, authorize };
}
describe("trusted Risk run provenance", () => {
  it("accepts only an opted-in fixed Risk DM run with a committed proof and exact nonce", async () => {
    const f = authFixture();
    await expect(
      authorizeFarmingControlRun(f.deps, f.run, bot, { allowRiskAutomation: true }),
    ).resolves.toMatchObject({ userId: "owner", spaceId: "personal" });
    expect(f.authorize).toHaveBeenCalledOnce();
    await expect(authorizeFarmingControlRun(f.deps, f.run, bot)).rejects.toThrow();
    f.deps.farmingControlRiskAutomationEnabled = false;
    await expect(
      authorizeFarmingControlRun(f.deps, f.run, bot, { allowRiskAutomation: true }),
    ).rejects.toThrow();
  });
  it.each(["proof", "nonce", "group", "external", "webhook", "steering", "revoked"])(
    "fails closed for %s",
    async (kind) => {
      const f = authFixture();
      if (kind === "proof") f.prisma.event.findFirst.mockResolvedValueOnce(null as never);
      if (kind === "nonce") f.live.clientNonce = "routine-test:caller-input";
      if (kind === "group") f.live.thread.groupId = "fc-team:personal" as never;
      if (kind === "external") f.live.thread.externalConversationId = "outside" as never;
      if (kind === "webhook") f.live.trigger = "webhook";
      if (kind === "steering")
        f.prisma.steeringMessage.findFirst.mockResolvedValue({ id: "outside" } as never);
      if (kind === "revoked") f.authorize.mockRejectedValueOnce(new Error("scope revoked"));
      await expect(
        authorizeFarmingControlRun(f.deps, f.run, bot, { allowRiskAutomation: true }),
      ).rejects.toThrow();
    },
  );
  it("denies automatic handoffs, execution, private portfolio reads and outbound message tools", () => {
    for (const name of [
      "handoff_to_bot",
      "shell",
      "web_fetch",
      "message_user",
      "farming_control_portfolio",
      "farming_control_entity",
    ])
      expect(farmingControlAutomaticToolDenied(bot, "routine", name)).toBe(true);
    expect(farmingControlAutomaticToolDenied(bot, "routine", "farming_control_risk_review")).toBe(
      false,
    );
    expect(farmingControlAutomaticToolDenied(bot, "user", "message_user")).toBe(false);
  });
});

describe("pre-model trend gate", () => {
  it("uses exact deterministic assessment bands, excluding timestamps and sample counts", () => {
    const first = riskTrendFingerprint(review());
    expect(first?.materialKeys).toEqual(["watch-only-pool"]);
    expect(riskTrendFingerprint(review("worsening", 999))?.fingerprint).toBe(first?.fingerprint);
    expect(riskTrendFingerprint(review("improving"))?.fingerprint).not.toBe(first?.fingerprint);
    expect(riskTrendFingerprint(review("insufficient_evidence"))?.materialKeys).toEqual([]);
    const missing = review();
    missing.evidence!.items[0]!.history.truncated = true;
    expect(riskTrendFingerprint(missing)?.materialKeys).toEqual([]);
    expect(
      riskTrendFingerprint({ state: "unavailable", evidence: null } as FarmingControlRiskReview),
    ).toBeNull();
  });
  it("takes an initial baseline without a model run and advances the ordinary schedule", async () => {
    const definition = FC_RISK_AUTOMATIONS[0];
    const at = new Date(Date.now() - 1_000);
    const routine = {
      id: farmingControlRiskRoutineId("personal", definition.kind),
      spaceId: "personal",
      userId: "owner",
      botId: bot.id,
      threadId: "dm",
      active: true,
      nextRunAt: at,
      updatedAt: at,
      prompt: farmingControlRiskAutomaticPrompt(definition.kind),
      crons: [...definition.crons],
      timezone: "UTC",
      watch: null,
      watchState: null,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: { updateMany },
      bot: { findFirst: vi.fn(async () => ({ ...bot, thread: { id: "dm" } })) },
      user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
      $transaction: vi.fn(async (fn: Function) => fn({ routine: { updateMany } })),
    };
    const jobs = { enqueue: vi.fn(async (_job: unknown) => undefined) };
    const riskReview = vi.fn(async () => review());
    const deps = {
      prisma,
      jobs,
      farmingControlRiskAutomationEnabled: true,
      farmingControl: { authorize: vi.fn(async () => undefined), riskReview },
    } as unknown as ExecutorDeps;
    expect(await wakeFarmingControlRiskRoutine(deps, routine as never, at)).toBe(true);
    expect(riskReview).toHaveBeenCalledWith(expect.anything(), { window: "24h" });
    expect(jobs.enqueue).toHaveBeenCalledOnce();
    expect(jobs.enqueue.mock.calls[0]![0]).toMatchObject({ name: "routine.wakeup" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          watchState: expect.objectContaining({ schemaVersion: "fc-risk-trend.v1" }),
        }),
      }),
    );
    routine.prompt = "Caller supplied instructions";
    await wakeFarmingControlRiskRoutine(deps, routine as never, at);
    expect(riskReview).toHaveBeenCalledOnce();
  });
});

it("binds an automated emergency read to its authenticated monitor and rejects weekly research", async () => {
  const f = authFixture();
  const event = {
    schemaVersion: "fc-risk-event.v1",
    eventId: "a".repeat(64),
    monitorKey: "watch-pool",
    subjectKey: "pool",
    policyKey: "policy",
    transition: "opened",
    severity: "critical",
    occurredAtMs: 1000,
    episodeOpenedAtMs: 1000,
    blockNumber: null,
    blockHash: null,
  };
  Object.assign(f.proof, {
    kind: "emergency",
    eventId: event.eventId,
    monitorKey: event.monitorKey,
    event,
  });
  f.live.clientNonce = `fc-risk:v1:emergency:${event.eventId}`;
  const riskReview = vi.fn(async () => review());
  const riskResearch = vi.fn(async () => ({ fetchedAtMs: 1_000, untrusted: true, scope: "fixed_official_public_sources", sources: [], limitations: [] }));
  Object.assign(f.deps.farmingControl!, { riskReview, riskResearch });
  const ctx = { deps: f.deps, bot, run: f.run, thread: f.live.thread } as unknown as RunContext;
  await farmingControlRiskReviewTool(ctx, {
    name: "farming_control_risk_review",
    args: {},
  } as unknown as ToolCall);
  expect(riskReview).toHaveBeenCalledWith(expect.anything(), { monitorKey: "watch-pool" });
  const denial = await farmingControlRiskReviewTool(ctx, {
    name: "farming_control_risk_review",
    args: { monitorKey: "another-pool" },
  } as unknown as ToolCall);
  expect(denial).toHaveProperty("error");
  expect(riskReview).toHaveBeenCalledOnce();
  expect(
    await farmingControlRiskResearchTool(ctx, {
      name: "farming_control_risk_research",
      args: {},
    } as unknown as ToolCall),
  ).toHaveProperty("error");
  expect(riskResearch).not.toHaveBeenCalled();
});
it("permits fixed official-source research only with a verified weekly proof", async () => {
  const f = authFixture();
  const riskResearch = vi.fn(async () => ({ fetchedAtMs: 1_000, untrusted: true, scope: "fixed_official_public_sources", sources: [], limitations: [] }));
  Object.assign(f.deps.farmingControl!, { riskResearch });
  const ctx = { deps: f.deps, bot, run: f.run, thread: f.live.thread } as unknown as RunContext;
  expect(
    await farmingControlRiskResearchTool(ctx, {
      name: "farming_control_risk_research",
      args: {},
    } as unknown as ToolCall),
  ).toMatchObject({ modelView: "official-risk-research-compact.v1", untrusted: true, sources: [] });
  expect(riskResearch).toHaveBeenCalledOnce();
});
it("preserves a qualified numeric deterioration while assessment bands remain healthy", () => {
  const f = review("unchanged");
  f.evidence!.items[0]!.trend.materialSignals = [
    {
      family: "liquidity",
      lineageKey: "accepted-runtime",
      metric: "withdrawableFraction",
      direction: "worsening",
      threshold: { kind: "absolute", value: "0.1", minDistinctObservations: 3, minSpanMs: 1800000 },
      firstValue: "0.95",
      lastValue: "0.8",
      absoluteDelta: "-0.15",
      relativeDelta: "-0.157894736842105263",
      unit: "fraction",
      distinctObservations: 3,
      fromMs: 1000,
      throughMs: 1801000,
      reason: "Qualified numeric change",
    },
  ];
  f.evidence!.items[0]!.history.truncated = true;
  const first = riskTrendFingerprint(f)!;
  expect(first.materialKeys).toEqual(["watch-only-pool"]);
  f.evidence!.items[0]!.trend.materialSignals[0]!.lastValue = "0.79";
  expect(riskTrendFingerprint(f)!.fingerprint).toEqual(first.fingerprint);
});

function scheduleFixture(kind: "material_trend" | "weekly_review") {
  const definition = FC_RISK_AUTOMATIONS.find((item) => item.kind === kind)!;
  const at = new Date(Date.now() - 1000);
  const prior = riskTrendFingerprint(review("unchanged"))!;
  const routine = {
    id: farmingControlRiskRoutineId("personal", kind),
    spaceId: "personal",
    userId: "owner",
    botId: bot.id,
    threadId: "dm",
    active: true,
    nextRunAt: at,
    updatedAt: at,
    prompt: farmingControlRiskAutomaticPrompt(kind),
    crons: [...definition.crons],
    timezone: "UTC",
    watch: null,
    watchState: { schemaVersion: "fc-risk-trend.v1", fingerprints: prior.fingerprints },
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
  };
  const tx = {
    routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { create: vi.fn(async (_input: unknown) => ({ id: "task" })) },
    run: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (_input: unknown) => ({ id: "run" })),
    },
  };
  const prisma = {
    routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
    bot: { findFirst: vi.fn(async () => ({ ...bot, thread: { id: "dm" } })) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
    $transaction: vi.fn(async (fn: Function) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async (_input: unknown) => undefined) };
  const riskReview = vi.fn(async () => review());
  const deps = {
    prisma,
    jobs,
    farmingControlRiskAutomationEnabled: true,
    farmingControl: { authorize: vi.fn(async () => undefined), riskReview },
  } as unknown as ExecutorDeps;
  appended.mockClear();
  return { deps, routine, at, tx, jobs, riskReview };
}
it("creates a material review only for changed known subjects and persists compact evidence references", async () => {
  const f = scheduleFixture("material_trend");
  expect(await wakeFarmingControlRiskRoutine(f.deps, f.routine as never, f.at)).toBe(true);
  expect(f.tx.run.create).toHaveBeenCalledOnce();
  expect(appended).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      type: "routine.fired",
      runId: "run",
      payload: expect.objectContaining({
        farmingControlRiskTrigger: expect.objectContaining({
          kind: "material_trend",
          subjects: [
            {
              monitorKey: "watch-only-pool",
              reasons: ["liquidity: healthy -> attention"],
              fromMs: 100,
              throughMs: 101,
            },
          ],
        }),
      }),
    }),
  );
  expect(f.jobs.enqueue).toHaveBeenCalledTimes(2);
  const initial = scheduleFixture("material_trend");
  initial.routine.watchState.fingerprints = {};
  await wakeFarmingControlRiskRoutine(initial.deps, initial.routine as never, initial.at);
  expect(initial.tx.run.create).not.toHaveBeenCalled();
});
it("creates a fixed weekly investigation without polling trend or trusting edited routine text", async () => {
  const f = scheduleFixture("weekly_review");
  await wakeFarmingControlRiskRoutine(f.deps, f.routine as never, f.at);
  expect(f.riskReview).not.toHaveBeenCalled();
  expect(f.tx.run.create).toHaveBeenCalledOnce();
  expect(f.tx.task.create.mock.calls[0]![0]).toMatchObject({
    data: { prompt: expect.stringContaining("Call farming_control_risk_research") },
  });
  expect(appended).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      payload: expect.objectContaining({
        farmingControlRiskTrigger: expect.objectContaining({ kind: "weekly_review" }),
      }),
    }),
  );
});
it("does not duplicate a schedule claim and durably pauses an opted-out trusted routine", async () => {
  const f = scheduleFixture("weekly_review");
  f.tx.routine.updateMany.mockResolvedValueOnce({ count: 0 });
  await wakeFarmingControlRiskRoutine(f.deps, f.routine as never, f.at);
  expect(f.tx.run.create).not.toHaveBeenCalled();
  f.deps.farmingControlRiskAutomationEnabled = false;
  await wakeFarmingControlRiskRoutine(f.deps, f.routine as never, f.at);
  expect(f.deps.prisma.routine.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: { active: false, nextRunAt: null } }),
  );
});
it("preserves trusted provenance for the existing routine retry nonce", async () => {
  const f = authFixture();
  Object.assign(f.live, {
    retryOfRunId: "failed-week",
    clientNonce: "fc-risk:v1:weekly_review:week-1:retry:failed-week",
  });
  await expect(
    authorizeFarmingControlRun(f.deps, f.run, bot, { allowRiskAutomation: true }),
  ).resolves.toMatchObject({ userId: "owner" });
  f.live.clientNonce = "fc-risk:v1:weekly_review:week-1:retry:other";
  await expect(
    authorizeFarmingControlRun(f.deps, f.run, bot, { allowRiskAutomation: true }),
  ).rejects.toThrow();
});
