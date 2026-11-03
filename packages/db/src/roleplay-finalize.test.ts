import type { MessageBlock, RoleplayCharacter } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finalizeRun } from "./events.js";
import type * as SpontaneousDb from "./roleplay-spontaneous.js";

const spontaneous = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("./roleplay-spontaneous.js", async (original) => ({
  ...(await original<typeof SpontaneousDb>()),
  roleplaySpontaneousSnapshot: (...args: unknown[]) => spontaneous.snapshot(...args),
}));

const character: RoleplayCharacter = {
  name: "Aria",
  description: "Explorer",
  personality: "Curious",
  scenario: "A forest",
  firstMessage: "Hello",
  exampleDialogue: "",
  alternateGreetings: [],
  systemPrompt: "",
  postHistoryInstructions: "",
  lorebook: null,
  conversationStyle: "chat",
};
const album = {
  enabled: true,
  allowSpontaneous: true,
  normalIntervalTurns: 4,
  storyIntervalTurns: 1,
  album: [{ id: "forest", artifactId: "image", description: "A forest", enabled: true }],
};
const text = (value: string): MessageBlock[] => [{ kind: "text", text: value }];
const input = {
  spaceId: "space",
  threadId: "story",
  botId: "aria",
  runId: "turn",
  taskId: "task",
  attemptId: "attempt",
  leaseOwner: "worker",
  leaseFence: 1,
  outcome: "completed" as const,
  blocks: text("One"),
  additionalMessages: [text("Two"), text("Three")],
  roleplayState: { version: 1, continuity: { scene: "At the gate" } },
};

/** An offline transactional store: writes become observable only if the callback succeeds. */
function fixture(
  options: {
    failMessage?: number;
    botKind?: string;
    style?: "chat" | "narrative";
    leaseFence?: number;
    media?: boolean;
    mediaRevision?: number;
  } = {},
) {
  let stored = {
    status: "running",
    leaseFence: options.leaseFence ?? 1,
    firstResponseAt: null as Date | null,
    nextMessageSeq: 5,
    nextEventSeq: 10,
    roleplayState: options.media
      ? {
          media: {
            storyMode: true,
            scene: "Forest",
            revision: options.mediaRevision ?? 0,
            turn: 0,
            lastImageTurn: null,
            sentImageIds: [],
          },
        }
      : (null as unknown),
    messages: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    finishedAttempts: 0,
    finishedTasks: 0,
    updatedBot: false,
  };
  const transaction = vi.fn(async (operation: (tx: unknown) => unknown) => {
    const working = structuredClone(stored);
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({
          status: working.status,
          userId: "player",
          startedAt: null,
          firstResponseAt: working.firstResponseAt,
        })),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async ({ where, data }) => {
          if (
            where.status &&
            (working.status !== where.status || working.leaseFence !== where.leaseFence)
          )
            return { count: 0 };
          if (where.firstResponseAt === null && working.firstResponseAt) return { count: 0 };
          if (data.status) working.status = data.status;
          if (data.firstResponseAt) working.firstResponseAt = data.firstResponseAt;
          return { count: 1 };
        }),
      },
      attempt: {
        updateMany: vi.fn(async () => {
          working.finishedAttempts++;
          return { count: 1 };
        }),
      },
      task: {
        updateMany: vi.fn(async () => {
          working.finishedTasks++;
          return { count: 1 };
        }),
      },
      thread: {
        findFirst: vi.fn(async () => ({
          roleplayState: working.roleplayState,
          historyCompactionGeneration: 0,
        })),
        update: vi.fn(async ({ data }) => {
          if (data.nextMessageSeq) working.nextMessageSeq += data.nextMessageSeq.increment;
          if (data.nextEventSeq) working.nextEventSeq += data.nextEventSeq.increment;
          if (data.roleplayState !== undefined) working.roleplayState = data.roleplayState;
          return { nextMessageSeq: working.nextMessageSeq, nextEventSeq: working.nextEventSeq };
        }),
      },
      message: {
        create: vi.fn(async ({ data }) => {
          if (options.failMessage === working.messages.length + 1)
            throw new Error("Message insert failed");
          const message = { ...data, id: `reply-${working.messages.length + 1}` };
          working.messages.push(message);
          return message;
        }),
      },
      event: {
        create: vi.fn(async ({ data }) => {
          const event = { ...data, createdAt: new Date() };
          working.events.push(event);
          return event;
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      user: { findUnique: vi.fn(async () => ({ roleplayEnabled: true })) },
      artifact: { findMany: vi.fn(async () => [{ id: "image", mimeType: "image/png" }]) },
      bot: {
        findFirst: vi.fn(async () => ({
          botKind: options.botKind ?? "roleplay",
          roleplayCharacter: { ...character, media: album },
        })),
        findUnique: vi.fn(async () => ({
          botKind: options.botKind ?? "roleplay",
          roleplayCharacter: { ...character, conversationStyle: options.style ?? "chat" },
        })),
        update: vi.fn(async () => {
          working.updatedBot = true;
          return {};
        }),
      },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      steeringMessage: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
    };
    const result = await operation(tx);
    stored = working;
    return result;
  });
  const publish = vi.fn(async () => undefined);
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { prisma, transaction, publish, read: () => stored };
}

