import { createRouterClient } from "@orpc/server";
import type { ConversationEngine } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const characterId = "00000000-0000-4000-8000-000000000001";
function fixture(enabled = true) {
  const transaction = vi.fn();
  const engine = {
    id: "eros",
    name: "Eros",
    characters: [{ id: characterId, name: "Aster" }],
    capabilities: { streaming: true, tools: false, cancel: false },
    jwtSecret: "must-never-appear-in-descriptor",
    baseUrl: "http://engine.internal",
    provision: vi.fn(),
    stream: vi.fn(),
  } satisfies ConversationEngine & { jwtSecret: string; baseUrl: string };
  const bot = {
    id: "rp",
    botKind: "roleplay",
    conversationEngine: "eros",
    thread: { id: "story" },
  };
  const client = createRouterClient(
    createRouter({
      prisma: { bot: { findFirst: vi.fn().mockResolvedValue(bot) }, $transaction: transaction },
      conversationEngines: new Map([["eros", engine]]),
      env: { roleplayEnabled: enabled, sandboxProvider: "desktop" },
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  return { client, transaction, engine };
}

describe("external conversation engine admission", () => {
  it("only exposes safe catalog fields to an authenticated member", async () => {
    const f = fixture();
    expect(await f.client.bots.conversationEngines({})).toEqual([
      {
        id: "eros",
        name: "Eros",
        characters: [{ id: characterId, name: "Aster" }],
        capabilities: { streaming: true, tools: false, cancel: false },
      },
    ]);
    expect(await fixture(false).client.bots.conversationEngines({})).toEqual([]);
  });

  it("rejects unknown characters before provisioning or writes", async () => {
    const f = fixture();
    await expect(
      f.client.bots.create({
        name: "Aster",
        botKind: "roleplay",
        conversationEngine: "eros",
        erosCharacterId: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow("available engine character");
    expect(f.engine.provision).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("does not clear local history while external history remains authoritative", async () => {
    const f = fixture();
    await expect(f.client.threads.clear({ botId: "rp" })).rejects.toThrow(
      "retains its own history",
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rejects local RP relationship settings for external characters", async () => {
    const f = fixture();
    await expect(f.client.bots.roleplayRelationship({ botId: "rp" })).rejects.toThrow(
      "direct roleplay",
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rejects character/model edits owned by the external service", async () => {
    const f = fixture();
    await expect(
      f.client.bots.update({ botId: "rp", instructions: "Replace the engine prompt" }),
    ).rejects.toThrow("managed by this engine");
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rejects local computer reassignment", async () => {
    const f = fixture();
    await expect(f.client.bots.setComputer({ botId: "rp", mode: "dedicated" })).rejects.toThrow(
      "does not use a computer",
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
