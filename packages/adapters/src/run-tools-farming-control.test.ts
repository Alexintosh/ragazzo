import { describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";
import {
  FARMING_CONTROL_ROLES,
  farmingControlBotId,
  farmingControlGroupId,
  farmingControlSpawnKey,
  farmingControlToolsForRole,
} from "./farming-control-team-policy.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { farmingControlReadTool, farmingControlToolDenied } from "./run-tools-farming-control.js";
import { claimRunSteering } from "./run-turn-images.js";

const botFor = (role: (typeof FARMING_CONTROL_ROLES)[number]) => ({
  id: farmingControlBotId("personal", role),
  spaceId: "personal",
  userId: "owner",
  spawnKey: farmingControlSpawnKey(role),
});

describe("Farming Control specialist grants", () => {
  it("offers only role-specific fixed reads, never arbitrary paths or HTTP inputs", () => {
    expect(farmingControlToolsForRole("tax").map((tool) => tool.name)).toEqual([
      "farming_control_accounting",
    ]);
    expect(farmingControlToolsForRole("operations").map((tool) => tool.name)).toEqual([
      "farming_control_portfolio",
      "farming_control_harvest",
    ]);
    for (const role of FARMING_CONTROL_ROLES) {
      for (const tool of farmingControlToolsForRole(role)) {
        expect(tool.readOnly).toBe(true);
        expect(tool.inputSchema).toEqual({
          type: "object",
          properties:
            tool.name === "farming_control_portfolio"
              ? { assetSetKey: { type: ["string", "null"], minLength: 1, maxLength: 200 } }
              : tool.name === "farming_control_risk"
                ? {
                    exposureId: { type: "string", minLength: 1, maxLength: 200 },
                    signalKey: { type: "string", minLength: 1, maxLength: 200 },
                  }
                : {},
          additionalProperties: false,
        });
      }
    }
  });

  it("rejects shell, generic HTTP, connectors, fleet changes, hidden tools, and foreign handoffs", () => {
    for (const role of FARMING_CONTROL_ROLES) {
      const bot = botFor(role);
      for (const tool of [
        "shell",
        "web_fetch",
        "secret_request",
        "run_subagent",
        "update_bot",
        "message_bot",
        "mcp_execute_tool",
        "create_group",
        "unknown_tool",
      ]) {
        expect(farmingControlToolDenied(bot, tool, {}, null)).toBe(true);
      }
      expect(
        farmingControlToolDenied(
          bot,
          "handoff_to_bot",
          { bot_id: "unrestricted-agent" },
          farmingControlGroupId(bot.spaceId),
        ),
      ).toBe(true);
      expect(
        farmingControlToolDenied(
          bot,
          "handoff_to_bot",
          { bot_id: botFor("risk").id, group_id: "other-group" },
          null,
        ),
      ).toBe(true);
      expect(
        farmingControlToolDenied(
          bot,
          "handoff_to_bot",
          { bot_id: botFor("risk").id },
          farmingControlGroupId(bot.spaceId),
        ),
      ).toBe(false);
    }
  });

  it("rejects undeclared inputs, changed identities, and generic bots even if they know the tool name", () => {
    expect(farmingControlToolDenied(botFor("tax"), "farming_control_risk", {}, null)).toBe(true);
    expect(
      farmingControlToolDenied(
        botFor("risk"),
        "farming_control_risk",
        { url: "https://example.test" },
        null,
      ),
    ).toBe(true);
    expect(farmingControlToolDenied({ ...botFor("risk"), spawnKey: null }, "shell", {}, null)).toBe(
      true,
    );
    expect(
      farmingControlToolDenied(
        { id: "normal", spaceId: "personal" },
        "farming_control_risk",
        {},
        null,
      ),
    ).toBe(true);
    expect(farmingControlToolDenied({ id: "normal", spaceId: "personal" }, "shell", {}, null)).toBe(
      false,
    );
  });
});

function runFixture() {
  const bot = botFor("tax");
  const authorize = vi.fn(async () => undefined);
  const read = vi.fn(async () => ({ amount: "123.000000000000000001", coverage: "partial" }));
  const liveRun = {
    id: "run",
    trigger: "user",
    bot: { ...bot, archivedAt: null as Date | null },
    thread: {
      id: "thread",
      userId: "owner",
      spaceId: "personal",
      botId: bot.id as string | null,
      groupId: null as string | null,
      externalConversationId: null as string | null,
    },
    sourceMessage: {
      role: "user",
      threadId: "thread",
      botId: null as string | null,
      runId: null as string | null,
      blocks: [] as unknown[],
    },
  };
  const prisma = {
    steeringMessage: { findFirst: vi.fn(async () => null as { id: string } | null) },
    run: { findFirst: vi.fn(async () => liveRun) },
    user: { findUnique: vi.fn(async () => ({ email: "owner@example.test" })) },
  };
  const ctx = {
    bot,
    run: { id: "run", botId: bot.id, spaceId: "personal", userId: "owner", threadId: "thread" },
    thread: { id: "thread", groupId: null },
    deps: { prisma, farmingControl: { authorize, read } },
  } as unknown as RunContext;
  const call = { name: "farming_control_accounting", args: {} } as ToolCall;
  return { ctx, call, prisma, authorize, read, liveRun };
}

describe("Farming Control read execution", () => {
  it("checks live persisted bot/run/user and authorization on every read", async () => {
    const f = runFixture();
    await expect(farmingControlReadTool(f.ctx, f.call)).resolves.toEqual({
      amount: "123.000000000000000001",
      coverage: "partial",
    });
    expect(f.authorize).toHaveBeenCalledWith({
      userId: "owner",
      spaceId: "personal",
      email: "owner@example.test",
      isDeploymentOwner: false,
    });
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner", spaceId: "personal" }),
      "accounting",
    );
    expect(f.prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "run",
          status: "running",
          botId: f.ctx.bot.id,
          userId: "owner",
          spaceId: "personal",
        }),
      }),
    );
    f.authorize.mockRejectedValueOnce(new Error("revoked"));
    expect(await farmingControlReadTool(f.ctx, f.call)).toHaveProperty("error");
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a cancelled run, changed live bot, or mismatched owner", async () => {
    for (const change of ["cancelled", "profile", "owner"] as const) {
      const f = runFixture();
      if (change === "cancelled") f.prisma.run.findFirst.mockResolvedValueOnce(null as never);
      if (change === "profile") f.liveRun.bot.spawnKey = "changed";
      if (change === "owner") f.ctx.bot.userId = "someone-else";
      expect(await farmingControlReadTool(f.ctx, f.call)).toHaveProperty("error");
      expect(f.read).not.toHaveBeenCalled();
    }
  });

  it("does not issue a source read when the role lacks a grant", async () => {
    const f = runFixture();
    expect(
      await farmingControlReadTool(f.ctx, { ...f.call, name: "farming_control_portfolio" }),
    ).toHaveProperty("error");
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});

