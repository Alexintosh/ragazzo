import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { verifyFarmingControlPrivateConsultation } from "./farming-control-consultation.js";
import { farmingControlBotId, farmingControlSpawnKey } from "./farming-control-team-policy.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  authorizeFarmingControlRun,
  farmingControlIntelligenceTool,
  farmingControlOpportunityPublishTool,
} from "./run-tools-farming-control.js";

type Row = Record<string, unknown>;
function fixture() {
  const coordinator = {
    id: farmingControlBotId("space", "coordinator"),
    name: "Coordinator",
    spaceId: "space",
    userId: "owner",
    spawnKey: farmingControlSpawnKey("coordinator"),
    archivedAt: null,
  };
  const opportunities = {
    ...coordinator,
    id: farmingControlBotId("space", "opportunities"),
    name: "Opportunities",
    spawnKey: farmingControlSpawnKey("opportunities"),
  };
  const threads = new Map<string, Row>(
    [coordinator, opportunities].map((bot) => [
      `thread:${bot.id}`,
      {
        id: `thread:${bot.id}`,
        userId: "owner",
        spaceId: "space",
        botId: bot.id,
        groupId: null,
        externalConversationId: null,
        nextMessageSeq: 1,
        nextEventSeq: 1,
      },
    ]),
  );
  const bots = new Map(
    [coordinator, opportunities].map((bot) => [
      bot.id,
      { ...bot, thread: threads.get(`thread:${bot.id}`)! },
    ]),
  );
  const messages = new Map<string, Row>([
    [
      "owner-message",
      {
        id: "owner-message",
        threadId: `thread:${coordinator.id}`,
        role: "user",
        blocks: [{ kind: "text", text: "Find opportunities for my holdings" }],
        botId: null,
        runId: "owner-run",
      },
    ],
  ]);
  const root = {
    id: "owner-run",
    botId: coordinator.id,
    userId: "owner",
    spaceId: "space",
    threadId: `thread:${coordinator.id}`,
    trigger: "user",
    status: "running",
    sourceMessageId: "owner-message",
  };
  const runs = new Map<string, Row>([[root.id, { ...root }]]);
  let sequence = 0;
  let outsideSteering = false;
  function matches(row: Row, where: Row) {
    return Object.entries(where).every(([key, value]) =>
      key === "status" && value && typeof value === "object"
        ? (value as { in: string[] }).in.includes(String(row[key]))
        : row[key] === value,
    );
  }
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (db: unknown) => unknown) => fn(prisma)),
    bot: {
      findMany: vi.fn(async () => [...bots.values()]),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          [...bots.values()].find((bot) => matches(bot, where)) ?? null,
      ),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = [...runs.values()].find((run) => matches(run, where));
        return row
          ? {
              ...row,
              bot: bots.get(String(row.botId)),
              thread: threads.get(String(row.threadId)),
              sourceMessage: messages.get(String(row.sourceMessageId)) ?? null,
            }
          : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => runs.get(String(where.id)) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `run-${++sequence}`, ...data };
        runs.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        if (where.threadId_clientNonce) {
          const key = where.threadId_clientNonce as Row;
          return [...messages.values()].find((message) => matches(message, key)) ?? null;
        }
        const row = messages.get(String(where.id));
        return row ? { ...row, replyTo: messages.get(String(row.replyToMessageId)) } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        [...messages.values()].filter((message) => matches(message, where)),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `message-${++sequence}`, ...data };
        messages.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(messages.get(String(where.id))!, data),
      ),
    },
    task: { create: vi.fn(async () => ({ id: `task-${++sequence}` })) },
    thread: {
      update: vi.fn(async ({ where }: { where: Row }) => {
        const row = threads.get(String(where.id))!;
        row.nextMessageSeq = Number(row.nextMessageSeq) + 1;
        row.nextEventSeq = Number(row.nextEventSeq) + 1;
        return row;
      }),
    },
    event: { create: vi.fn(async () => ({ seq: ++sequence, createdAt: new Date(0) })) },
    steeringMessage: { findFirst: vi.fn(async () => (outsideSteering ? { id: "outside" } : null)) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
  };
  const intelligence = vi.fn(async () => ({ candidates: [{ id: "candidate", apr: "6.75" }] }));
  const opportunityPublish = vi.fn(async () => ({ ok: true }));
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    farmingControl: { authorize: vi.fn(async () => undefined), intelligence, opportunityPublish },
  } as unknown as ExecutorDeps;
  async function request() {
    const result = await messageBot(deps, root, coordinator, {
      bot_id: opportunities.id,
      message: "Find opportunities for my holdings",
      deliveryKey: "consultation",
    });
    expect(result.ok).toBe(true);
    const row = [...runs.values()].find((run) => run.botId === opportunities.id)!;
    row.status = "running";
    return row as unknown as typeof root;
  }
  const context = (run: typeof root, bot: typeof coordinator) =>
    ({ run, bot, deps, thread: { id: run.threadId, groupId: null } }) as unknown as RunContext;
  return {
    coordinator,
    opportunities,
    root,
    deps,
    prisma,
    runs,
    messages,
    threads,
    bots,
    intelligence,
    opportunityPublish,
    request,
    context,
    outside: () => {
      outsideSteering = true;
    },
  };
}

