import { createRouterClient } from "@orpc/server";
import { RoleplayContinuitySchema } from "@rakazo/contracts";
import { roleplayStoryState } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "private",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const state = roleplayStoryState(null, { threadId: "story", botId: "rp", historyGeneration: 2 });
  state.summary = "An existing story summary.";
  state.continuity = {
    scene: "A cafe",
    relationship: "Recently met",
    sharedDetails: ["A shared interest"],
    openThreads: [],
    callbacks: [],
  };
  const thread = {
    id: "story",
    botId: "rp",
    spaceId: actor.spaceId,
    userId: actor.userId,
    groupId: null,
    externalConversationId: null,
    roleplayState: state as unknown,
    historyCompactionGeneration: 2,
    nextMessageSeq: 9,
  };
  const bot = { id: "rp", botKind: "roleplay", thread };
  const queryRaw = vi.fn(async () => []);
  const findFirst = vi.fn(async () => bot);
  const active = vi.fn(async (): Promise<{ id: string } | null> => null);
  const update = vi.fn(async ({ data }: { data: { roleplayState: unknown } }) => {
    thread.roleplayState = data.roleplayState;
    return thread;
  });
  const tx = {
    user: { findUnique: vi.fn(async () => ({ roleplayEnabled: true })) },
    bot: { findFirst },
    thread: { update },
    run: { findFirst: active },
    $queryRaw: queryRaw,
  };
  const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
  const client = createRouterClient(
    createRouter({
      prisma: { ...tx, $transaction: transaction },
      env: {},
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  return { client, thread, bot, findFirst, active, update, queryRaw, transaction };
}

describe("roleplay relationship debug", () => {
  it("reads legacy defaults only for the actor's bot and saves scores without changing story memory", async () => {
    const f = fixture();
    const original = structuredClone(f.thread.roleplayState);
    const before = await f.client.bots.roleplayRelationship({ botId: "rp" });
    expect(before.relationship).toEqual({ warmth: 10, intimacy: 0, love: 0 });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rp", spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      }),
    );
    const after = await f.client.bots.updateRoleplayRelationship({
      botId: "rp",
      relationship: { warmth: 80, intimacy: 40, love: 25 },
      historyGeneration: before.historyGeneration,
      expectedRevision: before.revision,
    });
    expect(after.relationship).toEqual({ warmth: 80, intimacy: 40, love: 25 });
    expect(after.revision).not.toBe(before.revision);
    expect(f.thread.roleplayState).toMatchObject(original as object);
    expect(f.queryRaw).toHaveBeenCalledTimes(2);
    await expect(
      f.client.bots.updateRoleplayRelationship({
        botId: "rp",
        relationship: { warmth: 20, intimacy: 0, love: 0 },
        historyGeneration: before.historyGeneration,
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow("conversation changed");
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it.each(["generation", "new-message", "continuity"])(
    "rejects a stale %s snapshot without overwriting state",
    async (change) => {
      const f = fixture();
      const before = await f.client.bots.roleplayRelationship({ botId: "rp" });
      if (change === "generation") f.thread.historyCompactionGeneration++;
      if (change === "new-message") f.thread.nextMessageSeq++;
      if (change === "continuity")
        f.thread.roleplayState = { ...(f.thread.roleplayState as object), summary: "New summary" };
      await expect(
        f.client.bots.updateRoleplayRelationship({
          botId: "rp",
          relationship: before.relationship,
          historyGeneration: before.historyGeneration,
          expectedRevision: before.revision,
        }),
      ).rejects.toThrow("conversation changed");
      expect(f.update).not.toHaveBeenCalled();
    },
  );

  it("rejects relationship edits that would make saved continuity unreadable", async () => {
    const f = fixture();
    const continuity = {
      scene: "x".repeat(800),
      relationship: "x".repeat(800),
      sharedDetails: Array<string>(12).fill("x".repeat(400)),
      openThreads: Array<string>(8).fill("x".repeat(400)),
      callbacks: Array<string>(8).fill("x".repeat(400)),
    };
    // Each replacement adds one UTF-8 byte without exceeding field character limits.
    let extraBytes = 16_360 - new TextEncoder().encode(JSON.stringify(continuity)).length;
    for (let i = 0; extraBytes > 0 && i < continuity.sharedDetails.length; i++) {
      const count = Math.min(extraBytes, 400);
      continuity.sharedDetails[i] = "é".repeat(count) + "x".repeat(400 - count);
      extraBytes -= count;
    }
    expect(RoleplayContinuitySchema.safeParse(continuity).success).toBe(true);
    const relationship = { warmth: 100, intimacy: 100, love: 100 };
    expect(
      RoleplayContinuitySchema.safeParse({ ...continuity, relationshipState: relationship })
        .success,
    ).toBe(false);
    f.thread.roleplayState = { ...(f.thread.roleplayState as object), continuity };
    const original = structuredClone(f.thread.roleplayState);
    const before = await f.client.bots.roleplayRelationship({ botId: "rp" });
    await expect(
      f.client.bots.updateRoleplayRelationship({
        botId: "rp",
        relationship,
        historyGeneration: before.historyGeneration,
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow("Story memory exceeds the memory limit");
    expect(f.update).not.toHaveBeenCalled();
    expect(f.thread.roleplayState).toEqual(original);
    expect(await f.client.bots.roleplayRelationship({ botId: "rp" })).toEqual(before);
  });

  it("refuses an active reply and out-of-range scores", async () => {
    const f = fixture();
    const before = await f.client.bots.roleplayRelationship({ botId: "rp" });
    f.active.mockResolvedValue({ id: "running" });
    const input = {
      botId: "rp",
      relationship: before.relationship,
      historyGeneration: before.historyGeneration,
      expectedRevision: before.revision,
    };
    await expect(f.client.bots.updateRoleplayRelationship(input)).rejects.toThrow("current reply");
    await expect(
      f.client.bots.updateRoleplayRelationship({
        ...input,
        relationship: { warmth: 101, intimacy: -1, love: 2.5 },
      }),
    ).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("rejects operational bots and a thread belonging to someone else", async () => {
    const f = fixture();
    f.bot.botKind = "agent";
    await expect(f.client.bots.roleplayRelationship({ botId: "rp" })).rejects.toThrow(
      "direct roleplay",
    );
    f.bot.botKind = "roleplay";
    f.thread.userId = "another-owner";
    await expect(f.client.bots.roleplayRelationship({ botId: "rp" })).rejects.toThrow(
      "direct roleplay",
    );
    expect(f.update).not.toHaveBeenCalled();
  });
});
