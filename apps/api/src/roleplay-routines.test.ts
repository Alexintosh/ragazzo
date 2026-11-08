import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.test",
  isDeploymentOwner: true,
};
function fixture() {
  const row = {
    id: "routine",
    botId: "rp",
    threadId: "story",
    name: "Check in",
    prompt: "Say hello",
    crons: ["0 12 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    nextRunAt: new Date("2030-01-01T12:00:00Z"),
    lastRunAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const create = vi.fn(async ({ data }) => ({ ...row, ...data }));
  const update = vi.fn(async ({ data }) => ({
    ...row,
    ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  }));
  const findFirst = vi.fn(async () => row);
  const enqueue = vi.fn();
  const client = createRouterClient(
    createRouter({
      prisma: {
        user: { findUnique: vi.fn(async () => ({ roleplayEnabled: true })) },
        bot: {
          findFirst: vi.fn(async () => ({
            id: "rp",
            botKind: "roleplay",
            thread: { id: "story" },
          })),
        },
        routine: { create, update, findFirst },
      },
      events: { append: vi.fn() },
      jobs: { enqueue, cancel: vi.fn() },
      env: { sandboxProvider: "docker" },
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  return { client, create, update, enqueue };
}

describe("roleplay routines reuse", () => {
  it("creates an ordinary timer scoped to the character's direct conversation", async () => {
    const f = fixture();
    const saved = await f.client.routines.create({
      botId: "rp",
      name: "Check in",
      prompt: "Say hello",
      crons: ["0 12 * * *"],
      active: true,
    });
    expect(saved.id).toBe("routine");
    expect(f.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "story",
        botId: "rp",
        userId: "user",
        spaceId: "space",
        active: true,
      }),
    });
    expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });

  it("allows pausing an existing RP timer", async () => {
    const f = fixture();
    await f.client.routines.update({ routineId: "routine", active: false });
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
  });

  it.each([
    { webhookEnabled: true },
    { githubEnabled: true },
    { messageProvider: "sendblue" },
    { watch: { kind: "command" as const, command: "echo test", everyMinutes: 5, loud: false } },
  ])("rejects operational triggers on create and update: %j", async (trigger) => {
    const f = fixture();
    await expect(
      f.client.routines.create({ botId: "rp", name: "Check", prompt: "Check", ...trigger }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.client.routines.update({ routineId: "routine", ...trigger }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