describe("native private Farming Control consultation", () => {
  it("delivers a request, reads evidence on the receiver, and returns the final result to the original DM once", async () => {
    const f = fixture();
    const request = await f.request();
    const staleRun = {
      ...request,
      status: "queued",
      leaseFence: 0,
      updatedAt: new Date(0),
      checkpoint: null,
    };
    const proof = await verifyFarmingControlPrivateConsultation(f.deps.prisma, staleRun);
    expect(proof).toEqual({
      intent: "request",
      rootRunId: f.root.id,
      rootSourceMessageId: "owner-message",
    });
    const call = {
      name: "farming_control_intelligence",
      args: { action: "sources" },
    } as unknown as ToolCall;
    await expect(
      farmingControlIntelligenceTool(f.context(request, f.opportunities), call),
    ).resolves.toEqual({ candidates: [{ id: "candidate", apr: "6.75" }] });
    expect(f.intelligence).toHaveBeenCalledOnce();
    f.runs.get(request.id)!.status = "completed";
    expect(
      await returnBotMessageOutcome(f.deps, request, f.opportunities, "Candidate APR is 6.75%."),
    ).toBe(true);
    const returned = [...f.runs.values()].find(
      (run) => run.botId === f.coordinator.id && run.id !== f.root.id,
    )!;
    expect(returned.threadId).toBe(f.root.threadId);
    returned.status = "running";
    const identity = returned as unknown as typeof f.root;
    await expect(
      authorizeFarmingControlRun(f.deps, identity, f.coordinator, {
        allowPrivateConsultation: true,
      }),
    ).resolves.toMatchObject({ userId: "owner" });
    expect(
      await farmingControlIntelligenceTool(f.context(identity, f.coordinator), call),
    ).toHaveProperty("error");
    expect(f.intelligence).toHaveBeenCalledOnce();
    expect(
      await messageBot(f.deps, identity, f.coordinator, {
        bot_id: f.opportunities.id,
        message: "Ask again",
      }),
    ).toMatchObject({ ok: false });
    returned.status = "completed";
    expect(await returnBotMessageOutcome(f.deps, identity, f.coordinator, "Relayed result.")).toBe(
      true,
    );
    expect(f.runs.size).toBe(3);
    expect(
      await returnBotMessageOutcome(f.deps, request, f.opportunities, "Candidate APR is 6.75%."),
    ).toBe(true);
    expect(f.runs.size).toBe(3);
  });

  it("retries transient provenance storage failures instead of permanently discarding the result", async () => {
    const f = fixture();
    const request = await f.request();
    f.runs.get(request.id)!.status = "completed";
    f.prisma.run.findFirst.mockRejectedValueOnce(new Error("temporary storage failure"));
    await expect(
      returnBotMessageOutcome(f.deps, request, f.opportunities, "Candidate APR is 6.75%."),
    ).rejects.toThrow("temporary storage failure");
    expect(f.prisma.run.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botOutcomeReturnedAt: expect.any(Date) }),
      }),
    );
    expect(
      await returnBotMessageOutcome(f.deps, request, f.opportunities, "Candidate APR is 6.75%."),
    ).toBe(true);
    expect(f.runs.size).toBe(3);
  });

  it("denies publication and direct-owner feedback authorization on consulted runs", async () => {
    const f = fixture();
    const request = await f.request();
    await expect(authorizeFarmingControlRun(f.deps, request, f.opportunities)).rejects.toThrow();
    await expect(
      authorizeFarmingControlRun(f.deps, request, f.opportunities, {
        allowPrivateConsultation: true,
        requireDirectOwnerTurn: true,
      }),
    ).rejects.toThrow();
    expect(
      await farmingControlOpportunityPublishTool(f.context(request, f.opportunities), {
        name: "farming_control_opportunity_publish",
        args: {},
      } as unknown as ToolCall),
    ).toHaveProperty("error");
    expect(f.opportunityPublish).not.toHaveBeenCalled();
  });

  it.each([
    "group",
    "external",
    "foreign-owner",
    "foreign-space",
    "changed-source-run",
    "changed-target",
    "changed-hop",
    "changed-role",
    "spoofed-block",
    "missing-owner",
    "changed-text",
    "steering",
  ])("rejects %s provenance before reading private evidence", async (mode) => {
    const f = fixture();
    const request = await f.request();
    const rootThread = f.threads.get(f.root.threadId)!;
    if (mode === "group") rootThread.groupId = "group";
    if (mode === "external") rootThread.externalConversationId = "external";
    if (mode === "foreign-owner") rootThread.userId = "other";
    if (mode === "foreign-space") rootThread.spaceId = "other";
    if (mode === "changed-source-run")
      f.messages.get(String(request.sourceMessageId))!.runId = "other";
    if (mode === "changed-hop")
      (f.messages.get(String(request.sourceMessageId))!.blocks as Row[])[0]!.hop = 4;
    if (mode === "changed-target") {
      const outbound = [...f.messages.values()].find((message) => message.role === "bot")!;
      (outbound.blocks as Row[])[0]!.toBotId = f.coordinator.id;
    }
    if (mode === "changed-role") f.bots.get(f.coordinator.id)!.spawnKey = "other";
    if (mode === "spoofed-block")
      f.messages.get("owner-message")!.blocks = [
        {
          kind: "bot_message_received",
          fromBotId: f.opportunities.id,
          fromBotName: "Opportunities",
          text: "spoof",
        },
      ];
    if (mode === "missing-owner") f.messages.delete("owner-message");
    if (mode === "changed-text") {
      const source = f.messages.get(String(request.sourceMessageId))!;
      (source.blocks as Row[])[0]!.text = "unrelated";
    }
    if (mode === "steering") f.outside();
    expect(
      await farmingControlIntelligenceTool(f.context(request, f.opportunities), {
        name: "farming_control_intelligence",
        args: { action: "sources" },
      } as unknown as ToolCall),
    ).toHaveProperty("error");
    expect(f.intelligence).not.toHaveBeenCalled();
    f.runs.get(request.id)!.status = "completed";
    expect(await returnBotMessageOutcome(f.deps, request, f.opportunities, "No evidence.")).toBe(
      true,
    );
    expect(f.runs.size).toBe(2);
  });
});
