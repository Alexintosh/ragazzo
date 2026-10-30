import type { ConversationEngine } from "@rakazo/adapter-kit";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type { ConversationEngineInspection } from "@rakazo/contracts";
import { UpdateConversationEngineStateInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  loadConversationEngineState,
  updateConversationEngineSettings,
  updateConversationEngineState,
} from "./conversation-engine-state.js";
import type { RouterDeps } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "private",
  email: "owner@example.invalid",
  isDeploymentOwner: false,
};
const characterId = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const thread = {
    id: "story",
    botId: "bot",
    userId: actor.userId,
    spaceId: actor.spaceId,
    groupId: null,
    externalConversationId: null,
    historyCompactionGeneration: 0,
  };
  const bot = {
    id: "bot",
    botKind: "roleplay",
    conversationEngine: "eros",
    erosCharacterId: characterId,
    conversationEngineSettings: null as Record<string, unknown> | null,
    conversationEngineSettingsRevision: 0,
    thread,
  };
  const session = {
    id: "binding",
    engineUserId: "stored-user",
    engineSessionId: "stored-session",
    engineInstanceId: "stored-instance",
    leaseExpiresAt: null as Date | null,
  };
  const findBot = vi.fn(async () => bot);
  const findSession = vi.fn(async () => session);
  const inspect = vi.fn(async () => ({}) as ConversationEngineInspection);
  const updateState = vi.fn(async () => {});
  const engine: ConversationEngine = {
    id: "eros",
    name: "Eros",
    characters: [{ id: characterId, name: "Aster" }],
    capabilities: { streaming: true, tools: false, cancel: false },
    provision: vi.fn(),
    stream: vi.fn(),
    inspect,
    updateState,
  };
  const tx = {
    bot: {
      findFirst: findBot,
      update: vi.fn(
        async (args: { data: { conversationEngineSettings: Record<string, unknown> } }) => ({
          conversationEngineSettings: args.data.conversationEngineSettings,
          conversationEngineSettingsRevision: 1,
        }),
      ),
    },
    companionSession: { findFirst: findSession },
    run: { findFirst: vi.fn(async () => null) },
    companionTurn: { findFirst: vi.fn(async () => null) },
    companionAction: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
  };
  const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<void>) => fn(tx));
  const deps = {
    prisma: { ...tx, $transaction: transaction },
    conversationEngines: new Map([["eros", engine]]),
    env: { roleplayEnabled: true },
  } as unknown as RouterDeps;
  const input = {
    botId: bot.id,
    historyGeneration: 0,
    expectedRevision: "revision-1",
    axes: { trust: 0.2, intrigue: 0.3, intimacy: 0.1, tension: 0.4 },
    warmthGrade: 2,
    patienceGrade: 2,
  };
  return {
    deps,
    bot,
    thread,
    session,
    findBot,
    findSession,
    inspect,
    updateState,
    tx,
    transaction,
    input,
  };
}