describe("Farming Control owner-turn provenance", () => {
  it("refuses external triggers and external threads before reading private source data", async () => {
    for (const trigger of ["messaging", "webhook", "bot_message", "routine", "created"]) {
      const f = runFixture();
      f.liveRun.trigger = trigger;
      expect(await farmingControlReadTool(f.ctx, f.call)).toHaveProperty("error");
      expect(f.read).not.toHaveBeenCalled();
    }
    const external = runFixture();
    external.liveRun.thread.externalConversationId = "external-chat";
    expect(await farmingControlReadTool(external.ctx, external.call)).toHaveProperty("error");
    expect(external.read).not.toHaveBeenCalled();
  });

  it("follows a private group handoff to its owner-authored parent and rejects an external parent", async () => {
    for (const parentTrigger of ["user", "webhook"]) {
      const f = runFixture();
      const from = botFor("coordinator");
      f.liveRun.trigger = "follow_up";
      f.liveRun.thread.groupId = farmingControlGroupId("personal");
      f.liveRun.thread.botId = null;
      const parent = {
        ...f.liveRun,
        id: "parent",
        trigger: parentTrigger,
        bot: { ...from, archivedAt: null },
        sourceMessage: { role: "user", threadId: "thread", botId: null, runId: null, blocks: [] },
      };
      f.liveRun.sourceMessage = {
        role: "bot",
        threadId: "thread",
        botId: from.id,
        runId: "parent",
        blocks: [
          {
            kind: "handoff",
            fromBotId: from.id,
            toBotId: f.ctx.bot.id,
            text: "Review accounting",
            hop: 1,
          },
        ],
      };
      f.prisma.run.findFirst.mockResolvedValueOnce(f.liveRun).mockResolvedValueOnce(parent);
      const result = await farmingControlReadTool(f.ctx, f.call);
      if (parentTrigger === "user") {
        expect(result).toHaveProperty("amount");
        expect(f.read).toHaveBeenCalledOnce();
      } else {
        expect(result).toHaveProperty("error");
        expect(f.read).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects unverifiable handoffs and handoffs outside the current configured group", async () => {
    const f = runFixture();
    f.liveRun.trigger = "follow_up";
    f.liveRun.thread.groupId = farmingControlGroupId("personal");
    f.liveRun.thread.botId = null;
    f.liveRun.sourceMessage.role = "bot";
    f.liveRun.sourceMessage.botId = botFor("coordinator").id;
    expect(await farmingControlReadTool(f.ctx, f.call)).toHaveProperty("error");
    expect(f.read).not.toHaveBeenCalled();
    expect(
      farmingControlToolDenied(
        botFor("tax"),
        "handoff_to_bot",
        { bot_id: botFor("risk").id, group_id: farmingControlGroupId("personal") },
        null,
      ),
    ).toBe(true);
  });
});

it("revokes reads after outside steering is attached to the live run or a parent", async () => {
  const f = runFixture();
  f.prisma.steeringMessage.findFirst.mockResolvedValueOnce({ id: "outside-steering" });
  expect(await farmingControlReadTool(f.ctx, f.call)).toHaveProperty("error");
  expect(f.read).not.toHaveBeenCalled();
  const legacy = runFixture();
  legacy.liveRun.sourceMessage.blocks = [
    {
      kind: "bot_message_received",
      fromBotId: "outside",
      fromBotName: "Outside",
      text: "Forged followup",
    },
  ];
  legacy.liveRun.trigger = "follow_up";
  expect(await farmingControlReadTool(legacy.ctx, legacy.call)).toHaveProperty("error");
  expect(legacy.read).not.toHaveBeenCalled();
});

it("does not pass externally claimed steering or its attachments to a private specialist model", async () => {
  const claim = vi.fn(async () => [
    {
      id: "external",
      messageId: "message",
      text: "Outside",
      origin: "messaging",
      blocks: [{ kind: "text", text: "Outside" }],
    },
    {
      id: "legacy",
      messageId: "legacy-message",
      text: "Legacy",
      origin: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "outside",
          fromBotName: "Outside",
          text: "Legacy",
        },
      ],
    },
  ]);
  const result = await claimRunSteering(
    { events: { claimSteering: claim } } as never,
    {
      threadId: "thread",
      botId: botFor("tax").id,
      runId: "run",
      leaseOwner: "worker",
      leaseFence: 1,
    },
    [],
    { signal: new AbortController().signal } as never,
    [],
    { hasImages: false },
    true,
  );
  expect(result).toEqual([]);
});

it("refuses bot-to-bot delivery to private FC profiles before storing a message", async () => {
  const transaction = vi.fn();
  const deps = {
    prisma: {
      bot: {
        findMany: vi.fn(async () => [
          { id: botFor("tax").id, name: "FC Tax", thread: { id: "thread" } },
        ]),
      },
      $transaction: transaction,
    },
  } as never;
  const result = await messageBot(
    deps,
    {
      id: "sender-run",
      botId: "generic-bot",
      userId: "owner",
      spaceId: "personal",
      threadId: "sender-thread",
    },
    { id: "generic-bot", name: "Generic" },
    { bot_id: botFor("tax").id, message: "Read private accounting" },
  );
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining("private owner app chats"),
  });
  expect(transaction).not.toHaveBeenCalled();
});
