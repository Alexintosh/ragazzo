import type { JobPublisher } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import type {
  FarmingControlRiskEvent,
  FarmingControlRiskTrigger,
  FarmingControlService,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { mountFarmingControlRiskEvents } from "./farming-control-risk-events.js";
import { RISK_RECEIPT_MEDIA_TYPE } from "./farming-control-risk-receipt.js";

const createRun = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ id: "trusted-run" })));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  createFarmingControlRiskRun: createRun,
}));
const token = "test-only-dedicated-token-32-characters";
afterEach(() => vi.restoreAllMocks());
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
  createRun.mockReset().mockResolvedValue({ id: "trusted-run" });
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
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
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

// Frozen R1 synthetic opening/resolution. No real owner, database or provider.
const opening: FarmingControlRiskEvent = {
  schemaVersion: "fc-risk-event.v1",
  monitorKey: "monitor:synthetic-a",
  subjectKey: "subject:synthetic-a",
  policyKey: "policy:a",
  transition: "opened",
  severity: "critical",
  episodeOpenedAtMs: 1794218400000,
  occurredAtMs: 1794218400000,
  blockNumber: null,
  blockHash: null,
  eventId: "e55121fbb7a9c2704b19fb94d899e3064708948009f30f01261c85ad07cf6c31",
};
const resolution: FarmingControlRiskEvent = {
  ...opening,
  transition: "resolved",
  severity: "info",
  occurredAtMs: 1794218880000,
  eventId: "154e585d887ed516996759b619e33e59f3129aa6f544bf5cc99a3c7d7bf1b57e",
};
type StoredRun = {
  id: string;
  status: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  trigger: string;
  clientNonce: string;
};
type StoredTrigger = {
  runId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  type: string;
  payload: { farmingControlRiskTrigger: FarmingControlRiskTrigger };
};
function admissionFixture() {
  vi.spyOn(Date, "now").mockReturnValue(1794219300000);
  const runs: StoredRun[] = [];
  const triggers: StoredTrigger[] = [];
  const bot = {
    id: farmingControlBotId("personal", "risk"),
    userId: "owner",
    spaceId: "personal",
    spawnKey: farmingControlSpawnKey("risk"),
    archivedAt: null as Date | null,
    thread: {
      id: "dm",
      userId: "owner",
      spaceId: "personal",
      botId: farmingControlBotId("personal", "risk"),
      groupId: null as string | null,
      externalConversationId: null as string | null,
    },
  };
  const findNonce = vi.fn(async (query) => {
    const key = query.where.spaceId_clientNonce;
    return (
      runs.find((run) => run.spaceId === key.spaceId && run.clientNonce === key.clientNonce) ?? null
    );
  });
  const findTrigger = vi.fn(async (query) => {
    const where = query.where;
    return (
      [...triggers].reverse().find(
        (row) =>
          row.spaceId === where.spaceId &&
          row.botId === where.botId &&
          row.threadId === where.threadId &&
          row.type === where.type &&
          (!where.runId || row.runId === where.runId) &&
          (!where.payload ||
            row.payload.farmingControlRiskTrigger.eventId === where.payload.equals) &&
          (!where.AND ||
            where.AND.every((clause: { payload: { path: string[]; equals: string } }) => {
              let value: unknown = row.payload;
              for (const key of clause.payload.path)
                value = (value as Record<string, unknown>)[key];
              return value === clause.payload.equals;
            })),
      ) ?? null
    );
  });
  const claim = vi.fn(async () => ({ count: bot.archivedAt ? 0 : 1 }));
  const tx = {
    run: { findUnique: findNonce },
    event: { findFirst: findTrigger },
    bot: { updateMany: claim },
  };
  let tail = Promise.resolve();
  const prisma = {
    bot: { findFirst: vi.fn(async () => (bot.archivedAt || bot.userId !== "owner" ? null : bot)) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
    run: {
      findFirst: vi.fn(async (query) => {
        const where = query.where;
        return (
          runs.find(
            (run) =>
              ["spaceId", "userId", "botId", "threadId", "trigger", "clientNonce"].every(
                (key) => run[key as keyof StoredRun] === where[key],
              ) &&
              bot.archivedAt === null &&
              bot.spawnKey === where.bot.spawnKey &&
              bot.thread.userId === where.thread.userId &&
              bot.thread.spaceId === where.thread.spaceId &&
              bot.thread.botId === where.thread.botId &&
              bot.thread.groupId === null &&
              bot.thread.externalConversationId === null,
          ) ?? null
        );
      }),
    },
    event: { findFirst: findTrigger },
    // Unit model of the existing bot-local DB claim. This does not exercise PostgreSQL locks.
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => {
      const result = tail.then(() => callback(tx));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  };
  createRun.mockReset().mockImplementation(async (_tx, actorValue, botValue, triggerValue) => {
    const actor = actorValue as Actor;
    const target = botValue as { id: string; threadId: string };
    const trigger = triggerValue as FarmingControlRiskTrigger;
    const run: StoredRun = {
      id: `synthetic-risk-run-${runs.length + 1}`,
      status: "queued",
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: target.id,
      threadId: target.threadId,
      trigger: "routine",
      clientNonce: `fc-risk:v1:emergency:${trigger.eventId}`,
    };
    runs.push(run);
    triggers.push({
      runId: run.id,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      type: "routine.fired",
      payload: { farmingControlRiskTrigger: trigger },
    });
    return { id: run.id };
  });
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
  const deliver = (body: unknown = opening, accept: string | null = RISK_RECEIPT_MEDIA_TYPE) =>
    app.request("/api/v1/farming-control/risk-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(accept ? { accept } : {}),
      },
      body: JSON.stringify(body),
    });
  const status = (eventId = opening.eventId, bearer = token) =>
    app.request(`/api/v1/farming-control/risk-events/${eventId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
  return { app, deliver, status, runs, triggers, prisma, tx, jobs, authorize, bot };
}

it("negotiates additive v2 and keeps exact v1 wire responses for old clients", async () => {
  const f = admissionFixture();
  const created = await f.deliver();
  expect(created.status).toBe(202);
  expect(await created.json()).toEqual({
    accepted: true,
    runId: "synthetic-risk-run-1",
    receipt: {
      schemaVersion: "fc-risk-receipt.v2",
      eventId: opening.eventId,
      reception: "created",
      run: { id: "synthetic-risk-run-1", status: "queued", wake: "requested" },
      analysis: { status: "pending", messageId: null },
    },
  });
  for (const accept of [null, "application/json", "*/*", `${RISK_RECEIPT_MEDIA_TYPE};q=0`]) {
    const response = await f.deliver(opening, accept);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"accepted":true,"runId":"synthetic-risk-run-1"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Accept");
  }
  expect(createRun).toHaveBeenCalledOnce();
});

it("serializes concurrent duplicates and keeps the original run after newer admissions", async () => {
  const f = admissionFixture();
  const responses = await Promise.all([f.deliver(), f.deliver()]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  expect(bodies.map((body) => body.receipt.reception).sort()).toEqual(["created", "replayed"]);
  expect(new Set(bodies.map((body) => body.runId)).size).toBe(1);
  expect(f.runs).toHaveLength(1);
  expect(createRun).toHaveBeenCalledOnce();
  expect((await f.deliver(resolution)).status).toBe(202);
  f.runs[0]!.status = "completed";
  const replay = await (await f.deliver()).json();
  expect(replay.runId).toBe("synthetic-risk-run-1");
  expect(replay.receipt.reception).toBe("replayed");
  expect(replay.receipt.analysis).toEqual({ status: "indeterminate", messageId: null });
  expect(f.runs).toHaveLength(2);
});

it("distinguishes stale openings and superseded resolution without creating or waking work", async () => {
  const f = admissionFixture();
  await f.deliver();
  f.jobs.enqueue.mockClear();
  const older = {
    ...opening,
    eventId: "b".repeat(64),
    episodeOpenedAtMs: opening.episodeOpenedAtMs - 3600000,
  };
  const stale = await (await f.deliver(older)).json();
  expect(stale.runId).toBeNull();
  expect(stale.receipt.reception).toBe("ignored_stale");
  expect(stale.receipt.run).toEqual({ id: null, status: null, wake: "not_applicable" });
  expect(stale.receipt.analysis).toEqual({ status: "not_requested", messageId: null });
  const unmatched = {
    ...resolution,
    eventId: "c".repeat(64),
    episodeOpenedAtMs: older.episodeOpenedAtMs,
  };
  expect((await (await f.deliver(unmatched)).json()).receipt.reception).toBe(
    "ignored_unmatched_resolution",
  );
  expect(await (await f.deliver(unmatched, null)).text()).toBe('{"accepted":true,"runId":null}');
  expect((await f.status(older.eventId)).status).toBe(404);
  expect(f.runs).toHaveLength(1);
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
});

it("orders two same-block policies separately and admits same-block downgrades", async () => {
  const f = admissionFixture();
  const anchored = { ...opening, blockNumber: "4242", blockHash: `0x${"1".repeat(64)}` };
  await f.deliver(anchored);
  await f.deliver({ ...anchored, policyKey: "policy:b", eventId: "b".repeat(64) });
  await f.deliver({
    ...anchored,
    transition: "updated",
    severity: "warning",
    eventId: "c".repeat(64),
  });
  expect(f.runs).toHaveLength(3);
  expect(createRun).toHaveBeenCalledTimes(3);
});

it("preserves v1 orphan-resolution admission and refuses newest-first historical replay", async () => {
  const f = admissionFixture();
  expect(await (await f.deliver(resolution, null)).json()).toEqual({
    accepted: true,
    runId: "synthetic-risk-run-1",
  });
  expect((await (await f.deliver()).json()).receipt.reception).toBe("ignored_stale");
  expect(f.runs).toHaveLength(1);
});

it("keeps a committed run coherent after wake failure and lets retry use the existing run", async () => {
  const f = admissionFixture();
  f.jobs.enqueue.mockRejectedValueOnce(new Error("synthetic unavailable publisher"));
  const response = await f.deliver();
  expect(response.status).toBe(202);
  const first = await response.json();
  expect(first.receipt.run.wake).toBe("recovery_required");
  expect(f.runs[0]!.status).toBe("queued");
  expect((await (await f.status()).json()).run.id).toBe(first.runId);
  const retried = await (await f.deliver()).json();
  expect(retried.runId).toBe(first.runId);
  expect(retried.receipt.reception).toBe("replayed");
  expect(retried.receipt.run.wake).toBe("requested");
  f.jobs.enqueue.mockRejectedValueOnce(new Error("synthetic wake failure for legacy sender"));
  expect(await (await f.deliver(opening, null)).text()).toBe(
    '{"accepted":true,"runId":"synthetic-risk-run-1"}',
  );
  expect(f.runs).toHaveLength(1);
});

it("reconciles a discarded response by GET without writes or wake, then exact POST retry", async () => {
  const f = admissionFixture();
  // The response is intentionally discarded after the route commits.
  await f.deliver(opening, null);
  f.prisma.$transaction.mockClear();
  f.jobs.enqueue.mockClear();
  const status = await f.status();
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.json()).toEqual({
    schemaVersion: "fc-risk-status.v2",
    eventId: opening.eventId,
    asOfMs: expect.any(Number),
    run: { id: "synthetic-risk-run-1", status: "queued" },
    analysis: { status: "pending", messageId: null },
  });
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
  expect((await (await f.deliver()).json()).receipt.reception).toBe("replayed");
  expect(f.runs).toHaveLength(1);
});

it("projects failed/cancelled runs separately and never infers final analysis from completion", async () => {
  const f = admissionFixture();
  await f.deliver();
  for (const status of ["failed", "cancelled", "completed", "unrecognized"]) {
    f.runs[0]!.status = status;
    const expected = ["failed", "cancelled"].includes(status) ? "failed" : "indeterminate";
    const receipt = await (await f.deliver()).json();
    const read = await (await f.status()).json();
    expect(receipt.receipt.analysis).toEqual({ status: expected, messageId: null });
    expect(read.analysis).toEqual(receipt.receipt.analysis);
    expect(read.run.status).toBe(status === "unrecognized" ? null : status);
  }
  expect(f.runs).toHaveLength(1);
});

it("denies sender metadata to wrong bearer, archived bot, revoked access and changed private scope", async () => {
  const f = admissionFixture();
  await f.deliver();
  f.prisma.run.findFirst.mockClear();
  expect((await f.status(opening.eventId, "other-account-token")).status).toBe(401);
  expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
  f.authorize.mockRejectedValueOnce(new Error("revoked personal membership"));
  expect((await f.status()).status).toBe(401);
  expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
  f.bot.archivedAt = new Date(0);
  expect((await f.status()).status).toBe(503);
  expect((await f.deliver()).status).toBe(503);
  f.bot.archivedAt = null;
  f.bot.thread.userId = "other-owner";
  expect((await f.status()).status).toBe(503);
  f.bot.thread.userId = "owner";
  f.bot.thread.externalConversationId = "external";
  expect((await f.status()).status).toBe(503);
  f.bot.thread.externalConversationId = null;
  f.bot.spawnKey = "edited-profile";
  expect((await f.status()).status).toBe(503);
  expect(f.runs).toHaveLength(1);
});

it("requires scoped run and matching retained trigger, with no arbitrary run or content lookup", async () => {
  const f = admissionFixture();
  expect((await f.status()).status).toBe(404);
  expect((await f.status("invalid-event-id")).status).toBe(404);
  await f.deliver();
  f.runs[0]!.userId = "other-owner";
  expect((await f.status()).status).toBe(404);
  f.runs[0]!.userId = "owner";
  f.runs[0]!.spaceId = "other-space";
  expect((await f.status()).status).toBe(404);
  f.runs[0]!.spaceId = "personal";
  f.runs[0]!.botId = "other-bot";
  expect((await f.status()).status).toBe(404);
  f.runs[0]!.botId = f.bot.id;
  f.runs[0]!.threadId = "other-thread";
  expect((await f.status()).status).toBe(404);
  f.runs[0]!.threadId = "dm";
  f.triggers[0]!.payload.farmingControlRiskTrigger.eventId = "b".repeat(64);
  expect((await f.status()).status).toBe(404);
  f.triggers[0]!.payload.farmingControlRiskTrigger.eventId = opening.eventId;
  f.triggers[0]!.payload.farmingControlRiskTrigger.kind = "weekly_review";
  expect((await f.status()).status).toBe(404);
  f.triggers.length = 0;
  expect((await f.status()).status).toBe(404);
  const retry = await f.deliver();
  expect(retry.status).toBe(503);
  expect(await retry.json()).toEqual({ error: "Risk specialist unavailable" });
  expect(f.runs).toHaveLength(1);
});

it("does not mislabel failed claims as stale, preserving legacy null without negotiated proof", async () => {
  const f = admissionFixture();
  f.tx.bot.updateMany.mockResolvedValue({ count: 0 });
  expect((await f.deliver()).status).toBe(503);
  expect(await (await f.deliver(opening, null)).text()).toBe('{"accepted":true,"runId":null}');
  expect(f.tx.run.findUnique).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
});

it("keeps strict payload controls for negotiated clients and never returns prompts, errors or text", async () => {
  const f = admissionFixture();
  expect(
    (await f.deliver({ ...opening, prompt: "caller prompt", botId: "caller-target" })).status,
  ).toBe(400);
  expect((await f.deliver({ ...opening, occurredAtMs: Date.now() + 120000 })).status).toBe(400);
  expect((await f.deliver({ ...opening, policyKey: "x".repeat(9000) })).status).toBe(413);
  const response = await (await f.deliver()).json();
  expect(Object.keys(response.receipt).sort()).toEqual([
    "analysis",
    "eventId",
    "reception",
    "run",
    "schemaVersion",
  ]);
  expect(Object.keys(response.receipt.analysis).sort()).toEqual(["messageId", "status"]);
  expect(response.receipt.analysis.messageId).toBeNull();
});
