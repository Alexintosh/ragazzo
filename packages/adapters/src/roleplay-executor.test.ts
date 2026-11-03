import type { RoleplayCharacter } from "@rakazo/contracts";
import { RoleplayContinuitySchema } from "@rakazo/contracts";
import {
  buildRoleplayRelationshipContext,
  roleplayStoryState,
  roleplayTokens,
  STEERING_CONTINUATION_PROMPT,
} from "@rakazo/core";
import type * as Database from "@rakazo/db";
import type { Run } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { RoleplayRunRequest, RoleplayRuntime } from "./roleplay-runtime.js";
import type * as RunModel from "./run-model.js";
import type * as RunNotifications from "./run-notifications.js";

const fake = vi.hoisted(() => ({
  provision: vi.fn(),
  resolveModel: vi.fn(),
  release: vi.fn(),
  notify: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Database>()),
  roleplaySpontaneousSnapshot: (...args: unknown[]) => fake.snapshot(...args),
}));
vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireDedicatedScreenLeaseFence: vi.fn(async () => ({
    computerId: "computer",
    runId: "turn",
    fence: 1,
  })),
  releaseComputerExecutionLease: (...args: unknown[]) => fake.release(...args),
  renewComputerExecutionLease: vi.fn(async () => true),
  provisionComputer: (...args: unknown[]) => fake.provision(...args),
}));
vi.mock("./run-model.js", async (original) => ({
  ...(await original<typeof RunModel>()),
  resolveRunModel: (...args: unknown[]) => fake.resolveModel(...args),
}));

vi.mock("./run-notifications.js", async (original) => ({
  ...(await original<typeof RunNotifications>()),
  notifyRun: (...args: unknown[]) => fake.notify(...args),
}));

import { ComputerBusyError } from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { executeRoleplayRun } from "./roleplay-executor.js";

const character: RoleplayCharacter = {
  name: "Aria",
  description: "An explorer",
  personality: "Curious",
  scenario: "A forest",
  exampleDialogue: "{{char}}: Onward.",
  firstMessage: "The gate opens.",
  alternateGreetings: [],
  systemPrompt: "Stay in character.",
  postHistoryInstructions: "",
  lorebook: null,
};
const continuity = {
  scene: "Beside the forest gate",
  relationship: "New travel companions",
  sharedDetails: ["They found a map"],
  openThreads: ["Find the hidden path"],
  callbacks: ["The lantern keeps flickering"],
};
function fixture() {
  const run = {
    id: "turn",
    botId: "aria",
    threadId: "story",
    taskId: "task",
    userId: "player",
    spaceId: "space",
    status: "running",
    leaseOwner: "worker",
    leaseFence: 1,
    trigger: "user",
    sourceMessageId: "source",
    checkpoint: null,
    startedAt: null,
    leaseExpiresAt: null,
  };
  const thread = {
    id: "story",
    spaceId: "space",
    userId: "player",
    botId: "aria",
    taskBotId: null,
    groupId: null as string | null,
    externalConversationId: null,
    historyCompactionGeneration: 0,
    nextMessageSeq: 101,
    historyCompactionSummary: "GLOBAL AGENT SUMMARY MUST NEVER ENTER STORY",
    roleplayState: null as unknown,
  };
  const bot = {
    userId: "player",
    spaceId: "space",
    id: "aria",
    name: "Aria",
    botKind: "roleplay",
    runtimeKind: "pi",
    executionTarget: "docker",
    computerId: "computer",
    computerSwitching: false,
    roleplayCharacter: character,
    computer: {
      userId: "player",
      spaceId: "space",
      id: "computer",
      kind: "docker",
      executionTarget: "docker",
      scope: "dedicated",
      registeredHostId: null,
    },
  };
  const rows = [
    {
      seq: 0,
      threadId: "story",
      role: "bot",
      botId: "aria",
      blocks: [{ kind: "text", text: "The gate opens." }],
    },
    {
      seq: 1,
      threadId: "story",
      role: "user",
      botId: null,
      blocks: [{ kind: "text", text: "Earlier scene." }],
    },
    {
      seq: 2,
      threadId: "story",
      role: "bot",
      botId: "aria",
      blocks: [
        { kind: "text", text: "We found a map." },
        { kind: "steps", steps: [{ label: "SECRET TOOL OUTPUT" }] },
      ],
    },
    {
      seq: 3,
      threadId: "story",
      role: "bot",
      botId: "other-bot",
      blocks: [{ kind: "text", text: "OTHER BOT SECRET" }],
    },
    {
      seq: 4,
      threadId: "other-story",
      role: "user",
      botId: null,
      blocks: [{ kind: "text", text: "OTHER STORY SECRET" }],
    },
    {
      seq: 5,
      threadId: "story",
      role: "system",
      botId: "aria",
      blocks: [{ kind: "text", text: "SYSTEM ADMIN SECRET" }],
    },
    {
      seq: 100,
      threadId: "story",
      role: "user",
      botId: null,
      blocks: [{ kind: "text", text: "UNCLAIMED FUTURE INPUT" }],
    },
  ];
  const requests: RoleplayRunRequest[] = [];
  const runtime: RoleplayRuntime = {
    run: vi.fn(async function* (request) {
      requests.push(request);
      const text =
        request.purpose === "memory" ? "Scoped story memory." : "Aria lifts the lantern.";
      yield { type: "text" as const, text };
      yield { type: "done" as const, text };
    }),
    abort: vi.fn(async () => undefined),
  };
  const forbidden = vi.fn(() => {
    throw new Error("Agent machinery must not run");
  });
  const finalizeRun = vi.fn(async (input) => {
    if (
      run.status !== "running" ||
      run.leaseOwner !== input.leaseOwner ||
      run.leaseFence !== input.leaseFence
    )
      return false;
    run.status = input.outcome;
    if (input.roleplayState) thread.roleplayState = input.roleplayState;
    return { continuationRunId: null as string | null };
  });
  const user = { timezone: "Europe/Lisbon", roleplayEnabled: true };
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }) => (where.id === "player" ? user : null)) },
    run: {
      findUnique: vi.fn(async () => ({ ...run })),
      findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.leaseOwner && where.leaseOwner !== run.leaseOwner) return { count: 0 };
        if (typeof where.status === "string" && where.status !== run.status) return { count: 0 };
        if (where.leaseFence !== undefined && where.leaseFence !== run.leaseFence)
          return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: { findUniqueOrThrow: vi.fn(async () => bot) },
    thread: { findUniqueOrThrow: vi.fn(async () => thread) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "task",
        botId: "aria",
        threadId: "story",
        spaceId: "space",
        prompt: "I follow the map.",
      })),
    },
    message: {
      findFirst: vi.fn(
        async (_args: { where: { seq?: unknown } }) =>
          ({
            seq: 99,
            blocks: [{ kind: "text", text: "I follow the map." }],
          }) as { seq: number; blocks: Array<{ kind: string; text: string }>; createdAt?: Date },
      ),
      findMany: vi.fn(async ({ where }) =>
        where.id
          ? [
              {
                seq: 99,
                role: "user",
                botId: null,
                threadId: "story",
                blocks: [{ kind: "text", text: "I follow the map." }],
              },
            ]
          : rows
              .filter(
                (row) =>
                  row.threadId === where.threadId &&
                  row.seq > where.seq.gt &&
                  row.seq < where.seq.lt &&
                  ((row.role === "user" && row.seq < where.OR[0].seq.lt) ||
                    (row.role === "bot" && row.botId === "aria")),
              )
              .sort((a, b) => a.seq - b.seq),
      ),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    artifact: {
      findFirst: vi.fn(async () => ({
        id: "art-forest",
        mimeType: "image/png",
        name: "forest.png",
      })),
    },
    connection: { findMany: forbidden },
    agentSecret: { findMany: forbidden },
    taughtSkill: { findMany: forbidden },
  };
  const deps = {
    prisma,
    roleplayRuntime: runtime,
    events: { append: vi.fn(async () => ({})), finalizeRun, claimSteering: vi.fn(async () => []) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: ["fake-deployment-secret"],
    sandbox: {
      describe: () => ({ id: "docker" }),
      provisionKind: vi.fn(async () => "docker"),
      exec: forbidden,
      computer: forbidden,
    },
    runtime: { describe: () => ({ capabilities: { scripted: true } }), run: forbidden },
    memory: { read: forbidden, write: forbidden },
    memoryProviders: { resolve: forbidden },
    connector: { discoverTools: forbidden },
    secretStore: { load: forbidden },
    web: {},
    mediaGeneration: {},
    browser: {},
  } as unknown as ExecutorDeps;
  return { deps, run, thread, bot, rows, requests, runtime, forbidden, finalizeRun, prisma, user };
}

