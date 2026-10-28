import type { MessageBlock, RoleplayCharacter } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finalizeRun } from "./events.js";

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
  } = {},
) {
  let stored = {
    status: "running",
    leaseFence: options.leaseFence ?? 1,
    firstResponseAt: null as Date | null,
    nextMessageSeq: 5,
    nextEventSeq: 10,
    roleplayState: null as unknown,
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
      bot: {
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
  ])("rejects oversized or non-text reply sets before writing", async (...additionalMessages) => {
    const f = fixture();
    await expect(
      finalizeRun(f.prisma, {
        ...input,
        additionalMessages: additionalMessages as MessageBlock[][],
      }),
    ).rejects.toThrow("at most three text messages");
    expect(f.read().messages).toEqual([]);
    expect(f.read().status).toBe("running");
  });

  it("writes no messages or snapshot after the run lease changes", async () => {
    const f = fixture({ leaseFence: 2 });
    await expect(finalizeRun(f.prisma, input)).resolves.toBe(false);
    expect(f.read().messages).toEqual([]);
    expect(f.read().roleplayState).toBeNull();
  });
});