describe("atomic roleplay chat finalization", () => {
  it("commits the image and delivery ledger under the same lease transaction", async () => {
    const f = fixture({ media: true });
    const blocks: MessageBlock[] = [
      ...text("The forest opens ahead"),
      { kind: "image", artifactId: "image", mimeType: "image/png", name: "forest.png" },
    ];
    const media = {
      storyMode: true,
      scene: "Forest",
      revision: 1,
      turn: 1,
      lastImageTurn: 1,
      sentImageIds: ["forest"],
    };
    await finalizeRun(f.prisma, {
      ...input,
      blocks,
      additionalMessages: undefined,
      roleplayState: { media },
      roleplayMediaGuard: {
        revision: 0,
        historyGeneration: 0,
        characterMedia: JSON.stringify(album),
      },
    });
    expect(f.read().messages).toHaveLength(1);
    expect(f.read().messages[0]!.blocks).toEqual(blocks);
    expect(f.read().roleplayState).toEqual({ media });
  });
  it("suppresses stale prepared image dialogue without replacing the current ledger", async () => {
    const f = fixture({ media: true, mediaRevision: 2 });
    const result = await finalizeRun(f.prisma, {
      ...input,
      blocks: [
        ...text("Here is the picture"),
        { kind: "image", artifactId: "image", mimeType: "image/png", name: "forest.png" },
      ],
      additionalMessages: undefined,
      roleplayState: {
        media: {
          storyMode: true,
          scene: "Forest",
          revision: 1,
          turn: 1,
          lastImageTurn: 1,
          sentImageIds: ["forest"],
        },
      },
      roleplayMediaGuard: {
        revision: 0,
        historyGeneration: 0,
        characterMedia: JSON.stringify(album),
      },
    });
    expect(result).toMatchObject({ suppressed: true });
    expect(f.read().messages).toHaveLength(0);
    expect(f.read().roleplayState).toMatchObject({ media: { revision: 2 } });
  });
  it("commits all bubbles, ordered events, state, and one successful run finalization together", async () => {
    const f = fixture();
    await expect(finalizeRun(f.prisma, input, { publish: f.publish } as never)).resolves.toEqual({
      continuationRunId: null,
    });
    const state = f.read();
    expect(
      state.messages.map((message) => [message.seq, message.blocks, message.runId, message.botId]),
    ).toEqual([
      [5, text("One"), "turn", "aria"],
      [6, text("Two"), "turn", "aria"],
      [7, text("Three"), "turn", "aria"],
    ]);
    expect(state.events.map((event) => [event.seq, event.type, event.runId])).toEqual([
      [10, "thread.message.created", "turn"],
      [11, "thread.message.created", "turn"],
      [12, "thread.message.created", "turn"],
      [13, "run.completed", "turn"],
    ]);
    expect(state.nextMessageSeq).toBe(8);
    expect(state.nextEventSeq).toBe(14);
    expect(state.roleplayState).toEqual(input.roleplayState);
    expect(state.status).toBe("completed");
    expect(state.finishedAttempts).toBe(1);
    expect(state.finishedTasks).toBe(1);
    expect(state.updatedBot).toBe(true);
    expect(f.publish).toHaveBeenCalledOnce();
    await expect(finalizeRun(f.prisma, input, { publish: f.publish } as never)).resolves.toBe(
      false,
    );
    expect(f.read().messages).toHaveLength(3);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("rolls back the reply, snapshot, sequence, and terminal transition when an extra bubble fails", async () => {
    const f = fixture({ failMessage: 2 });
    const before = structuredClone(f.read());
    await expect(finalizeRun(f.prisma, input, { publish: f.publish } as never)).rejects.toThrow(
      "Message insert failed",
    );
    expect(f.read()).toEqual(before);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([{ botKind: "agent" }, { style: "narrative" as const }])(
    "rejects multiple replies outside roleplay chat: %j",
    async (options) => {
      const f = fixture(options);
      await expect(finalizeRun(f.prisma, input)).rejects.toThrow(
        "Multiple replies require a roleplay chat character",
      );
      expect(f.read().status).toBe("running");
      expect(f.read().messages).toEqual([]);
    },
  );

  it.each([
    [text("Two"), text("Three"), text("Four")],
    [[]],
    [[{ kind: "image", url: "https://image.invalid/example.png" }]],
  ])(
    "rejects oversized or unsupported reply sets before writing",
    async (...additionalMessages) => {
      const f = fixture();
      await expect(
        finalizeRun(f.prisma, {
          ...input,
          additionalMessages: additionalMessages as MessageBlock[][],
        }),
      ).rejects.toThrow("at most three messages");
      expect(f.read().messages).toEqual([]);
      expect(f.read().status).toBe("running");
    },
  );

  it("writes no messages or snapshot after the run lease changes", async () => {
    const f = fixture({ leaseFence: 2 });
    await expect(finalizeRun(f.prisma, input)).resolves.toBe(false);
    expect(f.read().messages).toEqual([]);
    expect(f.read().roleplayState).toBeNull();
  });
});

describe("atomic spontaneous finalization", () => {
  const guard = {
    historyGeneration: 0,
    nextMessageSeq: 5,
    character: "character",
    timezone: "UTC",
    sourceMessageId: "actual-user",
    botUpdatedAt: "revision",
    userUpdatedAt: "revision",
  };
  it("commits accepted bubbles only after reading eligibility under all locks", async () => {
    const f = fixture();
    spontaneous.snapshot.mockImplementation(async (tx) => {
      const lockTables = tx.$queryRaw.mock.calls.map(([sql]: [TemplateStringsArray]) =>
        sql.join("?"),
      );
      expect(lockTables[0]).toContain("threads");
      expect(lockTables[1]).toContain("bots");
      expect(lockTables[2]).toContain('"user"');
      return { guard };
    });
    await expect(finalizeRun(f.prisma, { ...input, spontaneousGuard: guard })).resolves.toEqual({
      continuationRunId: null,
    });
    expect(f.read().messages).toHaveLength(3);
  });
  it.each([
    "user-arrived",
    "cleared-history",
    "preferences-edited",
    "timezone-edited",
    "disabled",
    "archived",
    "quiet-window",
  ])("suppresses %s atomically without state/bubbles/errors", async (change) => {
    const f = fixture();
    const changed =
      change === "user-arrived"
        ? { ...guard, nextMessageSeq: 6 }
        : change === "cleared-history"
          ? { ...guard, historyGeneration: 1 }
          : change === "preferences-edited"
            ? { ...guard, botUpdatedAt: "new-revision" }
            : change === "timezone-edited"
              ? { ...guard, userUpdatedAt: "new-revision" }
              : null;
    spontaneous.snapshot.mockResolvedValue(changed ? { guard: changed } : null);
    await expect(finalizeRun(f.prisma, { ...input, spontaneousGuard: guard })).resolves.toEqual({
      continuationRunId: null,
      suppressed: true,
    });
    expect(f.read()).toMatchObject({
      status: "completed",
      messages: [],
      roleplayState: null,
      finishedAttempts: 1,
      finishedTasks: 1,
    });
    expect(f.read().events.map((event) => event.type)).toEqual(["run.completed"]);
  });
  it("silently completes skip and malformed/provider decisions without a visible error", async () => {
    const f = fixture();
    spontaneous.snapshot.mockResolvedValue({ guard });
    await expect(
      finalizeRun(f.prisma, {
        ...input,
        spontaneousGuard: guard,
        outcome: "failed",
        error: "private provider error",
      }),
    ).resolves.toEqual({ continuationRunId: null, suppressed: true });
    expect(f.read().messages).toHaveLength(0);
    expect(JSON.stringify(f.read().events)).not.toContain("private provider error");
  });
});