function visibleRequests(f: { requests: RoleplayRunRequest[] }) {
  return f.requests.filter((request) => request.purpose !== "direction");
}

beforeEach(() => {
  fake.provision
    .mockReset()
    .mockResolvedValue({ id: "container", kind: "docker", executionTarget: "docker" });
  fake.resolveModel.mockReset().mockResolvedValue({
    provider: "neutral",
    id: "fiction-model",
    contextWindow: 16_384,
    maxTokens: 2048,
    apiKey: "fake-model-secret",
  });
  fake.release.mockReset().mockResolvedValue(undefined);
  fake.notify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("roleplay chat continuity", () => {
  function chatFixture() {
    const f = fixture();
    f.bot.roleplayCharacter = { ...character, conversationStyle: "chat" };
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      continuity,
    };
    return f;
  }
  const execute = (f: ReturnType<typeof fixture>) =>
    executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });

  it.each([
    { warmth: 0, intimacy: 0, love: 0 },
    { warmth: 50, intimacy: 20, love: 70 },
    { warmth: 100, intimacy: 100, love: 100 },
  ])("passes saved relationship state %j as dialogue guidance", async (relationshipState) => {
    const f = chatFixture();
    f.thread.roleplayState = {
      ...roleplayStoryState(f.thread.roleplayState, {
        threadId: "story",
        botId: "aria",
        historyGeneration: 0,
      }),
      continuity: { ...continuity, relationshipState },
    };
    await execute(f);
    expect(visibleRequests(f)[0]!.purpose).toBe("dialogue");
    expect(visibleRequests(f)[0]!.instructions).toContain(
      buildRoleplayRelationshipContext(relationshipState),
    );
    expect(f.thread.roleplayState).toMatchObject({
      continuity: { relationshipState },
    });
  });

  it("retains saved maximum scores when a valid continuity extraction omits them", async () => {
    const f = chatFixture();
    const relationshipState = { warmth: 100, intimacy: 100, love: 100 };
    f.thread.roleplayState = {
      ...roleplayStoryState(f.thread.roleplayState, {
        threadId: "story",
        botId: "aria",
        historyGeneration: 0,
      }),
      continuity: { ...continuity, relationshipState },
    };
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      yield {
        type: "done" as const,
        text: request.purpose === "continuity" ? JSON.stringify(continuity) : "Onward.",
      };
    });
    await execute(f);
    expect(visibleRequests(f)[0]!.instructions).toContain(
      buildRoleplayRelationshipContext(relationshipState),
    );
    expect(f.thread.roleplayState).toMatchObject({
      continuity: { relationshipState },
    });
  });

  it("keeps the prior snapshot when adding retained scores would exceed the byte limit", async () => {
    const f = chatFixture();
    const relationshipState = { warmth: 100, intimacy: 100, love: 100 };
    f.thread.roleplayState = {
      ...roleplayStoryState(f.thread.roleplayState, {
        threadId: "story",
        botId: "aria",
        historyGeneration: 0,
      }),
      continuity: { ...continuity, relationshipState },
    };
    const extracted = {
      scene: "x".repeat(800),
      relationship: "x".repeat(800),
      sharedDetails: Array<string>(12).fill("x".repeat(400)),
      openThreads: Array<string>(8).fill("x".repeat(400)),
      callbacks: Array<string>(8).fill("x".repeat(400)),
    };
    let extraBytes = 16_360 - new TextEncoder().encode(JSON.stringify(extracted)).length;
    for (let index = 0; extraBytes > 0; index++) {
      const count = Math.min(extraBytes, 400);
      extracted.sharedDetails[index] = "é".repeat(count) + "x".repeat(400 - count);
      extraBytes -= count;
    }
    expect(RoleplayContinuitySchema.safeParse(extracted).success).toBe(true);
    expect(RoleplayContinuitySchema.safeParse({ ...extracted, relationshipState }).success).toBe(
      false,
    );
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      yield {
        type: "done" as const,
        text: request.purpose === "continuity" ? JSON.stringify(extracted) : "Onward.",
      };
    });
    await execute(f);
    expect(f.run.status).toBe("completed");
    expect(f.thread.roleplayState).toMatchObject({
      continuity: { ...continuity, relationshipState },
    });
    const restored = roleplayStoryState(JSON.parse(JSON.stringify(f.thread.roleplayState)), {
      threadId: "story",
      botId: "aria",
      historyGeneration: 0,
    });
    expect(restored.continuity?.relationshipState).toEqual(relationshipState);
  });

  it("includes saved relationship guidance in narrative mode without injecting old chat facts", async () => {
    const f = chatFixture();
    const relationshipState = { warmth: 100, intimacy: 100, love: 100 };
    f.bot.roleplayCharacter = { ...character, conversationStyle: "narrative" };
    f.thread.roleplayState = {
      ...roleplayStoryState(f.thread.roleplayState, {
        threadId: "story",
        botId: "aria",
        historyGeneration: 0,
      }),
      continuity: { ...continuity, relationshipState },
    };
    await execute(f);
    expect(visibleRequests(f).map((request) => request.purpose)).toEqual(["dialogue"]);
    expect(visibleRequests(f)[0]!.instructions).toContain(
      buildRoleplayRelationshipContext(relationshipState),
    );
    expect(visibleRequests(f)[0]!.instructions).not.toContain(JSON.stringify(continuity));
  });

  it("commits three real chat bubbles with a redacted, scoped continuity snapshot", async () => {
    const f = chatFixture();
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      const text =
        request.purpose === "continuity"
          ? JSON.stringify({
              ...continuity,
              scene: "The path ahead",
              sharedDetails: ["fake-model-secret"],
            })
          : "I found it.\n\nLook here.\n\nBring the lantern.\n\nCareful now.";
      yield { type: "text" as const, text };
      yield { type: "done" as const, text };
    });
    await execute(f);
    expect(visibleRequests(f).map((request) => request.purpose)).toEqual([
      "dialogue",
      "continuity",
    ]);
    expect(visibleRequests(f)[0]!.instructions).toContain(continuity.scene);
    const extracted = visibleRequests(f)[1]!;
    expect(extracted.model.maxTokens).toBe(2048);
    expect(extracted.history).toEqual([]);
    const data = JSON.parse(extracted.prompt);
    expect(data.priorContinuity).toEqual(continuity);
    expect(data.recentMessages.slice(-2).map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(extracted.prompt).not.toContain("OTHER BOT SECRET");
    expect(extracted.prompt).not.toContain("UNCLAIMED FUTURE INPUT");
    expect(f.finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "I found it." }],
        additionalMessages: [
          [{ kind: "text", text: "Look here." }],
          [{ kind: "text", text: "Bring the lantern.\n\nCareful now." }],
        ],
        roleplayState: expect.objectContaining({
          continuity: {
            ...continuity,
            scene: "The path ahead",
            sharedDetails: ["[redacted]"],
            relationshipState: { warmth: 10, intimacy: 0, love: 0 },
          },
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(f.deps.events.append).mock.calls)).not.toContain(
      "sharedDetails",
    );
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each(["malformed", "provider error", "oversized"])(
    "keeps the successful reply and previous snapshot after %s extraction",
    async (failure) => {
      const f = chatFixture();
      f.runtime.run = vi.fn(async function* (request) {
        if (request.purpose === "direction") {
          yield { type: "done" as const, text: "{}" };
          return;
        }
        f.requests.push(request);
        if (request.purpose === "continuity" && failure === "provider error")
          throw new Error("Unavailable");
        const text =
          request.purpose !== "continuity"
            ? "Onward."
            : failure === "oversized"
              ? "x".repeat(20_000)
              : '{"scene":"partial"}';
        yield { type: "done" as const, text };
      });
      await execute(f);
      expect(f.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "completed",
          blocks: [{ kind: "text", text: "Onward." }],
          roleplayState: expect.objectContaining({ continuity }),
        }),
      );
    },
  );

  it("leaves narrative mode as one completion without injecting an older chat snapshot", async () => {
    const f = chatFixture();
    f.bot.roleplayCharacter = { ...character, conversationStyle: "narrative" };
    await execute(f);
    expect(visibleRequests(f).map((request) => request.purpose)).toEqual(["dialogue"]);
    expect(visibleRequests(f)[0]!.instructions).not.toContain(continuity.scene);
    expect(f.thread.roleplayState).toMatchObject({ continuity });
    expect(f.finalizeRun.mock.calls[0]![0]).not.toHaveProperty("additionalMessages");
  });

  it.each([
    { contextWindow: 16_384, maxTokens: 2048, expected: 2048 },
    { contextWindow: 16_384, maxTokens: undefined, expected: 4096 },
    { contextWindow: 8192, maxTokens: 4096, expected: 2730 },
    { contextWindow: 4096, maxTokens: 2048, expected: 1365 },
    { contextWindow: 8192, maxTokens: 512, expected: 512 },
  ])(
    "gives continuity $expected output tokens within model and context limits",
    async ({ contextWindow, maxTokens, expected }) => {
      const f = chatFixture();
      fake.resolveModel.mockResolvedValue({
        provider: "neutral",
        id: "fiction-model",
        contextWindow,
        maxTokens,
      });
      f.runtime.run = vi.fn(async function* (request) {
        if (request.purpose === "direction") {
          yield { type: "done" as const, text: "{}" };
          return;
        }
        f.requests.push(request);
        yield {
          type: "done" as const,
          text: request.purpose === "continuity" ? JSON.stringify(continuity) : "Onward.",
        };
      });
      await execute(f);
      expect(visibleRequests(f).map((request) => request.purpose)).toEqual([
        "dialogue",
        "continuity",
      ]);
      for (const request of visibleRequests(f)) {
        expect(request.model.maxTokens).toBe(expected);
        const input =
          roleplayTokens(request.instructions + request.prompt) +
          request.history.reduce((sum, message) => sum + roleplayTokens(message.content) + 8, 0) +
          32;
        expect(input + expected).toBeLessThanOrEqual(contextWindow);
      }
      expect(f.thread.roleplayState).toMatchObject({ continuity });
    },
  );

  it("saves continuity from a slower model without changing its reasoning preference", async () => {
    vi.useFakeTimers();
    const f = chatFixture();
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "reasoning-fiction-model",
      contextWindow: 16_384,
      maxTokens: 2048,
      thinkingLevel: "medium",
    });
    const updated = { ...continuity, scene: "By the stream" };
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let extractionSignal: AbortSignal | undefined;
    f.runtime.run = vi.fn(async function* (request, signal) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      if (request.purpose === "dialogue") {
        yield { type: "done" as const, text: "Onward." };
        return;
      }
      extractionSignal = signal;
      entered();
      await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
      signal.throwIfAborted();
      yield { type: "done" as const, text: JSON.stringify(updated) };
    });
    const running = execute(f);
    await ready;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(extractionSignal?.aborted).toBe(false);
    expect(f.finalizeRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(f.requests.at(-1)!.model.thinkingLevel).toBe("medium");
    expect(f.finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        roleplayState: expect.objectContaining({ continuity: expect.objectContaining(updated) }),
      }),
    );
  });

  it("times out a quiet extraction without delaying or failing the successful reply indefinitely", async () => {
    vi.useFakeTimers();
    const f = chatFixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let extractionSignal: AbortSignal | undefined;
    f.runtime.run = vi.fn(async function* (request, signal) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      if (request.purpose === "dialogue") {
        yield { type: "done" as const, text: "Onward." };
        return;
      }
      extractionSignal = signal;
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    });
    const running = execute(f);
    await ready;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(extractionSignal?.aborted).toBe(false);
    expect(f.finalizeRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(extractionSignal?.aborted).toBe(true);
    expect(f.finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "completed",
        roleplayState: expect.objectContaining({ continuity }),
      }),
    );
  });

  it.each(["cancel", "lease"])(
    "never finalizes a successful reply after %s loss during extraction",
    async (loss) => {
      const f = chatFixture();
      const controller = new AbortController();
      f.deps.shutdownSignal = controller.signal;
      f.runtime.run = vi.fn(async function* (request) {
        if (request.purpose === "direction") {
          yield { type: "done" as const, text: "{}" };
          return;
        }
        if (request.purpose === "continuity") {
          if (loss === "cancel") controller.abort();
          else {
            f.run.leaseFence = 2;
            f.run.leaseOwner = "replacement";
          }
        }
        yield {
          type: "done" as const,
          text: request.purpose === "continuity" ? JSON.stringify(continuity) : "Onward.",
        };
      });
      const before = f.thread.roleplayState;
      await execute(f);
      expect(f.finalizeRun).not.toHaveBeenCalled();
      expect(f.thread.roleplayState).toBe(before);
    },
  );

  it("keeps continuity through compaction and fits every request inside the model budget", async () => {
    const f = chatFixture();
    f.rows.splice(
      0,
      f.rows.length,
      ...Array.from({ length: 60 }, (_, seq) => ({
        seq,
        threadId: "story",
        role: seq % 2 ? "user" : "bot",
        botId: "aria",
        blocks: [{ kind: "text", text: `Scene ${seq}: ${"ancient map ".repeat(120)}` }],
        createdAt: new Date("2026-10-27T12:00:00Z"),
      })),
    );
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 8192,
      maxTokens: 1024,
    });
    await execute(f);
    expect(f.requests.some((request) => request.purpose === "memory")).toBe(true);
    expect(f.requests.at(-1)!.purpose).toBe("continuity");
    const dialogue = f.requests.find((request) => request.purpose === "dialogue")!;
    expect(dialogue.instructions).toContain(continuity.scene);
    expect(f.thread.roleplayState).toMatchObject({ continuity, summary: "Scoped story memory." });
    for (const request of visibleRequests(f)) {
      const input =
        roleplayTokens(request.instructions + request.prompt) +
        request.history.reduce((sum, message) => sum + roleplayTokens(message.content) + 8, 0) +
        32;
      expect(input + request.model.maxTokens!).toBeLessThanOrEqual(8192);
    }
  });

  it.each([
    { contextWindow: 4096, scores: true },
    { contextWindow: 3072, scores: false },
  ])(
    "bounds the prompt copy after switching to a $contextWindow-token model (scores: $scores) and preserves the full snapshot",
    async ({ contextWindow, scores }) => {
      const f = chatFixture();
      const large = {
        ...(scores ? { relationshipState: { warmth: 100, intimacy: 0, love: 50 } } : {}),
        scene: "scene ".repeat(133),
        relationship: "relationship ".repeat(61),
        sharedDetails: Array(12).fill("detail ".repeat(57)),
        openThreads: Array(8).fill("thread ".repeat(57)),
        callbacks: Array(8).fill("callback ".repeat(44)),
      };
      f.thread.roleplayState = {
        ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
        continuity: large,
      };
      fake.resolveModel.mockResolvedValue({
        provider: "neutral",
        id: "small-fiction-model",
        contextWindow,
        maxTokens: 2048,
      });
      await execute(f);
      expect(f.run.status).toBe("completed");
      expect(visibleRequests(f)[0]!.purpose).toBe("dialogue");
      if (large.relationshipState)
        expect(visibleRequests(f)[0]!.instructions).toContain(
          buildRoleplayRelationshipContext(large.relationshipState),
        );
      expect(visibleRequests(f)[0]!.instructions).not.toContain(JSON.stringify(large));
      expect(f.thread.roleplayState).toMatchObject({ continuity: large });
      for (const request of visibleRequests(f)) {
        const cost =
          roleplayTokens(request.instructions + request.prompt) +
          request.history.reduce((sum, message) => sum + roleplayTokens(message.content) + 8, 0) +
          32;
        expect(cost + request.model.maxTokens!).toBeLessThanOrEqual(contextWindow);
      }
    },
  );

  it.each([4096, 3072])(
    "still updates an oversized prior snapshot after switching to a %i-token model",
    async (contextWindow) => {
      const f = chatFixture();
      const large = {
        scene: "scene ".repeat(133),
        relationship: "relationship ".repeat(61),
        sharedDetails: Array(12).fill("detail ".repeat(57)),
        openThreads: Array(8).fill("thread ".repeat(57)),
        callbacks: Array(8).fill("callback ".repeat(44)),
      };
      f.thread.roleplayState = {
        ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
        continuity: large,
      };
      fake.resolveModel.mockResolvedValue({
        provider: "neutral",
        id: "small-fiction-model",
        contextWindow,
        maxTokens: 2048,
      });
      const updated = { ...continuity, scene: "By the stream" };
      f.runtime.run = vi.fn(async function* (request) {
        if (request.purpose === "direction") {
          yield { type: "done" as const, text: "{}" };
          return;
        }
        f.requests.push(request);
        yield {
          type: "done" as const,
          text:
            request.purpose === "continuity" ? JSON.stringify(updated) : "We reached the stream.",
        };
      });
      await execute(f);
      const request = f.requests.find((request) => request.purpose === "continuity")!;
      expect(request).toBeDefined();
      expect(
        roleplayTokens(request.instructions + request.prompt) + request.model.maxTokens! + 32,
      ).toBeLessThanOrEqual(contextWindow);
      const prior = JSON.parse(request.prompt).priorContinuity;
      if (prior) {
        expect(["", large.scene]).toContain(prior.scene);
        expect(["", large.relationship]).toContain(prior.relationship);
        for (const field of ["sharedDetails", "openThreads", "callbacks"] as const)
          for (const value of prior[field]) expect(large[field]).toContain(value);
      }
      expect(f.thread.roleplayState).toMatchObject({ continuity: updated });
    },
  );

  it("polls persisted cancellation during a quiet extraction and commits neither reply nor snapshot", async () => {
    vi.useFakeTimers();
    const f = chatFixture();
    const before = f.thread.roleplayState;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let extractionSignal: AbortSignal | undefined;
    f.runtime.run = vi.fn(async function* (request, signal) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      if (request.purpose === "dialogue") {
        yield { type: "done" as const, text: "Onward." };
        return;
      }
      extractionSignal = signal;
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    });
    const running = execute(f);
    await ready;
    f.run.status = "cancelled";
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(extractionSignal?.aborted).toBe(true);
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.thread.roleplayState).toBe(before);
  });
});