describe("conversation engine state API", () => {
  it("accepts only bot identity from clients and selects persisted binding under full owner scope", async () => {
    const f = fixture();
    await loadConversationEngineState(f.deps, actor, f.bot.id);
    expect(f.findBot).toHaveBeenCalledWith({
      where: { id: "bot", spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true },
    });
    expect(f.findSession).toHaveBeenCalledWith({
      where: {
        botId: "bot",
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: "story",
        historyGeneration: 0,
        status: "active",
      },
    });
    expect(f.inspect).toHaveBeenCalledWith(
      {
        userId: "stored-user",
        sessionId: "stored-session",
        instanceId: "stored-instance",
        characterId,
      },
      undefined,
    );
    const parsed = UpdateConversationEngineStateInput.parse({
      ...f.input,
      sessionId: "client-session",
      instanceId: "client-instance",
      userId: "client-user",
      baseUrl: "http://untrusted.invalid",
    });
    expect(parsed).toEqual(f.input);
  });

  it("returns uninitialized without provisioning before the first conversation", async () => {
    const f = fixture();
    f.session.engineSessionId = "";
    expect(await loadConversationEngineState(f.deps, actor, "bot")).toMatchObject({
      status: "uninitialized",
      settings: { revision: 0, values: {} },
    });
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("saves versioned request defaults before provisioning and never calls the engine", async () => {
    const f = fixture();
    f.findSession.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
    const saved = await updateConversationEngineSettings(f.deps, actor, {
      botId: "bot",
      historyGeneration: 0,
      expectedRevision: 0,
      settings: {
        tier: "advanced",
        promptTraits: [{ tag: "curious", text: "Ask about new ideas" }],
      },
    });
    expect(saved).toMatchObject({ revision: 1, values: { tier: "advanced" } });
    expect(f.tx.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot", conversationEngineSettingsRevision: 0 },
        data: expect.objectContaining({ conversationEngineSettingsRevision: { increment: 1 } }),
      }),
    );
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.updateState).not.toHaveBeenCalled();
  });

  it("rejects stale settings revisions and active or unreconciled turns", async () => {
    const input = { botId: "bot", historyGeneration: 0, expectedRevision: 0, settings: {} };
    const stale = fixture();
    stale.bot.conversationEngineSettingsRevision = 1;
    await expect(updateConversationEngineSettings(stale.deps, actor, input)).rejects.toThrow(
      "Refresh before saving",
    );
    expect(stale.tx.bot.update).not.toHaveBeenCalled();
    const busy = fixture();
    busy.tx.run.findFirst.mockResolvedValueOnce({ id: "running" } as never);
    await expect(updateConversationEngineSettings(busy.deps, actor, input)).rejects.toThrow(
      "current reply",
    );
    const uncertain = fixture();
    uncertain.tx.companionTurn.findFirst.mockResolvedValueOnce({ id: "uncertain" } as never);
    await expect(updateConversationEngineSettings(uncertain.deps, actor, input)).rejects.toThrow(
      "current reply",
    );
    expect(uncertain.tx.bot.update).not.toHaveBeenCalled();
    const action = fixture();
    action.tx.companionAction.findFirst.mockResolvedValueOnce({ id: "uncertain-action" } as never);
    await expect(updateConversationEngineSettings(action.deps, actor, input)).rejects.toThrow(
      "current reply",
    );
    expect(action.tx.bot.update).not.toHaveBeenCalled();
  });

  it("rejects an in-flight binding change before returning remote data", async () => {
    const f = fixture();
    f.findSession
      .mockResolvedValueOnce(f.session)
      .mockResolvedValueOnce({ ...f.session, engineSessionId: "changed" });
    await expect(loadConversationEngineState(f.deps, actor, "bot")).rejects.toThrow(
      "conversation changed",
    );
  });

  it("maps an ambiguous local commit after remote acceptance to refresh without retrying", async () => {
    const f = fixture();
    f.transaction.mockImplementationOnce(async (fn) => {
      await fn(f.tx);
      throw new Error("Synthetic transaction timeout");
    });
    await expect(updateConversationEngineState(f.deps, actor, f.input)).rejects.toThrow(
      "Refresh its state before saving again",
    );
    expect(f.updateState).toHaveBeenCalledTimes(1);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("bounds simulated elapsed time and preserves the server-owned binding when saving it", async () => {
    const f = fixture();
    for (const elapsedHours of [-1, 721, Number.NaN, "12"]) {
      expect(
        UpdateConversationEngineStateInput.safeParse({ ...f.input, elapsedHours }).success,
      ).toBe(false);
    }
    const input = UpdateConversationEngineStateInput.parse({ ...f.input, elapsedHours: 48.5 });
    await updateConversationEngineState(f.deps, actor, input);
    expect(f.updateState).toHaveBeenCalledWith(
      {
        userId: "stored-user",
        sessionId: "stored-session",
        instanceId: "stored-instance",
        characterId,
        expectedRevision: input.expectedRevision,
        axes: input.axes,
        warmthGrade: 2,
        patienceGrade: 2,
        elapsedHours: 48.5,
      },
      undefined,
    );
  });

  it("preserves native CAS conflicts and reports a confirmed save whose refresh fails", async () => {
    const f = fixture();
    f.updateState.mockRejectedValueOnce(new ConversationEngineError("conflict"));
    await expect(updateConversationEngineState(f.deps, actor, f.input)).rejects.toThrow(
      "Refresh before saving",
    );
    f.inspect.mockRejectedValueOnce(new ConversationEngineError("unavailable"));
    await expect(updateConversationEngineState(f.deps, actor, f.input)).rejects.toThrow(
      "Engine state was saved",
    );
    expect(f.updateState).toHaveBeenCalledTimes(2);
  });
});
