import { randomUUID } from "node:crypto";
import type { ConversationEngine } from "@rakazo/adapter-kit";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type {
  Actor,
  ConversationEngineActionResult,
  RunConversationEngineAction,
} from "@rakazo/contracts";
import type * as DatabaseModule from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";

const writes = vi.hoisted(() => ({
  message: vi.fn(async () => ({ id: "imported-message" })),
  event: vi.fn(async () => ({ seq: 7 })),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  createThreadMessageInTransaction: writes.message,
  appendEventInTransaction: writes.event,
}));

import { runConversationEngineAction } from "./conversation-engine-actions.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "private",
  email: "owner@example.invalid",
  isDeploymentOwner: false,
};
const characterId = "22222222-2222-4222-8222-222222222222";
const empty: ConversationEngineActionResult = { message: null, event: null };

type Ledger = {
  id: string;
  sessionId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  historyGeneration: number;
  request: unknown;
  response?: unknown;
  status: string;
};
function fixture() {
  writes.message.mockClear();
  writes.event.mockClear();
  const thread = {
    id: "story",
    botId: "bot",
    spaceId: actor.spaceId,
    userId: actor.userId,
    groupId: null,
    externalConversationId: null,
    historyCompactionGeneration: 0,
  };
  const bot = {
    id: "bot",
    botKind: "roleplay",
    conversationEngine: "eros",
    erosCharacterId: characterId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    archivedAt: null,
    thread,
    conversationEngineSettingsRevision: 3,
    conversationEngineSettings: { tier: "advanced", outfit: "Coat" },
  };
  const session = {
    id: "binding",
    botId: bot.id,
    threadId: thread.id,
    historyGeneration: 0,
    spaceId: actor.spaceId,
    userId: actor.userId,
    status: "active",
    engineUserId: "stored-user",
    engineSessionId: "stored-session",
    engineInstanceId: "stored-instance",
    leaseRunId: null as string | null,
    leaseExpiresAt: null as Date | null,
  };
  const ledger = new Map<string, Ledger>();
  const openSession = vi.fn(async (): Promise<ConversationEngineActionResult> => empty);
  const drawEvent = vi.fn(async (): Promise<ConversationEngineActionResult> => empty);
  const engine: ConversationEngine = {
    id: "eros",
    name: "Eros",
    characters: [{ id: characterId, name: "Aster" }],
    capabilities: { streaming: true, tools: false, cancel: false },
    provision: vi.fn(),
    stream: vi.fn(),
    openSession,
    drawEvent,
    addItem: vi.fn(),
    deleteItem: vi.fn(),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.spaceId === actor.spaceId && where.userId === actor.userId ? bot : null,
      ),
    },
    companionSession: {
      findFirst: vi.fn(async () => session),
      upsert: vi.fn(async () => session),
      findUniqueOrThrow: vi.fn(async () => session),
      update: vi.fn(async ({ data }) => Object.assign(session, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.leaseRunId && session.leaseRunId !== where.leaseRunId) return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    companionAction: {
      findFirst: vi.fn(async ({ where }) =>
        where.id
          ? (ledger.get(where.id) ?? null)
          : ([...ledger.values()].find(
              (row) => row.sessionId === where.sessionId && where.status.in.includes(row.status),
            ) ?? null),
      ),
      create: vi.fn(async ({ data }) => {
        ledger.set(data.id, { ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }) => Object.assign(ledger.get(where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = ledger.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    run: { findFirst: vi.fn(async () => null) },
    companionTurn: { findFirst: vi.fn(async () => null) },
    message: { findUnique: vi.fn(async () => null) },
  };
  const notify = vi.fn(async () => {});
  const deps = {
    prisma: { ...tx, $transaction: vi.fn(async (work) => work(tx)) },
    env: { roleplayEnabled: true },
    conversationEngines: new Map([["eros", engine]]),
    events: { notify },
  } as unknown as RouterDeps;
  const input: RunConversationEngineAction = {
    botId: bot.id,
    historyGeneration: 0,
    actionId: randomUUID(),
    action: { kind: "open", occasion: "just_opened" },
  };
  return { deps, input, bot, thread, session, ledger, tx, engine, openSession, drawEvent, notify };
}

describe("conversation engine action API", () => {
  it("records a null outcome as completed and never executes that action again", async () => {
    const f = fixture();
    expect(await runConversationEngineAction(f.deps, actor, f.input)).toEqual({
      status: "completed",
      message: null,
    });
    expect(f.ledger.get(f.input.actionId)).toMatchObject({
      status: "completed",
      request: { action: f.input.action, settings: { tier: "advanced", outfit: "Coat" } },
    });
    expect(await runConversationEngineAction(f.deps, actor, f.input)).toEqual({
      status: "completed",
      message: null,
    });
    expect(f.openSession).toHaveBeenCalledTimes(1);
    expect(f.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "stored-user",
        sessionId: "stored-session",
        instanceId: "stored-instance",
        characterId,
        actionId: f.input.actionId,
      }),
      undefined,
    );
    expect(writes.message).not.toHaveBeenCalled();
  });

  it("imports a native reply exactly once and publishes only after its local commit", async () => {
    const f = fixture();
    const messageId = randomUUID();
    f.openSession.mockResolvedValueOnce({
      message: {
        id: messageId,
        text: "Hello again",
        sentAt: "2026-01-01T00:00:00Z",
        occasion: "just_opened",
      },
      event: null,
    });
    expect(await runConversationEngineAction(f.deps, actor, f.input)).toEqual({
      status: "completed",
      message: "Hello again",
    });
    await runConversationEngineAction(f.deps, actor, f.input);
    expect(f.openSession).toHaveBeenCalledTimes(1);
    expect(writes.message).toHaveBeenCalledTimes(1);
    expect(writes.message).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        clientNonce: `eros:stored-session:${messageId}`,
        role: "bot",
        blocks: [{ kind: "text", text: "Hello again" }],
      }),
    );
    expect(writes.event).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.session.leaseRunId).toBeNull();
  });

  it("holds an ambiguous accepted action without replay and blocks subsequent actions", async () => {
    const f = fixture();
    f.openSession.mockRejectedValueOnce(new Error("Synthetic network disconnect"));
    expect(await runConversationEngineAction(f.deps, actor, f.input)).toEqual({
      status: "uncertain",
      message: null,
    });
    expect(f.ledger.get(f.input.actionId)?.status).toBe("uncertain");
    expect(await runConversationEngineAction(f.deps, actor, f.input)).toEqual({
      status: "uncertain",
      message: null,
    });
    await expect(
      runConversationEngineAction(f.deps, actor, { ...f.input, actionId: randomUUID() }),
    ).rejects.toThrow("settle");
    expect(f.openSession).toHaveBeenCalledTimes(1);
  });

  it("rejects reused identities with changed payloads and stale generations", async () => {
    const f = fixture();
    await runConversationEngineAction(f.deps, actor, f.input);
    await expect(
      runConversationEngineAction(f.deps, actor, {
        ...f.input,
        action: { kind: "open", occasion: "returning" },
      }),
    ).rejects.toThrow("settle");
    await expect(
      runConversationEngineAction(f.deps, actor, {
        ...f.input,
        actionId: randomUUID(),
        historyGeneration: 1,
      }),
    ).rejects.toThrow("settle");
    expect(f.openSession).toHaveBeenCalledTimes(1);
  });

  it("records definite rejection without replay and permits a corrected new action", async () => {
    const f = fixture();
    f.openSession.mockRejectedValueOnce(new ConversationEngineError("invalid_request"));
    await expect(runConversationEngineAction(f.deps, actor, f.input)).rejects.toThrow("rejected");
    expect(f.ledger.get(f.input.actionId)?.status).toBe("failed");
    await expect(runConversationEngineAction(f.deps, actor, f.input)).rejects.toThrow("rejected");
    expect(
      await runConversationEngineAction(f.deps, actor, { ...f.input, actionId: randomUUID() }),
    ).toEqual({ status: "completed", message: null });
    expect(f.openSession).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign owners and active leases before external calls", async () => {
    const f = fixture();
    await expect(
      runConversationEngineAction(f.deps, { ...actor, userId: "stranger" }, f.input),
    ).rejects.toThrow();
    f.session.leaseExpiresAt = new Date(Date.now() + 60_000);
    await expect(runConversationEngineAction(f.deps, actor, f.input)).rejects.toThrow("settle");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.tx.companionAction.create).not.toHaveBeenCalled();
  });
});