describe("roleplay executor boundary", () => {
  it("branches from real run execution before normal agent context and operational tools", async () => {
    const f = fixture();
    f.run.status = "queued";
    f.run.leaseOwner = "";
    f.run.leaseFence = 0;
    const started = vi.fn();
    await createRunExecutor(f.deps).continueRun(f.run.id, "worker", started);
    expect(started).toHaveBeenCalledOnce();
    expect(f.run.status).toBe("completed");
    expect(fake.provision).toHaveBeenCalledOnce();
    expect(fake.notify).toHaveBeenCalledWith(
      f.deps,
      expect.anything(),
      expect.objectContaining({ kind: "completion", body: "Aria lifts the lantern." }),
    );
    expect(visibleRequests(f)).toHaveLength(1);
    expect(visibleRequests(f)[0]!.history.map((message) => message.content)).toEqual([
      "The gate opens.",
      "Earlier scene.",
      "We found a map.",
    ]);
    const sent = JSON.stringify(f.requests);
    for (const secret of [
      "GLOBAL AGENT SUMMARY",
      "OTHER BOT SECRET",
      "OTHER STORY SECRET",
      "SYSTEM ADMIN SECRET",
      "SECRET TOOL OUTPUT",
      "UNCLAIMED FUTURE INPUT",
    ])
      expect(sent).not.toContain(secret);
    expect(visibleRequests(f)[0]).not.toHaveProperty("tools");
    expect(visibleRequests(f)[0]).not.toHaveProperty("executeTool");
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.thread.roleplayState).toMatchObject({
      threadId: "story",
      botId: "aria",
      turnCount: 1,
      lastRunId: "turn",
    });
  });

  it("recovers an expired run in a replacement worker without loading normal agent context", async () => {
    const f = fixture();
    f.run.leaseOwner = "lost-worker";
    f.run.leaseExpiresAt = new Date(0) as unknown as null;
    await createRunExecutor(f.deps).continueRun(f.run.id, "worker");
    expect(f.run.status).toBe("completed");
    expect(f.run.leaseFence).toBe(2);
    expect(visibleRequests(f)).toHaveLength(1);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ leaseFence: 2, leaseOwner: "worker" }),
    );
  });

  it.each(["host", "native", "provider", "group", "messaging"])(
    "rejects invalid %s placement before provisioning or loading credentials",
    async (invalid) => {
      const f = fixture();
      if (invalid === "host") f.bot.executionTarget = "host";
      if (invalid === "native") f.bot.runtimeKind = "codex";
      if (invalid === "provider")
        vi.mocked(f.deps.sandbox.provisionKind!).mockResolvedValue("desktop");
      if (invalid === "group") f.thread.groupId = "group";
      if (invalid === "messaging") f.run.trigger = "messaging";
      await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
        workerId: "worker",
        fence: 1,
      });
      expect(f.run.status).toBe("failed");
      expect(fake.provision).not.toHaveBeenCalled();
      expect(fake.resolveModel).not.toHaveBeenCalled();
      expect(f.requests).toEqual([]);
      expect(f.forbidden).not.toHaveBeenCalled();
    },
  );

  it("fails closed before bootstrapping when roleplay is not enabled for the run owner", async () => {
    const f = fixture();
    f.user.roleplayEnabled = false;
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("failed");
    expect(fake.provision).not.toHaveBeenCalled();
    expect(f.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(fake.resolveModel).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("reads account changes for every turn without rebuilding the worker", async () => {
    const f = fixture();
    const execute = () =>
      executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
        workerId: "worker",
        fence: 1,
      });
    f.user.roleplayEnabled = false;
    await execute();
    expect(f.requests).toEqual([]);
    f.user.roleplayEnabled = true;
    f.run.status = "running";
    await execute();
    expect(visibleRequests(f)).toHaveLength(1);
    f.user.roleplayEnabled = false;
    f.run.status = "running";
    await execute();
    expect(f.run.status).toBe("failed");
    expect(visibleRequests(f)).toHaveLength(1);
  });

  it("never borrows another account's enabled preference", async () => {
    const f = fixture();
    f.run.userId = "other-owner";
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "other-owner" },
      select: { roleplayEnabled: true },
    });
    expect(f.run.status).toBe("failed");
    expect(fake.provision).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("requeues a busy Docker computer and releases this attempt instead of failing the story", async () => {
    const f = fixture();
    fake.provision.mockRejectedValue(new ComputerBusyError());
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("queued");
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.prisma.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "setup_failed" }) }),
    );
    expect(
      vi.mocked(f.deps.jobs.enqueue).mock.calls.filter(([job]) => job.name === "run.continue"),
    ).toHaveLength(1);
    expect(f.requests).toEqual([]);
  });

  it("refuses a provider returning a host computer even after Docker routing", async () => {
    const f = fixture();
    fake.provision.mockResolvedValue({ kind: "desktop", executionTarget: "host" });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("failed");
    expect(fake.resolveModel).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("keeps narrative memory across restart while resetting for another story or history generation", async () => {
    for (const reset of [false, "story", "generation"] as const) {
      const f = fixture();
      f.thread.roleplayState = {
        ...roleplayStoryState(null, {
          threadId: reset === "story" ? "other" : "story",
          botId: "aria",
          historyGeneration: reset === "generation" ? 2 : 0,
        }),
        summary: "Earlier trusted story memory.",
        summarizedUpToSeq: 1,
        turnCount: 4,
      };
      await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
        workerId: "worker",
        fence: 1,
      });
      expect(visibleRequests(f)[0]!.instructions.includes("Earlier trusted story memory.")).toBe(
        !reset,
      );
      expect(visibleRequests(f)[0]!.history.length).toBe(reset ? 3 : 1);
      expect(f.thread.roleplayState).toMatchObject({ turnCount: reset ? 1 : 5 });
    }
  });

  it("summarizes older scoped dialogue in bounded batches and saves memory with final reply", async () => {
    const f = fixture();
    f.rows.splice(
      0,
      f.rows.length,
      ...Array.from({ length: 60 }, (_, seq) => ({
        seq,
        threadId: "story",
        role: seq % 2 ? "user" : "bot",
        botId: "aria",
        blocks: [{ kind: "text", text: `Scene ${seq}: ${"ancient map ".repeat(120)}` }],
        createdAt: new Date("2026-10-27T12:00:00Z"),
      })),
    );
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 8192,
      maxTokens: 1024,
    });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    const summaries = f.requests.filter((request) => request.purpose === "memory");
    expect(summaries.length).toBeGreaterThan(1);
    expect(f.requests.at(-1)!.purpose).toBe("dialogue");
    for (const request of visibleRequests(f))
      expect(
        roleplayTokens(
          request.instructions +
            request.prompt +
            request.history.map((message) => message.content).join(""),
        ),
      ).toBeLessThan(8192 - 1024);
    expect(f.thread.roleplayState).toMatchObject({ summary: "Scoped story memory.", turnCount: 1 });
    expect(
      (f.thread.roleplayState as { summarizedUpToSeq: number }).summarizedUpToSeq,
    ).toBeGreaterThan(0);
    expect(f.requests.at(-1)!.instructions).toContain("Scoped story memory.");
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("does not commit memory or a reply after a replacement worker takes the lease", async () => {
    const f = fixture();
    f.runtime.run = vi.fn(async function* () {
      yield { type: "text" as const, text: "A partial scene" };
      f.run.leaseFence = 2;
      f.run.leaseOwner = "replacement";
      yield { type: "done" as const, text: "A partial scene" };
    });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.thread.roleplayState).toBeNull();
  });

  it("answers a direct follow-up from source text without requiring queued steering", async () => {
    const f = fixture();
    f.run.trigger = "follow_up";
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    expect(visibleRequests(f)[0]!.prompt).toBe("I follow the map.");
    expect(f.deps.events.claimSteering).toHaveBeenCalledOnce();
  });

  it("answers a second message queued during a slow turn once, with the preceding answer in history", async () => {
    const f = fixture();
    const requests: RoleplayRunRequest[] = [];
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.rows.push({
      seq: 99,
      threadId: "story",
      role: "user",
      botId: null,
      blocks: [{ kind: "text", text: "I follow the map." }],
    });
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      requests.push(request);
      if (requests.length === 1) {
        enter();
        await held;
      }
      const text =
        requests.length === 1 ? "The map reveals a hidden passage." : "Aria walks beside you.";
      yield { type: "text" as const, text };
      yield { type: "done" as const, text };
    });
    f.finalizeRun.mockImplementation(async (input) => {
      if (f.run.status !== "running" || f.run.leaseFence !== input.leaseFence) return false;
      f.run.status = input.outcome;
      f.thread.roleplayState = input.roleplayState;
      f.rows.push({
        seq: f.thread.nextMessageSeq++,
        threadId: "story",
        role: "bot",
        botId: "aria",
        blocks: input.blocks,
      });
      return { continuationRunId: requests.length === 1 ? "second-turn" : null };
    });
    const first = executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    await entered;
    // This arrives after the model input was captured, so it belongs to the next turn.
    f.rows.push({
      seq: 100,
      threadId: "story",
      role: "user",
      botId: null,
      blocks: [{ kind: "text", text: "I step into the passage." }],
    });
    f.thread.nextMessageSeq = 101;
    release();
    await first;
    expect(requests[0]!.prompt).toBe("I follow the map.");
    expect(f.deps.events.claimSteering).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.deps.jobs.enqueue).mock.calls.filter(([job]) => job.name === "run.continue"),
    ).toHaveLength(1);
    Object.assign(f.run, {
      id: "second-turn",
      trigger: "follow_up",
      status: "running",
      leaseOwner: "worker",
      leaseFence: 2,
      sourceMessageId: "queued-user",
    });
    f.prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: "task",
      botId: "aria",
      threadId: "story",
      spaceId: "space",
      prompt: STEERING_CONTINUATION_PROMPT,
    });
    f.prisma.message.findFirst.mockResolvedValue({
      seq: 100,
      blocks: [{ kind: "text", text: "I step into the passage." }],
    });
    const originalFindMany = f.prisma.message.findMany.getMockImplementation()!;
    f.prisma.message.findMany.mockImplementation(async (args) =>
      args.where.id
        ? [
            {
              seq: 100,
              role: "user",
              botId: null,
              threadId: "story",
              blocks: [{ kind: "text", text: "I step into the passage." }],
            },
          ]
        : originalFindMany(args),
    );
    vi.mocked(f.deps.events.claimSteering).mockResolvedValue([
      {
        id: "steering",
        messageId: "queued-user",
        origin: "user",
        text: "unused generic text",
        blocks: [{ kind: "text", text: "I step into the passage." }],
      },
    ]);
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 2,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toBe("I step into the passage.");
    expect(requests[1]!.history.at(-1)!.content).toBe("The map reveals a hidden passage.");
    expect(requests[1]!.history.map((message) => message.content)).not.toContain(
      "I step into the passage.",
    );
    expect(f.deps.events.claimSteering).toHaveBeenCalledOnce();
    expect(f.thread.roleplayState).toMatchObject({ turnCount: 2, lastRunId: "second-turn" });
    expect(
      vi.mocked(f.deps.jobs.enqueue).mock.calls.filter(([job]) => job.name === "run.continue"),
    ).toHaveLength(1);
  });

  it("compacts a preceding long answer while retaining the queued player input for the next turn", async () => {
    const f = fixture();
    f.run.trigger = "follow_up";
    f.bot.roleplayCharacter = { ...character, description: "Character fact. ".repeat(500) };
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 8192,
      maxTokens: 2048,
    });
    f.rows.push({
      seq: 100,
      threadId: "story",
      role: "bot",
      botId: "aria",
      blocks: [{ kind: "text", text: "Earlier answer. ".repeat(500) }],
    });
    vi.mocked(f.deps.events.claimSteering).mockResolvedValue([
      {
        id: "queued",
        messageId: "source",
        origin: "user",
        text: "",
        blocks: [{ kind: "text", text: "I follow the map." }],
      },
    ]);
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    expect(f.requests.some((request) => request.purpose === "memory")).toBe(true);
    expect(f.thread.roleplayState).toMatchObject({
      summarizedUpToSeq: 100,
      retainedInputs: [{ seq: 99, role: "user", content: "I follow the map." }],
    });
    // Recreate the executor after a restart; the player turn was older than the summary watermark.
    f.requests.splice(0);
    f.run.status = "running";
    f.run.trigger = "user";
    f.rows.push({
      seq: 101,
      threadId: "story",
      role: "bot",
      botId: "aria",
      blocks: [{ kind: "text", text: "Aria lifts the lantern." }],
    });
    f.prisma.message.findFirst.mockResolvedValue({
      seq: 102,
      blocks: [{ kind: "text", text: "I continue." }],
    });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    expect(f.requests.at(-1)!.history.map((message) => message.content)).toEqual([
      "I follow the map.",
      "Aria lifts the lantern.",
    ]);
  });

  it.each(["image", "file"])(
    "rejects text plus %s input instead of silently ignoring attachments",
    async (kind) => {
      const f = fixture();
      const attachment = {
        kind,
        artifactId: "attachment",
        text: "",
        mimeType: "image/png",
        name: "scene",
      };
      f.prisma.message.findFirst.mockResolvedValue({
        seq: 99,
        blocks: [{ kind: "text", text: "Use this scene." }, attachment],
      });
      await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
        workerId: "worker",
        fence: 1,
      });
      expect(visibleRequests(f)).toHaveLength(0);
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: "Roleplay supports text messages only",
        }),
      );
      expect(f.thread.roleplayState).toBeNull();
    },
  );

  it("redacts resolved model credentials from failures", async () => {
    const f = fixture();
    f.runtime.run = vi.fn(async function* () {
      yield { type: "text" as const, text: "" };
      throw new Error("Provider rejected fake-model-secret");
    });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: "Provider rejected [redacted]" }),
    );
    expect(fake.notify).toHaveBeenCalledWith(
      f.deps,
      expect.anything(),
      expect.objectContaining({ kind: "failure", body: "Provider rejected [redacted]" }),
    );
  });

  it("polls persisted cancellation to abort quiet model work without committing story state", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let modelSignal: AbortSignal | undefined;
    f.runtime.run = vi.fn(async function* (_request, signal) {
      modelSignal = signal;
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    });
    const running = executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    await ready;
    f.run.status = "cancelled";
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(modelSignal?.aborted).toBe(true);
    expect(f.finalizeRun).not.toHaveBeenCalled();
    expect(f.thread.roleplayState).toBeNull();
    expect(fake.release).toHaveBeenCalled();
  });
});

