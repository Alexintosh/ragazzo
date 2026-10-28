import type { RoleplayCharacter } from "@rakazo/contracts";
import { roleplayStoryState, roleplayTokens, STEERING_CONTINUATION_PROMPT } from "@rakazo/core";
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
  const prisma = {
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
      findFirst: vi.fn(async () => ({
        seq: 99,
        blocks: [{ kind: "text", text: "I follow the map." }],
      })),
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
    connection: { findMany: forbidden },
    agentSecret: { findMany: forbidden },
    taughtSkill: { findMany: forbidden },
  };
  const deps = {
    prisma,
    roleplayEnabled: true,
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
  return { deps, run, thread, bot, rows, requests, runtime, forbidden, finalizeRun, prisma };
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
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.history.map((message) => message.content)).toEqual([
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
    expect(f.requests[0]).not.toHaveProperty("tools");
    expect(f.requests[0]).not.toHaveProperty("executeTool");
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
    expect(f.requests).toHaveLength(1);
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

  it("fails closed before bootstrapping when roleplay is not enabled on the worker", async () => {
    const f = fixture();
    f.deps.roleplayEnabled = false;
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
      expect(f.requests[0]!.instructions.includes("Earlier trusted story memory.")).toBe(!reset);
      expect(f.requests[0]!.history.length).toBe(reset ? 3 : 1);
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
    for (const request of f.requests)
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
    expect(f.requests[0]!.prompt).toBe("I follow the map.");
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
    vi.mocked(f.deps.events.claimSteering).mockResolvedValue([
      {
        id: "steering",
        messageId: "queued-user",
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
      expect(f.requests).toHaveLength(0);
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
