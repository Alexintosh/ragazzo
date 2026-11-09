import type { Actor } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlSpawnKey } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { RiskInterpretationDb } from "./farming-control-risk-interpretation.js";
import { readFarmingControlRiskInterpretations } from "./farming-control-risk-interpretation.js";

const actor: Actor = {
  userId: "fixture-owner",
  spaceId: "fixture-space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const id = farmingControlBotId(actor.spaceId, "risk");
const thread = {
  id: "thread-a",
  userId: actor.userId,
  spaceId: actor.spaceId,
  botId: id,
  groupId: null,
  externalConversationId: null,
};
const bot = {
  id,
  userId: actor.userId,
  spaceId: actor.spaceId,
  spawnKey: farmingControlSpawnKey("risk"),
  archivedAt: null,
  thread,
};
const eventId = "a".repeat(64);
const trigger = {
  schemaVersion: "fc-risk-trigger.v1",
  kind: "emergency",
  eventId,
  monitorKey: "monitor-a",
  event: {
    schemaVersion: "fc-risk-event.v1",
    eventId,
    monitorKey: "monitor-a",
    subjectKey: "subject-a",
    policyKey: "policy-a",
    episodeOpenedAtMs: 1000,
    occurredAtMs: 2000,
    transition: "resolved",
    severity: "info",
    blockNumber: null,
    blockHash: null,
  },
};
function fixture(status = "completed") {
  const run = {
    id: "run-a",
    status,
    clientNonce: `fc-risk:v1:emergency:${eventId}`,
    createdAt: new Date(5000),
  };
  const db = {
    bot: { findFirst: vi.fn(async () => bot) },
    run: { findMany: vi.fn(async () => [run]) },
    event: {
      findMany: vi.fn(async () => [
        { runId: run.id, payload: { farmingControlRiskTrigger: trigger } },
      ]),
    },
  };
  return {
    db,
    read: () =>
      readFarmingControlRiskInterpretations(
        db as unknown as RiskInterpretationDb,
        actor,
        "monitor-a",
        0,
        10000,
      ),
  };
}
describe("correlated private Risk interpretation", () => {
  it("keeps completion indeterminate with no fabricated message reference", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result.runs[0]).toMatchObject({
      runId: "run-a",
      eventId,
      kind: "emergency",
      triggeredAtMs: 5000,
      occurredAtMs: 2000,
      episodeOpenedAtMs: 1000,
      analysisStatus: "indeterminate",
      messageId: null,
    });
    expect(f.db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: id,
          threadId: thread.id,
          trigger: "routine",
          bot: expect.objectContaining({ archivedAt: null }),
          thread: expect.objectContaining({ groupId: null, externalConversationId: null }),
        }),
        take: 41,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("payload");
  });
  it.each([
    ["running", "pending"],
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["future_status", "indeterminate"],
  ])("maps %s conservatively", async (status, analysisStatus) => {
    expect((await fixture(status).read()).runs[0]?.analysisStatus).toBe(analysisStatus);
  });
  it("rejects missing, mismatched nonce/event and unrelated monitor proof", async () => {
    for (const proof of [
      null,
      { ...trigger, eventId: "b".repeat(64) },
      { ...trigger, monitorKey: "other" },
    ]) {
      const f = fixture();
      f.db.event.findMany.mockResolvedValue([
        { runId: "run-a", payload: { farmingControlRiskTrigger: proof } },
      ] as never);
      expect((await f.read()).runs).toEqual([]);
    }
    const absent = fixture();
    absent.db.event.findMany.mockResolvedValue([]);
    expect((await absent.read()).runs).toEqual([]);
  });
  it("fails closed on changed private scope before reading runs", async () => {
    for (const changed of [
      { ...bot, archivedAt: new Date() },
      { ...bot, userId: "other" },
      { ...bot, thread: { ...thread, groupId: "group" } },
      { ...bot, spawnKey: "custom" },
    ]) {
      const f = fixture();
      f.db.bot.findFirst.mockResolvedValue(changed as never);
      expect((await f.read()).state).toBe("unavailable");
      expect(f.db.run.findMany).not.toHaveBeenCalled();
    }
  });
  it("keeps monitoring-wide weekly research distinct from selected episode interpretation", async () => {
    const f = fixture();
    f.db.run.findMany.mockResolvedValue([
      {
        id: "weekly",
        status: "running",
        createdAt: new Date(6000),
        clientNonce: "fc-risk:v1:weekly_review:week-a",
      },
    ]);
    f.db.event.findMany.mockResolvedValue([
      {
        runId: "weekly",
        payload: {
          farmingControlRiskTrigger: {
            schemaVersion: "fc-risk-trigger.v1",
            kind: "weekly_review",
            eventId: "week-a",
            monitorKey: null,
          },
        },
      },
    ] as never);
    expect((await f.read()).runs[0]).toMatchObject({
      kind: "weekly_review",
      scope: "monitoring_universe",
      occurredAtMs: null,
      analysisStatus: "pending",
    });
  });
});