describe("spontaneous roleplay execution", () => {
  const guard = {
    historyGeneration: 0,
    nextMessageSeq: 101,
    character: "hash",
    timezone: "Europe/Lisbon",
    sourceMessageId: "source",
    botUpdatedAt: "revision",
    userUpdatedAt: "revision",
  };
  function spontaneousFixture() {
    const f = fixture();
    f.run.trigger = "roleplay_spontaneous";
    f.bot.roleplayCharacter = {
      ...character,
      conversationStyle: "chat",
      spontaneous: { enabled: true, frequency: "balanced", allowLateNight: false },
    };
    f.prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: "task",
      botId: "aria",
      threadId: "story",
      spaceId: "space",
      prompt: JSON.stringify(guard),
    });
    fake.snapshot.mockReset().mockResolvedValue({ guard });
    return f;
  }
  const execute = (f: ReturnType<typeof fixture>) =>
    executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
  it.each([
    JSON.stringify({ decision: "skip" }),
    "malformed",
    JSON.stringify({ decision: "send", messages: [] }),
  ])("keeps decision %s invisible and records a completed attempt", async (decision) => {
    const f = spontaneousFixture();
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      yield { type: "text" as const, text: decision };
      yield { type: "done" as const, text: decision };
    });
    await execute(f);
    expect(visibleRequests(f).map((request) => request.purpose)).toEqual(["spontaneous"]);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [], spontaneousGuard: guard }),
    );
    expect(f.finalizeRun.mock.calls[0]![0]).not.toHaveProperty("roleplayState");
    expect(vi.mocked(f.deps.events.append).mock.calls.map(([event]) => event.type)).toEqual([
      "run.started",
    ]);
    expect(fake.notify).not.toHaveBeenCalled();
  });
  it("accepts max-three redacted bubbles, marks unread, and cannot increase relationship scores", async () => {
    const f = spontaneousFixture();
    const relationshipState = { warmth: 50, intimacy: 20, love: 10 };
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      continuity: { ...continuity, relationshipState },
    };
    f.runtime.run = vi.fn(async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      const text =
        request.purpose === "spontaneous"
          ? JSON.stringify({
              decision: "send",
              messages: ["Hi", "fake-model-secret", "How did it go?"],
            })
          : JSON.stringify({
              ...continuity,
              relationshipState: { warmth: 100, intimacy: 100, love: 100 },
            });
      yield { type: "text" as const, text };
      yield { type: "done" as const, text };
    });
    await execute(f);
    expect(visibleRequests(f).map((request) => request.purpose)).toEqual([
      "spontaneous",
      "continuity",
    ]);
    expect(visibleRequests(f)[0]!.instructions).toContain(
      buildRoleplayRelationshipContext(relationshipState),
    );
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [{ kind: "text", text: "Hi" }],
        additionalMessages: [
          [{ kind: "text", text: "[redacted]" }],
          [{ kind: "text", text: "How did it go?" }],
        ],
        markUnread: true,
        roleplayState: expect.objectContaining({
          continuity: expect.objectContaining({ relationshipState }),
        }),
      }),
    );
    expect(vi.mocked(f.deps.events.append).mock.calls.map(([event]) => event.type)).toEqual([
      "run.started",
    ]);
    expect(fake.notify).toHaveBeenCalledOnce();
  });
  it("skips changed eligibility before provisioning or model credentials", async () => {
    const f = spontaneousFixture();
    fake.snapshot.mockResolvedValue(null);
    await execute(f);
    expect(fake.provision).not.toHaveBeenCalled();
    expect(fake.resolveModel).not.toHaveBeenCalled();
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: [], outcome: "completed" }),
    );
  });
  it("does not notify for an atomic-finalization rejection after model completion", async () => {
    const f = spontaneousFixture();
    f.runtime.run = vi.fn(async function* () {
      yield { type: "done" as const, text: JSON.stringify({ decision: "send", messages: ["Hi"] }) };
    });
    f.finalizeRun.mockResolvedValue({ continuationRunId: null, suppressed: true } as never);
    await execute(f);
    expect(fake.notify).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.deps.events.append)
        .mock.calls.some(([event]) => event.type === "thread.progress"),
    ).toBe(false);
  });
  it("silently finishes provider failures and enqueues real user continuations", async () => {
    const f = spontaneousFixture();
    f.runtime.run = vi.fn(async function* () {
      yield { type: "text" as const, text: "private decision fragment" };
      throw new Error("provider private detail");
    });
    f.finalizeRun.mockResolvedValue({ continuationRunId: "real-user-turn" });
    await execute(f);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [] }),
    );
    expect(JSON.stringify(f.finalizeRun.mock.calls)).not.toContain("provider private detail");
    expect(f.deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { runId: "real-user-turn" } }),
    );
    expect(fake.notify).not.toHaveBeenCalled();
  });
});

