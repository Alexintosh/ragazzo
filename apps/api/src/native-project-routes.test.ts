import type { Actor, Bot, CreateBotInput, SetBotExecutionInput } from "@rakazo/contracts";
import { setBotExecution } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { botsRoutes } from "./routes/bots.js";
import type { RouterContext } from "./routes/context.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  setBotExecution: vi.fn(async () => ({ threadId: "thread", seq: 1 })),
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
const execution: SetBotExecutionInput = {
  botId: "bot",
  runtimeKind: "codex",
  runtimePermission: "workspace",
  executionTarget: "host",
  projectPath: "/alias/project",
};
const creation: CreateBotInput = {
  botKind: "agent",
  name: "Fixture",
  description: "",
  instructions: "",
  computerMode: "dedicated",
  notifyOnFinish: true,
  ...execution,
};
beforeEach(() => vi.clearAllMocks());
function fixture(existingSpawn = false, sandboxProvider = "docker") {
  let saved = {
    id: "bot",
    runtimeKind: "codex",
    projectPath: "/canonical/project",
    spawnKey: existingSpawn ? "existing-key" : null,
    threadId: "thread",
  } as Bot;
  const hostProjectDirectory = vi.fn(async () => "/canonical/project");
  const createBot = vi.fn(async (_actor: Actor, input: CreateBotInput) => {
    saved = { ...saved, projectPath: input.projectPath ?? null };
    return saved;
  });
  const getBot = vi.fn(async () => ({ ...saved, thread: { id: "thread" } }));
  const deps = {
    hostProjectDirectory,
    events: { notify: vi.fn(async () => undefined) },
    env: { nativeHostConfigured: true, sandboxProvider, agentRuntime: "scripted" },
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => [{ nativeSetupDisabledAt: null }]),
          spaceMember: {
            findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
          },
        }),
    },
  } as unknown as RouterDeps;
  // Invoke the actual route handlers; authentication middleware has already supplied this actor.
  let authed: object;
  authed = new Proxy(
    {},
    { get: (_target, key) => (key === "handler" ? (handler: unknown) => handler : authed) },
  );
  const routes = botsRoutes({
    deps,
    authed,
    repos: { createBot, getBot, listBots: vi.fn(async () => [saved]) },
  } as unknown as RouterContext).bots;
  return {
    hostProjectDirectory,
    createBot,
    getBot,
    save: (value: Bot) => {
      saved = value;
    },
    saved: () => saved,
    create: routes.create as unknown as (args: {
      context: { actor: Actor };
      input: CreateBotInput;
    }) => Promise<Bot>,
    setExecution: routes.setExecution as unknown as (args: {
      context: { actor: Actor };
      input: SetBotExecutionInput;
    }) => Promise<Bot>,
  };
}
describe("native project routes", () => {
  it("rejects Docker placement on a host-only server before changing a bot", async () => {
    const f = fixture(false, "desktop");
    await expect(
      f.create({
        context: { actor },
        input: { ...creation, runtimeKind: "pi", executionTarget: "docker", projectPath: null },
      }),
    ).rejects.toThrow("Docker sandbox is not enabled on this server");
    await expect(
      f.setExecution({
        context: { actor },
        input: { ...execution, runtimeKind: "pi", executionTarget: "docker", projectPath: null },
      }),
    ).rejects.toThrow("Docker sandbox is not enabled on this server");
    expect(f.createBot).not.toHaveBeenCalled();
    expect(f.getBot).not.toHaveBeenCalled();
    expect(f.hostProjectDirectory).not.toHaveBeenCalled();
    expect(setBotExecution).not.toHaveBeenCalled();
  });
  it("still permits host placement on a host-only server", async () => {
    const f = fixture(false, "desktop");
    await expect(f.create({ context: { actor }, input: creation })).resolves.toMatchObject({
      id: "bot",
    });
    await expect(f.setExecution({ context: { actor }, input: execution })).resolves.toMatchObject({
      id: "bot",
    });
  });
  it("persists canonical paths on creation and returns the canonical bot", async () => {
    const f = fixture();
    const result = await f.create({ context: { actor }, input: creation });
    expect(f.createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ projectPath: "/canonical/project" }),
    );
    expect(result.projectPath).toBe("/canonical/project");
  });
  it("persists canonical paths on settings save and returns the canonical bot", async () => {
    const f = fixture();
    vi.mocked(setBotExecution).mockImplementationOnce(async (_prisma, _actor, input) => {
      f.save({ ...f.saved(), projectPath: input.projectPath });
      return { threadId: "thread", seq: 1 };
    });
    const result = await f.setExecution({ context: { actor }, input: execution });
    expect(setBotExecution).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ projectPath: "/canonical/project" }),
    );
    expect(result.projectPath).toBe("/canonical/project");
  });
  it("does not probe any host for a bot the actor does not own", async () => {
    const f = fixture();
    f.getBot.mockRejectedValueOnce(new Error("not owned"));
    await expect(f.setExecution({ context: { actor }, input: execution })).rejects.toThrow(
      "not owned",
    );
    expect(f.hostProjectDirectory).not.toHaveBeenCalled();
    expect(setBotExecution).not.toHaveBeenCalled();
  });
  it("keeps native creation retries independent of removed aliases and unavailable hosts", async () => {
    const f = fixture(true);
    f.hostProjectDirectory.mockRejectedValueOnce(new Error("old alias is gone"));
    const result = await f.create({
      context: { actor },
      input: { ...creation, spawnKey: "existing-key" },
    });
    expect(result.projectPath).toBe("/canonical/project");
    expect(f.hostProjectDirectory).not.toHaveBeenCalled();
    expect(f.createBot).not.toHaveBeenCalled();
  });
});
