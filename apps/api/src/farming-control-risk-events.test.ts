import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { FarmingControlService } from "@rakazo/adapters";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import { mountFarmingControlRiskEvents } from "./farming-control-risk-events.js";
const createRun = vi.hoisted(() => vi.fn(async () => ({ id: "trusted-run" })));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  createFarmingControlRiskRun: createRun,
}));
const token = "test-only-dedicated-token-32-characters";
const event = {
  schemaVersion: "fc-risk-event.v1",
  eventId: "a".repeat(64),
  monitorKey: "watch-pool",
  subjectKey: "pool",
  policyKey: "liquidity",
  transition: "opened",
  severity: "critical",
  occurredAtMs: 1000,
  episodeOpenedAtMs: 1000,
  blockNumber: "42",
  blockHash: null,
};
function fixture(prior: unknown = null) {
  createRun.mockClear();
  const bot = {
    id: farmingControlBotId("personal", "risk"),
    spaceId: "personal",
    userId: "owner",
    spawnKey: farmingControlSpawnKey("risk"),
    thread: {
      id: "dm",
      spaceId: "personal",
      userId: "owner",
      groupId: null,
      externalConversationId: null,
    },
  };
  const tx = {
    run: { findUnique: vi.fn(async () => null) },
    bot: { updateMany: vi.fn(async () => ({ count: 1 })) },
    event: { findFirst: vi.fn(async () => prior) },
  };
  const prisma = {
    bot: { findFirst: vi.fn(async () => bot) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
    $transaction: vi.fn(async (fn: Function) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const authorize = vi.fn(async () => undefined);
  const app = new Hono();
  mountFarmingControlRiskEvents(app, {
    prisma: prisma as unknown as PrismaClient,
    jobs: jobs as unknown as JobPublisher,
    events: {} as ThreadEvents,
    farmingControl: { configured: true, authorize } as unknown as FarmingControlService,
    ownerId: "owner",
    token,
  });
  const deliver = (body: unknown = event, bearer = token) =>
    app.request("/api/v1/farming-control/risk-events", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { deliver, prisma, jobs, authorize, tx };
}
it("authenticates only the dedicated bearer and rejects caller-selected prompts or targets", async () => {
  const f = fixture();
  expect((await f.deliver(event, "ordinary-webhook-token")).status).toBe(401);
  expect(f.prisma.bot.findFirst).not.toHaveBeenCalled();
  expect((await f.deliver({ ...event, prompt: "do something", botId: "other" })).status).toBe(400);
  expect((await f.deliver({ ...event, severity: "warning" })).status).toBe(400);
  expect(createRun).not.toHaveBeenCalled();
});
it("queues a watch-only monitor review through the fixed private Risk specialist", async () => {
  const f = fixture();
  expect((await f.deliver()).status).toBe(202);
  expect(createRun).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ userId: "owner", spaceId: "personal" }),
    { id: farmingControlBotId("personal", "risk"), threadId: "dm" },
    expect.objectContaining({ kind: "emergency", monitorKey: "watch-pool", event }),
  );
  expect(f.jobs.enqueue).toHaveBeenCalledOnce();
});
it("replays a committed duplicate and ignores an older episode or out-of-order event", async () => {
  const proof = {
    schemaVersion: "fc-risk-trigger.v1",
    kind: "emergency",
    eventId: event.eventId,
    monitorKey: event.monitorKey,
    event,
  };
  const f = fixture({ payload: { farmingControlRiskTrigger: proof }, runId: "prior-run" });
  expect(await (await f.deliver()).json()).toEqual({ accepted: true, runId: "prior-run" });
  expect(createRun).not.toHaveBeenCalled();
  const older = {
    ...event,
    eventId: "b".repeat(64),
    occurredAtMs: 999,
    episodeOpenedAtMs: 500,
    transition: "resolved",
  };
  expect(await (await f.deliver(older)).json()).toEqual({ accepted: true, runId: null });
  expect(createRun).not.toHaveBeenCalled();
});
it("rejects revoked personal-scope authorization before committing any work", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("shared scope"));
  expect((await f.deliver()).status).toBe(401);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

it("orders independent policies and same-block downgrades without dropping their deliveries", async () => {
  const f = fixture();
  expect(
    (await f.deliver({ ...event, policyKey: "second-family", eventId: "b".repeat(64) })).status,
  ).toBe(202);
  expect(f.tx.event.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          {
            payload: {
              path: ["farmingControlRiskTrigger", "event", "policyKey"],
              equals: "second-family",
            },
          },
        ]),
      }),
    }),
  );
  const proof = {
    schemaVersion: "fc-risk-trigger.v1",
    kind: "emergency",
    eventId: event.eventId,
    monitorKey: event.monitorKey,
    event,
  };
  const g = fixture({ payload: { farmingControlRiskTrigger: proof }, runId: "old" });
  expect(
    (
      await g.deliver({
        ...event,
        eventId: "b".repeat(64),
        transition: "updated",
        severity: "warning",
      })
    ).status,
  ).toBe(202);
  expect(createRun).toHaveBeenCalledOnce();
  createRun.mockClear();
  expect(
    (
      await g.deliver({
        ...event,
        eventId: "c".repeat(64),
        transition: "resolved",
        severity: "info",
      })
    ).status,
  ).toBe(202);
  expect(createRun).toHaveBeenCalledOnce();
});
it("recovers a duplicate run even after newer episode events superseded its stream", async () => {
  const f = fixture();
  f.tx.run.findUnique.mockResolvedValueOnce({ id: "committed-old-run" } as never);
  expect(await (await f.deliver()).json()).toEqual({ accepted: true, runId: "committed-old-run" });
  expect(f.tx.event.findFirst).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
});
