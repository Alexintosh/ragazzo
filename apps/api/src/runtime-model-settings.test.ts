import type { Actor, RuntimeModels } from "@rakazo/contracts";
import { BotExecutionSettingsError, IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { loadBotRuntimeModels, setBotRuntimeModel } from "./runtime-model-settings.js";

const persist = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  setBotRuntimeModel: persist,
}));

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const bot = {
  id: "bot",
  runtimeKind: "codex" as const,
  executionTarget: "host" as const,
  projectPath: "/project",
  threadId: "thread",
  thread: { id: "thread" },
  runtimeGeneration: 3,
  registeredHostId: "host",
};
const catalog: RuntimeModels = {
  runtimeKind: "codex",
  available: true,
  defaultModelId: "model-a",
  models: [
    {
      id: "model-a",
      name: "Model A",
      thinkingLevels: ["low", "high"],
      defaultThinkingLevel: "low",
      isDefault: true,
    },
  ],
};
const selection = { botId: bot.id, modelId: "model-a", thinkingLevel: "high" as const };

function fixture(member = true) {
  const nativeRuntimeModels = vi.fn<NonNullable<RouterDeps["nativeRuntimeModels"]>>(
    async () => catalog,
  );
  const findBot = vi.fn(async () => bot as typeof bot | null);
  const notify = vi.fn(async () => undefined);
  const deps = {
    nativeRuntimeModels,
    events: { notify },
    prisma: {
      bot: { findFirst: findBot },
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => [{ nativeSetupDisabledAt: null }]),
          spaceMember: {
            findUnique: vi.fn(async () =>
              member ? { organizationId: "org", space: { deletingAt: null } } : null,
            ),
          },
        }),
    },
  } as unknown as RouterDeps;
  return { deps, nativeRuntimeModels, findBot, notify };
}

beforeEach(() => {
  persist.mockReset();
  persist.mockResolvedValue({ threadId: "thread", seq: 7 });
});

describe("native bot model catalog API boundary", () => {
  it("binds discovery to the actor, bot and thread, with a bounded signal", async () => {
    const f = fixture();
    expect(await loadBotRuntimeModels(f.deps, actor, bot)).toEqual(catalog);
    expect(f.nativeRuntimeModels).toHaveBeenCalledWith(
      "bot",
      "thread",
      expect.objectContaining({
        userId: "owner",
        spaceId: "space",
        botId: "bot",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not probe the host after membership loss", async () => {
    const f = fixture(false);
    expect(await loadBotRuntimeModels(f.deps, actor, bot)).toMatchObject({
      available: false,
      models: [],
    });
    expect(f.nativeRuntimeModels).not.toHaveBeenCalled();
  });

  it.each(["pi", "claude", "acp"] as const)(
    "does not advertise unsupported native controls for %s",
    async (runtimeKind) => {
      const f = fixture();
      expect(await loadBotRuntimeModels(f.deps, actor, { ...bot, runtimeKind })).toMatchObject({
        available: false,
        reason: "unsupported-runtime",
        models: [],
      });
      expect(f.nativeRuntimeModels).not.toHaveBeenCalled();
    },
  );

  it("redacts host errors and rejects mismatched or malformed catalogs", async () => {
    const f = fixture();
    f.nativeRuntimeModels.mockRejectedValueOnce(new Error("secret-token /private/account"));
    expect(await loadBotRuntimeModels(f.deps, actor, bot)).toEqual({
      runtimeKind: "codex",
      available: false,
      models: [],
      defaultModelId: null,
      reason: "host-unavailable",
    });
    f.nativeRuntimeModels.mockResolvedValueOnce({ ...catalog, runtimeKind: "claude" });
    expect(await loadBotRuntimeModels(f.deps, actor, bot)).toMatchObject({
      available: false,
      models: [],
    });
    f.nativeRuntimeModels.mockResolvedValueOnce({ ...catalog, models: [{}] } as RuntimeModels);
    expect(await loadBotRuntimeModels(f.deps, actor, bot)).toMatchObject({
      available: false,
      models: [],
    });
  });

  it("propagates cancellation to the host request", async () => {
    const f = fixture();
    const controller = new AbortController();
    await loadBotRuntimeModels(f.deps, actor, bot, controller.signal);
    const signal = f.nativeRuntimeModels.mock.calls[0]![2].signal!;
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("native bot model selection API boundary", () => {
  it("checks bot ownership before host discovery or persistence", async () => {
    const f = fixture();
    f.findBot.mockResolvedValueOnce(null);
    await expect(setBotRuntimeModel(f.deps, actor, selection)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.findBot).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot", spaceId: "space", userId: "owner", archivedAt: null },
      }),
    );
    expect(f.nativeRuntimeModels).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("saves a supported pair with the exact discovered execution identity", async () => {
    const f = fixture();
    await setBotRuntimeModel(f.deps, actor, selection);
    expect(persist).toHaveBeenCalledWith(f.deps.prisma, actor, selection, {
      runtimeKind: "codex",
      runtimeGeneration: 3,
      registeredHostId: "host",
      projectPath: "/project",
    });
    expect(f.notify).toHaveBeenCalledWith("thread", 7);
  });

  it.each([
    { modelId: "unknown", thinkingLevel: null },
    { modelId: "model-a", thinkingLevel: "medium" as const },
    { modelId: null, thinkingLevel: "high" as const },
  ])("rejects unsupported model/effort pair %j before persistence", async (pair) => {
    const f = fixture();
    await expect(
      setBotRuntimeModel(f.deps, actor, { botId: "bot", ...pair }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("clears model and effort together when returning to the runtime default", async () => {
    const f = fixture();
    const input = { botId: "bot", modelId: null, thinkingLevel: null };
    await setBotRuntimeModel(f.deps, actor, input);
    expect(persist).toHaveBeenCalledWith(f.deps.prisma, actor, input, expect.any(Object));
  });

  it("does not persist when the host catalog is unavailable", async () => {
    const f = fixture();
    f.nativeRuntimeModels.mockRejectedValueOnce(new Error("host offline"));
    await expect(setBotRuntimeModel(f.deps, actor, selection)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns a conflict when execution changed or work became active before commit", async () => {
    const f = fixture();
    persist.mockRejectedValueOnce(
      new BotExecutionSettingsError("Stop the bot before changing its model"),
    );
    await expect(setBotRuntimeModel(f.deps, actor, selection)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Stop the bot before changing its model",
    });
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("does not turn a committed save into failure if notification delivery fails", async () => {
    const f = fixture();
    f.notify.mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(setBotRuntimeModel(f.deps, actor, selection)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