it("grounds a returning user's gap in the prior interaction and preserves input timestamps", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  const f = fixture();
  const prior = new Date("2026-10-26T18:00:00Z");
  const current = new Date("2026-10-29T11:59:59Z");
  f.prisma.message.findFirst.mockImplementation(async (args) => ({
    seq: 99,
    blocks: [{ kind: "text", text: "Tomorrow I am leaving." }],
    createdAt: args.where.seq ? prior : current,
  }));
  await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
    workerId: "worker",
    fence: 1,
  });
  expect(visibleRequests(f)[0]?.instructions).toContain(
    `"lastInteractionAt":"${prior.toISOString()}"`,
  );
  expect(visibleRequests(f)[0]?.instructions).toContain('"elapsedMilliseconds":237600000');
  expect(visibleRequests(f)[0]?.prompt).toBe("Tomorrow I am leaving.");
  expect(visibleRequests(f)[0]?.instructions).toContain(
    `"currentInputs":[{"position":1,"seq":99,"role":"user","createdAt":"${current.toISOString()}"}]`,
  );
});

it("never publishes or persists a generated legacy timestamp wrapper, including split deltas", async () => {
  const f = fixture();
  const wrapper = "[Message createdAt: 2026-10-29T09:59:32.797Z]";
  f.runtime.run = async function* () {
    for (const text of [
      "Hello. ",
      "[Message cre",
      "atedAt: 2026-10-29T",
      "09:59:32.797Z]",
      " Welcome.",
    ]) {
      yield { type: "text", text };
    }
    yield { type: "done", text: `Final. ${wrapper} Welcome.` };
  };
  await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
    workerId: "worker",
    fence: 1,
  });
  const progress = vi
    .mocked(f.deps.events.append)
    .mock.calls.map(([event]) => event)
    .filter((event) => event.type === "thread.progress");
  const published = progress
    .map((event) => event.payload.text ?? event.payload.delta ?? "")
    .join("");
  expect(published).toBe("Hello.  Welcome.");
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "completed",
      blocks: [{ kind: "text", text: "Final.  Welcome." }],
    }),
  );
});

