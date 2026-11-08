import { createRouterClient } from "@orpc/server";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const character = parseRoleplayCharacterJson(
  '{"name":"Mira","description":"A lighthouse keeper."}',
).character;

function fixture(roleplayEnabled = false, sandboxProvider = "docker") {
  const create = vi.fn();
  const transaction = vi.fn();
  const findFirst = vi
    .fn()
    .mockResolvedValue({ id: "rp", botKind: "roleplay", thread: { id: "story" } });
  const client = createRouterClient(
    createRouter({
      prisma: {
        user: { findUnique: vi.fn(async () => ({ roleplayEnabled })) },
        bot: { findFirst, create },
        $transaction: transaction,
      },
      env: { sandboxProvider, phoneCallsEnabled: true },
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  return { client, create, transaction };
}

describe("experimental roleplay admission", () => {
  it("does not create or duplicate characters before account activation", async () => {
    const f = fixture();
    await expect(
      f.client.bots.create({ name: "Mira", botKind: "roleplay", roleplayCharacter: character }),
    ).rejects.toThrow("not enabled");
    await expect(f.client.bots.duplicate({ botId: "rp" })).rejects.toThrow("not enabled");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rejects enabled roleplay on a host-only deployment", async () => {
    const f = fixture(true, "desktop");
    await expect(
      f.client.bots.create({ name: "Mira", botKind: "roleplay", roleplayCharacter: character }),
    ).rejects.toThrow("requires Docker");
    await expect(f.client.bots.duplicate({ botId: "rp" })).rejects.toThrow("requires Docker");
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("refuses live-call mutations before creating call markers or runs", async () => {
    const f = fixture(true);
    const input = { botId: "rp", callId: "call" };
    await expect(f.client.threads.answerCall(input)).rejects.toThrow("does not support live calls");
    await expect(f.client.threads.declineCall({ ...input, outcome: "declined" })).rejects.toThrow(
      "does not support live calls",
    );
    await expect(f.client.threads.endCall(input)).rejects.toThrow("does not support live calls");
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("rejects attached files before model setup, storage, or queue work", async () => {
    const f = fixture(true);
    await expect(
      f.client.threads.send({ botId: "rp", text: "Read this", artifactIds: ["image"] }),
    ).rejects.toThrow("text messages only");
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("refuses new turns for existing characters while roleplay is disabled", async () => {
    const f = fixture();
    await expect(f.client.threads.send({ botId: "rp", text: "Continue" })).rejects.toThrow(
      "not enabled",
    );
    await expect(f.client.threads.followUp({ botId: "rp", text: "Continue" })).rejects.toThrow(
      "not enabled",
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