describe("roleplay scheduled routine delivery", () => {
  it("delivers the saved prompt with latest history without a synthetic user turn", async () => {
    const f = fixture();
    f.run.trigger = "routine";
    Object.assign(f.run, { sourceMessageId: null, routineId: "reminder" });
    f.prisma.message.findFirst.mockResolvedValue(null as never);
    f.prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: "task",
      botId: "aria",
      threadId: "story",
      spaceId: "space",
      prompt: "Check in about our conversation after 45 minutes.",
    });
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    const request = visibleRequests(f)[0]!;
    expect(request.purpose).toBe("routine");
    expect(request.prompt).toBe("Check in about our conversation after 45 minutes.");
    expect(request.history.some((message) => message.content === "UNCLAIMED FUTURE INPUT")).toBe(
      true,
    );
    expect(request.history.some((message) => message.content.includes("SECRET"))).toBe(false);
    expect(request.scheduling?.tools.map((tool) => tool.name)).toEqual([
      "schedule_list",
      "schedule_cancel",
    ]);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ markUnread: true, outcome: "completed" }),
    );
    expect(f.thread.roleplayState).toMatchObject({ retainedInputs: [] });
    expect(f.prisma.message.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: "user" }) }),
    );
  });

  it("does not increase relationship scores on a scheduled turn", async () => {
    const f = fixture();
    f.run.trigger = "routine";
    Object.assign(f.run, { sourceMessageId: null, routineId: "reminder" });
    f.bot.roleplayCharacter = { ...character, conversationStyle: "chat" };
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      continuity: { ...continuity, relationshipState: { warmth: 20, intimacy: 10, love: 0 } },
    };
    f.runtime.run = async function* (request) {
      if (request.purpose === "direction") {
        yield { type: "done" as const, text: "{}" };
        return;
      }
      f.requests.push(request);
      const text =
        request.purpose === "continuity"
          ? JSON.stringify({
              ...continuity,
              relationshipState: { warmth: 90, intimacy: 90, love: 90 },
            })
          : "How did it go?";
      yield { type: "done", text };
    };
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(f.run.status).toBe("completed");
    expect(f.thread.roleplayState).toMatchObject({
      continuity: { relationshipState: { warmth: 20, intimacy: 10, love: 0 } },
    });
    expect(
      f.requests.find((request) => request.purpose === "continuity")?.scheduling,
    ).toBeUndefined();
  });

  it("makes scheduling available only to the dialogue completion", async () => {
    const f = fixture();
    f.bot.roleplayCharacter = { ...character, conversationStyle: "chat" };
    await executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
    expect(visibleRequests(f)[0]?.scheduling?.tools.map((tool) => tool.name)).toEqual([
      "schedule_create",
      "schedule_list",
      "schedule_update",
      "schedule_cancel",
    ]);
    expect(
      f.requests.find((request) => request.purpose === "continuity")?.scheduling,
    ).toBeUndefined();
  });
});

describe("roleplay album execution", () => {
  const album = [
    {
      id: "forest",
      artifactId: "art-forest",
      description: "A friendly fox beside a forest gate",
      scene: "forest",
      enabled: true,
    },
  ];
  const media = {
    enabled: true,
    allowSpontaneous: true,
    normalIntervalTurns: 6,
    storyIntervalTurns: 2,
    album,
  };
  const direction = { storyMode: true, scene: "forest", imageId: "forest", imageRequested: false };
  const execute = (f: ReturnType<typeof fixture>) =>
    executeRoleplayRun(f.deps, f.runtime, f.run as unknown as Run, {
      workerId: "worker",
      fence: 1,
    });
  function mediaFixture(raw = JSON.stringify(direction)) {
    const f = fixture();
    f.bot.roleplayCharacter = { ...character, conversationStyle: "chat", media };
    f.runtime.run = vi.fn(async function* (request) {
      f.requests.push(request);
      const text =
        request.purpose === "direction"
          ? raw
          : request.purpose === "continuity"
            ? "{}"
            : "The fox waits by the gate.";
      yield { type: "text" as const, text };
      yield { type: "done" as const, text };
    });
    return f;
  }
  it.each([
    { contextWindow: 16_384, maxTokens: 2048, expected: 2048 },
    { contextWindow: 16_384, maxTokens: undefined, expected: 4096 },
    { contextWindow: 8192, maxTokens: 4096, expected: 2730 },
    { contextWindow: 4096, maxTokens: 2048, expected: 1365 },
    { contextWindow: 8192, maxTokens: 512, expected: 512 },
  ])(
    "gives hidden direction $expected completion tokens within model and context limits",
    async ({ contextWindow, maxTokens, expected }) => {
      const f = mediaFixture();
      fake.resolveModel.mockResolvedValue({
        provider: "neutral",
        id: "fiction-model",
        contextWindow,
        maxTokens,
        thinkingLevel: "medium",
      });
      await execute(f);
      const request = f.requests.find((request) => request.purpose === "direction")!;
      expect(request).toBeDefined();
      // Reasoning may consume the completion allowance before the control JSON.
      expect(request.model.maxTokens).toBe(expected);
      expect(request.model.thinkingLevel).toBe("medium");
      expect(
        roleplayTokens(request.instructions + request.prompt) + expected + 32 + 256,
      ).toBeLessThanOrEqual(contextWindow);
      expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
        outcome: "completed",
        blocks: [
          { kind: "text", text: "The fox waits by the gate." },
          { kind: "image", artifactId: "art-forest" },
        ],
        roleplayState: { media: { storyMode: true, scene: "forest" } },
      });
    },
  );
  it("trims catalog context while reserving the whole direction completion allowance", async () => {
    const f = mediaFixture();
    f.bot.roleplayCharacter = {
      ...character,
      conversationStyle: "chat",
      media: {
        ...media,
        album: [
          ...album,
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `extra-${index}`,
            artifactId: `art-extra-${index}`,
            description: "森".repeat(800),
            enabled: true,
          })),
        ],
      },
    };
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 4096,
      maxTokens: 2048,
    });
    await execute(f);
    const request = f.requests.find((request) => request.purpose === "direction")!;
    const catalog = JSON.parse(request.prompt).media.album;
    expect(catalog.length).toBeLessThan(7);
    expect(catalog[0].id).toBe("forest");
    expect(
      roleplayTokens(request.instructions + request.prompt) + request.model.maxTokens! + 32 + 256,
    ).toBeLessThanOrEqual(4096);
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      outcome: "completed",
      blocks: [
        { kind: "text", text: "The fox waits by the gate." },
        { kind: "image", artifactId: "art-forest" },
      ],
    });
  });
  it("fits a saved multibyte scene before rejecting a small model and preserves the durable scene", async () => {
    const f = fixture();
    const scene = "森".repeat(800);
    f.rows.splice(0);
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      media: {
        storyMode: true,
        scene,
        revision: 4,
        turn: 8,
        lastImageTurn: null,
        sentImageIds: [],
      },
    };
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 3072,
      maxTokens: 1024,
    });
    await execute(f);
    expect(f.run.status).toBe("completed");
    const dialogue = f.requests.find((request) => request.purpose === "dialogue")!;
    expect(dialogue).toBeDefined();
    expect(dialogue.instructions).not.toContain(scene);
    expect(f.thread.roleplayState).toMatchObject({
      media: { storyMode: true, scene, revision: 5, turn: 9 },
    });
    for (const request of f.requests) {
      const tokens =
        roleplayTokens(request.instructions + request.prompt) +
        request.history.reduce((sum, message) => sum + roleplayTokens(message.content) + 8, 0) +
        32;
      expect(tokens + request.model.maxTokens!).toBeLessThanOrEqual(3072);
    }
  });

  it("carries explicit repeat authorization only for a verified requested user attachment", async () => {
    const f = mediaFixture(JSON.stringify({ ...direction, imageRequested: true }));
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      media: {
        storyMode: true,
        scene: "forest",
        revision: 2,
        turn: 2,
        lastImageTurn: 2,
        sentImageIds: ["forest"],
      },
    };
    await execute(f);
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      roleplayMediaGuard: { imageRequested: true },
      roleplayState: { media: { lastImageTurn: 3, sentImageIds: ["forest"] } },
    });
    const missing = mediaFixture(JSON.stringify({ ...direction, imageRequested: true }));
    missing.prisma.artifact.findFirst.mockResolvedValue(null as never);
    await execute(missing);
    expect(missing.finalizeRun.mock.calls[0]![0].roleplayMediaGuard).not.toHaveProperty(
      "imageRequested",
    );
  });

  it("accepts natural story direction for a legacy card without an album", async () => {
    const f = mediaFixture(JSON.stringify({ ...direction, imageId: null }));
    f.bot.roleplayCharacter = { ...character, conversationStyle: "chat" };
    await execute(f);
    expect(f.requests[0]?.purpose).toBe("direction");
    expect(f.requests[1]?.instructions).toContain("Story mode is active");
    expect(f.thread.roleplayState).toMatchObject({
      media: { storyMode: true, scene: "forest", sentImageIds: [] },
    });
    expect(f.finalizeRun.mock.calls[0]![0].blocks).toHaveLength(1);
  });
  it("keeps direction hidden, delivers verified text and image together and persists scene/cadence", async () => {
    const f = mediaFixture();
    await execute(f);
    expect(f.requests.map((request) => request.purpose)).toEqual([
      "direction",
      "dialogue",
      "continuity",
    ]);
    expect(f.requests[0]?.scheduling).toBeUndefined();
    expect(f.requests[1]?.scheduling?.tools.length).toBe(4);
    expect(f.requests[1]?.instructions).toContain(album[0]!.description);
    expect(f.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          { kind: "text", text: "The fox waits by the gate." },
          {
            kind: "image",
            artifactId: "art-forest",
            mimeType: "image/png",
            name: "forest.png",
            description: album[0]!.description,
          },
        ],
        roleplayMediaGuard: {
          revision: 0,
          historyGeneration: 0,
          characterMedia: JSON.stringify(media),
        },
        roleplayState: expect.objectContaining({
          media: {
            storyMode: true,
            scene: "forest",
            revision: 1,
            turn: 1,
            lastImageTurn: 1,
            sentImageIds: ["forest"],
          },
        }),
      }),
    );
    expect(
      vi
        .mocked(f.deps.events.append)
        .mock.calls.some(([event]) => event.type === "thread.progress"),
    ).toBe(false);
    const continuityRequest = f.requests.find((request) => request.purpose === "continuity")!;
    expect(JSON.parse(continuityRequest.prompt).recentMessages.at(-1)).toMatchObject({
      content: "The fox waits by the gate.",
      image: { description: album[0]!.description },
    });
    expect(continuityRequest.prompt).not.toContain("[Shared image:");
  });
  it.each(["invented", "art-forest"])(
    "refuses a model-selected unavailable catalog ID %s",
    async (imageId) => {
      const f = mediaFixture(JSON.stringify({ ...direction, imageId }));
      await execute(f);
      expect(f.prisma.artifact.findFirst).not.toHaveBeenCalled();
      expect(f.requests[1]?.instructions).toContain("no image attachment");
      expect(f.finalizeRun.mock.calls[0]![0].blocks).toEqual([
        { kind: "text", text: "The fox waits by the gate." },
      ]);
    },
  );
  it("falls back safely after malformed direction and a missing owned artifact", async () => {
    const malformed = mediaFixture("control JSON fragment");
    await execute(malformed);
    expect(malformed.requests[1]?.instructions).toContain("no image attachment");
    expect(malformed.thread.roleplayState).toMatchObject({
      media: { storyMode: false, scene: "", sentImageIds: [] },
    });
    const missing = mediaFixture();
    missing.prisma.artifact.findFirst.mockResolvedValue(null as never);
    await execute(missing);
    expect(missing.requests[1]?.instructions).toContain("no image attachment");
    expect(missing.thread.roleplayState).toMatchObject({
      media: { storyMode: true, scene: "forest", lastImageTurn: null, sentImageIds: [] },
    });
  });
  it("reconstructs actual historical image descriptions and retains story cadence", async () => {
    const f = mediaFixture(JSON.stringify({ ...direction, imageId: null }));
    f.thread.roleplayState = {
      ...roleplayStoryState(null, { threadId: "story", botId: "aria", historyGeneration: 0 }),
      media: {
        storyMode: true,
        scene: "forest",
        revision: 4,
        turn: 8,
        lastImageTurn: 6,
        sentImageIds: ["forest"],
      },
    };
    f.rows[2]!.blocks.push({
      kind: "image",
      artifactId: "earlier-image",
      description: "The fox's old blue coat",
    } as never);
    await execute(f);
    const dialogue = f.requests.find((request) => request.purpose === "dialogue")!;
    expect(dialogue.history.find((message) => message.seq === 2)).toMatchObject({
      content: "We found a map.",
      image: { description: "The fox's old blue coat" },
    });
    expect(dialogue.instructions).toContain("The fox's old blue coat");
    expect(JSON.stringify(dialogue)).not.toContain("[Shared image:");
    expect(f.thread.roleplayState).toMatchObject({
      media: { revision: 5, turn: 9, lastImageTurn: 6, sentImageIds: ["forest"] },
    });
  });
  it("cleans exact legacy image echoes from assistant history and streamed replies without losing attachment facts", async () => {
    const f = mediaFixture();
    const description = album[0]!.description;
    const wrapper = `[Shared image: ${description}]`;
    f.rows[2]!.blocks.push({ kind: "text", text: wrapper }, {
      kind: "image",
      description,
    } as never);
    f.runtime.run = vi.fn(async function* (request) {
      f.requests.push(request);
      const text =
        request.purpose === "direction"
          ? JSON.stringify({ ...direction, imageId: null })
          : request.purpose === "continuity"
            ? "{}"
            : `The fox waits. ${wrapper}`;
      for (const chunk of text) yield { type: "text" as const, text: chunk };
      yield { type: "done" as const, text };
    });
    await execute(f);
    const dialogue = f.requests.find((request) => request.purpose === "dialogue")!;
    expect(dialogue.history.find((message) => message.seq === 2)).toMatchObject({
      content: "We found a map.\n",
      image: { description },
    });
    expect(f.finalizeRun.mock.calls[0]![0].blocks[0]).toEqual({
      kind: "text",
      text: "The fox waits.",
    });
    const continuityRequest = f.requests.find((request) => request.purpose === "continuity")!;
    const recent = JSON.parse(continuityRequest.prompt).recentMessages;
    expect(recent.at(-1)).toMatchObject({
      content: "The fox waits. ",
    });
    expect(recent.find((message: { seq: number }) => message.seq === 2)).toMatchObject({
      image: { description },
    });
    expect(
      vi
        .mocked(f.deps.events.append)
        .mock.calls.flatMap(([event]) =>
          event.type === "thread.progress" ? [event.payload.text ?? event.payload.delta ?? ""] : [],
        )
        .join(""),
    ).toBe("The fox waits. ");
    expect(JSON.stringify(dialogue)).not.toContain("[Shared image:");
    expect(continuityRequest.prompt).not.toContain("[Shared image:");
  });
  it("preserves a literal image wrapper quoted by the player", async () => {
    const f = mediaFixture();
    const wrapper = `[Shared image: ${album[0]!.description}]`;
    f.rows[1]!.blocks = [{ kind: "text", text: `Please quote ${wrapper}` }];
    f.runtime.run = vi.fn(async function* (request) {
      f.requests.push(request);
      yield {
        type: "done" as const,
        text:
          request.purpose === "direction"
            ? JSON.stringify(direction)
            : request.purpose === "continuity"
              ? "{}"
              : wrapper,
      };
    });
    await execute(f);
    expect(f.finalizeRun.mock.calls[0]![0].blocks[0]).toEqual({ kind: "text", text: wrapper });
  });
  it("preserves player-quoted wrappers after their message is compacted during the run", async () => {
    const f = mediaFixture();
    const description = album[0]!.description;
    const wrapper = `[Shared image: ${description}]`;
    f.rows.splice(
      0,
      f.rows.length,
      ...Array.from({ length: 40 }, (_, seq) => ({
        seq,
        threadId: "story",
        role: seq % 2 ? "user" : "bot",
        botId: "aria",
        blocks: [
          {
            kind: "text",
            text:
              seq === 1 ? `Please quote ${wrapper}` : `Scene ${seq}: ${"ancient map ".repeat(120)}`,
          },
          ...(seq === 0 ? [{ kind: "image", description } as never] : []),
        ],
      })),
    );
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 8192,
      maxTokens: 1024,
    });
    f.runtime.run = vi.fn(async function* (request) {
      f.requests.push(request);
      const text =
        request.purpose === "direction"
          ? JSON.stringify({ ...direction, imageId: null })
          : request.purpose === "memory"
            ? "A picture and a literal quotation were discussed."
            : request.purpose === "continuity"
              ? "{}"
              : wrapper;
      for (const chunk of text) yield { type: "text" as const, text: chunk };
      yield { type: "done" as const, text };
    });
    await execute(f);
    const excerpts = f.requests
      .filter((request) => request.purpose === "memory")
      .flatMap((request) => JSON.parse(request.prompt).olderStoryDialogue);
    expect(excerpts.find((message) => message.seq === 1)).toMatchObject({
      content: `Please quote ${wrapper}`,
    });
    expect(
      f.requests
        .find((request) => request.purpose === "dialogue")!
        .history.some((message) => message.seq === 1),
    ).toBe(false);
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      outcome: "completed",
      blocks: [{ kind: "text", text: wrapper }],
    });
    expect(
      vi
        .mocked(f.deps.events.append)
        .mock.calls.flatMap(([event]) =>
          event.type === "thread.progress" ? [event.payload.text ?? event.payload.delta ?? ""] : [],
        )
        .join(""),
    ).toBe(wrapper);
  });
  it("passes older image attachment metadata into bounded story compaction", async () => {
    const f = mediaFixture();
    f.rows.splice(
      0,
      f.rows.length,
      ...Array.from({ length: 40 }, (_, seq) => ({
        seq,
        threadId: "story",
        role: seq % 2 ? "user" : "bot",
        botId: "aria",
        blocks: [
          { kind: "text", text: `Scene ${seq}: ${"ancient map ".repeat(120)}` },
          ...(seq === 0
            ? [{ kind: "image", description: "The fox's old blue coat" } as never]
            : []),
        ],
      })),
    );
    fake.resolveModel.mockResolvedValue({
      provider: "neutral",
      id: "fiction-model",
      contextWindow: 8192,
      maxTokens: 1024,
    });
    await execute(f);
    const excerpts = f.requests
      .filter((request) => request.purpose === "memory")
      .flatMap((request) => JSON.parse(request.prompt).olderStoryDialogue);
    expect(excerpts.find((message) => message.seq === 0)).toMatchObject({
      image: { description: "The fox's old blue coat" },
    });
    expect(JSON.stringify(excerpts)).not.toContain("[Shared image:");
    expect(f.run.status).toBe("completed");
  });
  it.each([true, false])(
    "extends existing spontaneous decision with allowSpontaneous=%s",
    async (allowed) => {
      const f = mediaFixture();
      const guard = {
        historyGeneration: 0,
        nextMessageSeq: 101,
        character: "hash",
        timezone: "Europe/Lisbon",
        sourceMessageId: "source",
        botUpdatedAt: "revision",
        userUpdatedAt: "revision",
      };
      f.run.trigger = "roleplay_spontaneous";
      f.bot.roleplayCharacter = {
        ...character,
        conversationStyle: "chat",
        spontaneous: { enabled: true, frequency: "balanced", allowLateNight: false },
        media: { ...media, allowSpontaneous: allowed },
      };
      fake.snapshot.mockReset().mockResolvedValue({ guard });
      f.prisma.task.findUniqueOrThrow.mockResolvedValue({
        id: "task",
        botId: "aria",
        threadId: "story",
        spaceId: "space",
        prompt: JSON.stringify(guard),
      });
      f.runtime.run = vi.fn(async function* (request) {
        f.requests.push(request);
        yield {
          type: "done" as const,
          text:
            request.purpose === "spontaneous"
              ? JSON.stringify({
                  decision: "send",
                  messages: ["Here is our fox."],
                  imageId: "forest",
                })
              : "{}",
        };
      });
      await execute(f);
      expect(f.requests.some((request) => request.purpose === "direction")).toBe(false);
      expect(f.finalizeRun.mock.calls[0]![0].blocks).toHaveLength(allowed ? 2 : 0);
      expect(f.prisma.artifact.findFirst).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
});
