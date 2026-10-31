import type { AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError, SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { messagingChannelPrivacyBlock, messagingDmSurfaceNote } from "@rakazo/core";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTransport } from "./codex-runtime.js";
import { CodexAgentRuntime } from "./codex-runtime.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";
import { nativeContextScope } from "./native-context.js";
import * as runMessages from "./run-messages.js";

const sink = createTestSink();

const provisionComputer = vi.hoisted(() => vi.fn());

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/** A routine run whose model makes the given tool calls, then answers. */
async function runRoutine(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: {
    takeover?: boolean;
    ask?: boolean;
    inputPauseAccepted?: boolean;
    takeoverReleased?: boolean;
    native?: boolean;
    nativeUnavailable?: boolean;
    codingAgent?: boolean;
    graphical?: boolean;
    runtimeImages?: boolean;
    runId?: string;
    trigger?: string;
    channelId?: string;
    messagingIdentity?: boolean;
    nativeTransport?: CodexTransport;
    turnCheckpoint?: string;
    historySurfaces?: boolean;
    toolFailure?: "abort" | "recover";
    attachments?: "file" | "image";
    steering?: boolean;
    steeringAfterFirst?: boolean;
    copyFailureOnce?: boolean;
    parallel?: boolean;
    priorSetupFailures?: number;
    exportError?: Error;
    setupError?: Error;
    shutdownSignal?: AbortSignal;
    /** User stop already flipped the run to cancelled before the turn ends. */
    cancelRun?: boolean;
    onRunStarted?: () => void;
  } = {},
) {
  const attachment: Extract<MessageBlock, { kind: "file" | "image" }> = {
    kind: options.attachments ?? "file",
    artifactId: "artifact-1",
    name: "private-upload.png",
    mimeType: options.attachments === "image" ? "image/png" : "text/plain",
    size: 4,
  };
  const run = {
    id: options.runId ?? "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued" as string,
    trigger:
      options.trigger ??
      (options.channelId
        ? "messaging"
        : options.attachments && !options.steering
          ? "user"
          : "routine"),
    sourceMessageId:
      options.channelId || (options.attachments && !options.steering) ? "message-1" : null,
    routineId: "routine-1",
    retryOfRunId: null,
    leaseOwner: null as string | null,
    leaseFence: 0,
    leaseExpiresAt: null as Date | null,
    wakeAt: null as Date | null,
  };
  const historySurfaces = [
    {
      id: "private-old",
      seq: 1,
      role: "user",
      runId: "old-private",
      blocks: [{ kind: "text", text: "Denied private history" }],
    },
    ...["channel-a", "channel-b"].map((channelId, index) => ({
      id: `${channelId}-old`,
      seq: index + 2,
      role: "user",
      runId: `old-${channelId}`,
      blocks: [
        {
          kind: "channel_message",
          channelId,
          provider: "fake",
          fromAddress: "sender",
          fromLabel: "Sender",
          text: `${channelId} history`,
          hop: 0,
        },
      ],
    })),
  ];
  const toolResults: unknown[] = [];
  const steeringInputs: unknown[] = [];
  // A test-owned signal cannot be aborted mid-run, so the runtime fake trips this
  // relay; the executor still sees the option's signal through AbortSignal.any.
  const shutdownRelay = new AbortController();
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (options.nativeTransport) {
      yield* new CodexAgentRuntime(options.nativeTransport).run(request);
      return;
    }
    if (options.cancelRun) run.status = "cancelled";
    if (options.steering && !options.steeringAfterFirst) {
      steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
    }
    const execute = async (call: (typeof toolCalls)[number], index: number) => {
      try {
        toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
      } catch (error) {
        if (!options.toolFailure) throw error;
      }
      if (index === 0 && options.steeringAfterFirst) {
        steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
      }
      if (options.toolFailure === "abort") {
        // Shutdown lands while the tool call is in flight, so the runtime aborts.
        shutdownRelay.abort();
        throw new DOMException("Aborted", "AbortError");
      }
    };
    if (options.parallel) await Promise.all(toolCalls.map(execute));
    else for (const [index, call] of toolCalls.entries()) await execute(call, index);
    if (options.ask) {
      yield { type: "ask" as const, text: "Finish signing in using the browser preview." };
      return;
    }
    // Shutdown may land after the final tool without a runtime exception.
    shutdownRelay.abort();
    if (options.takeover) {
      yield { type: "takeover" as const, reason: "Sign in to the inbox." };
      return;
    }
    yield { type: "text-delta" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      // No other run of this bot waits for the computer.
      findFirst: vi.fn(async (args?: { where?: { status?: unknown } }) =>
        args?.where?.status === "queued"
          ? null
          : { bot: { notifyOnFinish: false }, thread: { groupId: null } },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: { status?: unknown; leaseOwner?: unknown; leaseFence?: unknown };
          data: Record<string, unknown>;
        }) => {
          // Honor the lease fence the executor uses to avoid releasing a run it no longer owns.
          if (typeof where?.status === "string" && where.status !== run.status) return { count: 0 };
          if (typeof where?.leaseOwner === "string" && where.leaseOwner !== run.leaseOwner)
            return { count: 0 };
          if (typeof where?.leaseFence === "number" && where.leaseFence !== run.leaseFence)
            return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        ...(options.codingAgent
          ? {
              runtimeKind: "codex",
              executionTarget: "host",
              runtimePermission: "workspace",
              projectPath: "/tmp/native-project",
            }
          : {}),
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: {
          id: "computer-1",
          scope: "dedicated",
          kind: options.native || options.codingAgent ? "desktop" : "e2b",
          homeKey: "home-1",
        },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () =>
        Array.from({ length: options.priorSetupFailures ?? 0 }, () => ({
          status: "setup_failed",
          error: "Run setup failed; retrying",
        })),
      ),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        historyCompactionGeneration: 0,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async (args) => {
        if (options.historySurfaces) {
          // Model the datastore's array_contains predicate so missing authorization
          // returns the denied private/other-channel sentinels to the real executor.
          const channel = args?.where?.OR?.find(
            (predicate: { role?: string }) => predicate.role === "user",
          )?.blocks?.array_contains?.[0]?.channelId;
          return historySurfaces
            .filter(
              (message) =>
                !channel ||
                message.blocks.some((block) => "channelId" in block && block.channelId === channel),
            )
            .sort((a, b) => b.seq - a.seq);
        }
        return options.attachments && !options.steering
          ? [
              {
                id: "message-1",
                role: "user",
                runId: run.id,
                seq: 1,
                blocks: [attachment],
              },
            ]
          : [];
      }),
      findUnique: vi.fn(async () =>
        options.channelId
          ? {
              blocks: [
                {
                  kind: "channel_message",
                  provider: "fake",
                  channelId: options.channelId,
                  fromAddress: "sender",
                  fromLabel: "Sender",
                  text: "Group request",
                  hop: 0,
                },
              ],
            }
          : null,
      ),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })),
      findFirst: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: run.id }]),
    $transaction: vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma),
    ),
    nativeExecutionReservation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ runId: run.id })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },

    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async (args) =>
        args?.where?.kind === "runtime_checkpoint" && options.turnCheckpoint
          ? [{ result: options.turnCheckpoint }]
          : [],
      ),
      upsert: vi.fn(async (_args: { create: { result: string } }) => ({})),
    },
    artifact: {
      findMany: vi.fn(async () =>
        options.attachments
          ? [
              {
                id: "artifact-1",
                storageKey: "private-storage-key",
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: 4,
              },
            ]
          : [],
      ),
    },
  };
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: options.graphical ?? false } }),
    ...(options.graphical
      ? {
          pageBrowser: vi.fn(async () => ({
            ok: true,
            url: "about:blank",
            title: "Fixture",
            tree: "",
            elements: [],
          })),
        }
      : {}),
    environment: options.native
      ? vi.fn(async () => {
          if (options.nativeUnavailable) throw new Error("native app is closed");
          return { platform: "win32", home: "C:\\Users\\example", shell: "powershell.exe" };
        })
      : undefined,
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield* [];
    }),
  };
  if (options.copyFailureOnce)
    sandbox.writeFile.mockRejectedValueOnce(new Error("temporary copy failure"));
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const events = {
    append: vi.fn(async () => undefined),
    claimSteering: vi.fn(async () => [
      { id: "steering-1", messageId: "message-2", text: "Look at this", blocks: [attachment] },
    ]),
    finalizeRun,
    pauseRunForInput: vi.fn(async () =>
      options.inputPauseAccepted === false ? null : { continuationRunId: null },
    ),
    pauseRunForTakeover: vi.fn(async () =>
      options.takeoverReleased ? { continuationRunId: run.id } : false,
    ),
  };
  const executorInput = {
    prisma: withEmptyModels(prisma),
    deploymentModelKey: options.codingAgent ? undefined : "fake-deployment-key",
    runtime: {
      describe: () => ({ capabilities: { scripted: false, images: options.runtimeImages } }),
      run: options.codingAgent
        ? vi.fn(() => {
            throw new Error("Pi must not run for Codex");
          })
        : runtimeRun,
    },
    ...(options.codingAgent
      ? {
          runtimes: {
            codex: {
              describe: () => ({
                capabilities: { scripted: false, images: options.runtimeImages ?? true },
              }),
              run: runtimeRun,
            },
          },
        }
      : {}),
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () => {
        if (options.setupError) throw options.setupError;
        return null;
      },
    },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events,
    jobs: { enqueue },
    messaging: { hasIdentity: async () => options.messagingIdentity ?? Boolean(options.channelId) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
    shutdownSignal: options.shutdownSignal
      ? AbortSignal.any([options.shutdownSignal, shutdownRelay.signal])
      : undefined,
  };
  const executor = createRunExecutor(
    executorInput as unknown as Parameters<typeof createRunExecutor>[0],
  );

  await executor.continueRun(
    run.id,
    "worker-1",
    options.onRunStarted
      ? () => {
          expect(run.status).toBe("running");
          options.onRunStarted!();
        }
      : undefined,
  );
  const sleepJobs = enqueue.mock.calls
    .map((call) => (call as unknown[])[0] as { name: string })
    .filter((job) => job.name === "computer.sleep");
  const resumeOnNextWorker = async () => {
    const resumedRuntime = vi.fn(async function* () {
      yield { type: "text-delta" as const, text: "Resumed." };
      yield { type: "done" as const, text: "Resumed." };
    });
    const resumedFinalize = vi.fn(async () => ({ continuationRunId: null }));
    const resumed = createRunExecutor({
      ...(executorInput as object),
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: resumedRuntime },
      events: { ...events, finalizeRun: resumedFinalize },
      shutdownSignal: undefined,
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await resumed.continueRun(run.id, "worker-2");
    return { runtimeRun: resumedRuntime, finalizeRun: resumedFinalize };
  };
  return {
    finalizeRun,
    sandbox,
    sleepJobs,
    toolResults,
    enqueue,
    runtimeRun,
    steeringInputs,
    prisma,
    run,
    resumeOnNextWorker,
  };
}

beforeEach(() => {
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
});

afterEach(() => {
  vi.clearAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("run computer provisioning", () => {
  it("carries server context authorization through the real native runtime, checkpoint and host contract", async () => {
    const calls: HostComputerRequest[] = [];
    const nativeTransport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(hostComputerRequest.parse(input));
        if (input.method === "codexRunContextScoped")
          yield { sequence: 1, event: { type: "done" } } as T;
      },
    };
    const capture = async (options: Parameters<typeof runRoutine>[1]) => {
      const fixture = await runRoutine([], {
        codingAgent: true,
        nativeTransport,
        historySurfaces: true,
        ...options,
      });
      expect(fixture.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      const request = fixture.runtimeRun.mock.calls[0]![0];
      const saved = fixture.prisma.externalEffect.upsert.mock.calls[0]![0];
      expect(JSON.parse(saved.create.result).contextScope).toBe(
        request.nativeRuntime!.contextScope,
      );
      expect(calls.at(-1)).toMatchObject({
        method: "codexRunContextScoped",
        config: { contextScope: request.nativeRuntime!.contextScope },
      });
      return request;
    };
    const privateTurn = await capture({ trigger: "user", messagingIdentity: true });
    const privateNext = await capture({ trigger: "messaging", runId: "private-next" });
    expect(privateTurn.instructions).toContain(messagingDmSurfaceNote());
    expect(privateTurn.instructions).not.toContain(messagingChannelPrivacyBlock());
    expect(
      privateTurn.history.some((message) => message.content.includes("Denied private history")),
    ).toBe(true);
    expect(privateNext.nativeRuntime!.contextScope).toBe(privateTurn.nativeRuntime!.contextScope);
    const channelA = await capture({ channelId: "channel-a" });
    const channelANext = await capture({ channelId: "channel-a", runId: "channel-next" });
    const channelB = await capture({ channelId: "channel-b" });
    expect(channelA.instructions).toContain(messagingDmSurfaceNote());
    expect(channelA.instructions).toContain(messagingChannelPrivacyBlock());
    expect(channelA.history.map((message) => message.content).join("\n")).toContain(
      "channel-a history",
    );
    expect(channelA.history.map((message) => message.content).join("\n")).not.toContain(
      "Denied private history",
    );
    expect(channelA.history.map((message) => message.content).join("\n")).not.toContain(
      "channel-b history",
    );
    const channelRequests = calls.filter(
      (call) =>
        call.method === "codexRunContextScoped" &&
        call.config.contextScope === channelA.nativeRuntime!.contextScope,
    );
    expect(channelRequests).toHaveLength(2);
    for (const input of channelRequests) {
      expect("history" in input && input.history).toContain("channel-a history");
      expect("history" in input && input.history).not.toContain("Denied private history");
      expect("history" in input && input.history).not.toContain("channel-b history");
    }
    expect(channelANext.nativeRuntime!.contextScope).toBe(channelA.nativeRuntime!.contextScope);
    expect(
      new Set(
        [privateTurn, channelA, channelB].map((request) => request.nativeRuntime!.contextScope),
      ).size,
    ).toBe(3);
    const routine = await capture({ trigger: "routine" });
    const routineNext = await capture({ trigger: "routine", runId: "routine-next" });
    const created = await capture({ trigger: "created" });
    expect(routine.history).toEqual([]);
    expect(routineNext.nativeRuntime!.contextScope).not.toBe(routine.nativeRuntime!.contextScope);
    expect(created.nativeRuntime!.contextScope).not.toBe(routine.nativeRuntime!.contextScope);
    expect(routine.nativeRuntime!.contextScope).not.toBe(privateTurn.nativeRuntime!.contextScope);
  });

  it.each([undefined, "another-context"])(
    "rejects recovery with mismatched or legacy authorization (%s) before native provisioning",
    async (contextScope) => {
      const checkpoint = JSON.stringify({
        runtime: "codex",
        version: 1,
        botId: "bot-1",
        threadId: "thread-1",
        runId: "run-1",
        projectPath: "/tmp/native-project",
        computerKey: "home-1",
        historyGeneration: 0,
        permission: "workspace",
        contextScope,
        after: 0,
        prompt: "Old private request",
        instructions: "Old instructions",
        model: "default",
      });
      const { runtimeRun, finalizeRun } = await runRoutine([], {
        codingAgent: true,
        channelId: "channel-a",
        turnCheckpoint: checkpoint,
      });
      expect(runtimeRun).not.toHaveBeenCalled();
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", error: "Native recovery binding mismatch" }),
      );
    },
  );

  it.each(["run-1", "foreign-run"])(
    "requires a persisted answer and this run's isolated scope after intro promotion (%s)",
    async (checkpointRunId) => {
      const introScope = nativeContextScope({
        id: "run-1",
        trigger: "created",
        spaceId: "space-1",
        userId: "user-1",
      });
      const checkpoint = JSON.stringify({
        runtime: "codex",
        version: 1,
        botId: "bot-1",
        threadId: "thread-1",
        runId: checkpointRunId,
        projectPath: "/tmp/native-project",
        computerKey: "home-1",
        historyGeneration: 0,
        permission: "workspace",
        contextScope: introScope,
        after: 1,
        prompt: "Intro question",
        instructions: "Intro instructions",
        model: "default",
        approvalId: "intro-question",
      });
      const fixture = await runRoutine([], {
        codingAgent: true,
        trigger: "user",
        turnCheckpoint: checkpoint,
      });
      if (checkpointRunId === "run-1") {
        expect(fixture.runtimeRun).not.toHaveBeenCalled();
        expect(fixture.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: "failed",
            error: "Native intro answer is unavailable",
          }),
        );
      } else {
        expect(fixture.runtimeRun).not.toHaveBeenCalled();
        expect(provisionComputer).not.toHaveBeenCalled();
        expect(fixture.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed", error: "Native recovery binding mismatch" }),
        );
      }
    },
  );
  it.each(["file", "image"] as const)(
    "copies native %s attachments before launching",
    async (attachments) => {
      const { runtimeRun, finalizeRun, sandbox } = await runRoutine([], {
        codingAgent: true,
        attachments,
      });
      expect(runtimeRun).toHaveBeenCalledOnce();
      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(sandbox.writeFile).toHaveBeenCalledOnce();
      expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        runtimeRun.mock.invocationCallOrder[0]!,
      );
      if (attachments === "image")
        expect(runtimeRun.mock.calls[0]![0].currentTurnImages).toHaveLength(1);
      expect(finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "completed",
        }),
      );
    },
  );
  it("offers screenshots and browser actions to the native default model without a Pi catalog entry", async () => {
    const { runtimeRun, finalizeRun } = await runRoutine([], {
      codingAgent: true,
      graphical: true,
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = runtimeRun.mock.calls[0]![0];
    expect(request.model).toMatchObject({ provider: "codex-native", id: "default" });
    expect(request.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "computer_observe",
        "computer_act",
        "browser_navigate",
        "browser_snapshot",
        "browser_act",
      ]),
    );
  });

  it("keeps the native browser page available after a committed login question", async () => {
    const { sandbox, finalizeRun, sleepJobs, toolResults } = await runRoutine(
      [{ name: "browser_snapshot", args: {} }],
      { codingAgent: true, graphical: true, ask: true },
    );
    expect(sandbox.pageBrowser).toHaveBeenCalledOnce();
    expect(toolResults).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ error: expect.anything() })]),
    );
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keepScreenWarm: true }),
    );
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(sleepJobs.length).toBeGreaterThanOrEqual(2);
  });
  it("does not retain a browser page when the input pause lost ownership", async () => {
    const { sandbox } = await runRoutine([], {
      codingAgent: true,
      graphical: true,
      ask: true,
      inputPauseAccepted: false,
    });
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ keepScreenWarm: true }),
    );
  });

  it("keeps text-only Pi screenshot tools gated even when another runtime advertises images", async () => {
    const { runtimeRun } = await runRoutine([], { graphical: true, runtimeImages: true });
    const names = runtimeRun.mock.calls[0]![0].tools.map((tool) => tool.name);
    expect(names).not.toContain("computer_observe");
    expect(names).not.toContain("computer_act");
    expect(names).toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]),
    );
  });

  it("does not advertise screenshot tools when a native runtime has no image capability", async () => {
    const { runtimeRun } = await runRoutine([], {
      codingAgent: true,
      graphical: true,
      runtimeImages: false,
    });
    const names = runtimeRun.mock.calls[0]![0].tools.map((tool) => tool.name);
    expect(names).not.toContain("computer_observe");
    expect(names).not.toContain("computer_act");
    expect(names).toContain("browser_snapshot");
  });

  it("executes a native host bot without Pi model credentials and owns its computer lifecycle", async () => {
    const { runtimeRun, finalizeRun, sandbox, prisma } = await runRoutine([], {
      codingAgent: true,
    });
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(runtimeRun).toHaveBeenCalledOnce();
    const request = runtimeRun.mock.calls[0]![0];
    expect(request.model).toMatchObject({ provider: "codex-native", id: "default" });
    expect(request.model.apiKey).toBeUndefined();
    expect(request.nativeRuntime).toEqual({
      executionTarget: "host",
      permission: "workspace",
      projectPath: "/tmp/native-project",
      computerKey: "home-1",
      historyGeneration: 0,
      runtimeGeneration: 0,
      contextScope: nativeContextScope({
        id: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        trigger: "routine",
      }),
    });
    expect(request.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "update_bot" })]),
    );
    const pinned = prisma.run.updateMany.mock.calls.findIndex(
      ([args]) => "nativeExecutionRunId" in args.data,
    );
    expect(pinned).toBeGreaterThanOrEqual(0);
    expect(prisma.run.updateMany.mock.calls[pinned]![0].data).toMatchObject({
      nativeExecutionRunId: "run-1",
      nativeComputerId: "computer-1",
      nativeComputerKey: "home-1",
    });
    expect(prisma.run.updateMany.mock.invocationCallOrder[pinned]).toBeLessThan(
      runtimeRun.mock.invocationCallOrder[0]!,
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(sandbox.releaseScreen).toHaveBeenCalledOnce();
  });
  it("retries handed-off setup failures with durable attempt accounting and backoff", async () => {
    const onRunStarted = vi.fn();
    const { run, enqueue, runtimeRun, prisma } = await runRoutine([], {
      setupError: new Error("fixture setup outage"),
      onRunStarted,
    });
    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith();
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(prisma.attempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "setup_failed" }),
      }),
    );
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: run.id },
        availableAt: expect.any(Date),
      }),
    );
  });

  it("spreads retries over minutes while the computer provider is down", async () => {
    // Every clock read moves on a millisecond, so two separate reads would disagree.
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1));
    try {
      const before = Date.now();
      const { run, enqueue } = await runRoutine([], {
        setupError: new SandboxUnresponsiveError("Boat could not be reached"),
        onRunStarted: vi.fn(),
        priorSetupFailures: 2,
      });

      const [[job]] = enqueue.mock.calls as unknown as [[{ availableAt: Date }]];
      expect(job.availableAt.getTime() - before).toBeGreaterThanOrEqual(60_000);
      expect(job.availableAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      expect(run.wakeAt).toEqual(job.availableAt);
    } finally {
      now.mockRestore();
    }
  });

  it("retains the setup-failure limit after handing off a run", async () => {
    const onRunStarted = vi.fn();
    const { enqueue, finalizeRun } = await runRoutine([], {
      setupError: new Error("fixture setup outage"),
      onRunStarted,
      priorSetupFailures: 7,
    });
    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never starts the computer for a run that does not use it", async () => {
    const { finalizeRun, sandbox, sleepJobs } = await runRoutine([]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it.each(["file", "image"] as const)(
    "keeps %s attachments lazy and images available to the model",
    async (attachments) => {
      const { finalizeRun, sandbox, runtimeRun } = await runRoutine([], { attachments });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.writeFile).not.toHaveBeenCalled();
      if (attachments === "image") {
        expect(runtimeRun.mock.calls[0]?.[0].currentTurnImages).toEqual([
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ]);
      }
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "run.computer", reason: "none", ready: false }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("private-upload");
      expect(JSON.stringify(sink.events)).not.toContain("private-storage-key");
    },
  );

  it.each([false, true])(
    "copies pending attachments before the first tool, including steering: %s",
    async (steering) => {
      const { finalizeRun, sandbox } = await runRoutine(
        [
          { name: "list_files", args: { path: "" } },
          { name: "list_files", args: { path: "" } },
        ],
        { attachments: "file", steering },
      );
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(sandbox.writeFile).toHaveBeenCalledOnce();
      expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        sandbox.listFiles.mock.invocationCallOrder[0]!,
      );
      expect(sink.events.filter((event) => event.message === "computer.requested")).toEqual([
        expect.objectContaining({ reason: "tool", tool: "list_files" }),
      ]);
    },
  );

  it("shares provisioning and copies attachments once across parallel tools", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", parallel: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
  });

  it("retries a transient attachment copy before a later tool without reprovisioning", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", copyFailureOnce: true, toolFailure: "recover" },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
  });

  it("delivers steering text and inline images without copying onto an already-started computer", async () => {
    const { sandbox, finalizeRun, steeringInputs } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { attachments: "image", steering: true, steeringAfterFirst: true, copyFailureOnce: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(steeringInputs).toEqual([
      expect.objectContaining({
        historyText: "Look at this",
        images: [
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ],
      }),
    ]);
  });

  it("copies steering attachments onto an already-started computer before the next tool", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", steering: true, steeringAfterFirst: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeGreaterThan(
      sandbox.listFiles.mock.invocationCallOrder[0]!,
    );
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.listFiles.mock.invocationCallOrder[1]!,
    );
  });

  it("does not boot for a steering attachment without computer tools", async () => {
    await runRoutine([], { attachments: "image", steering: true });
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps native chat lazy when native access is unavailable: %s",
    async (nativeUnavailable) => {
      const { finalizeRun, sandbox } = await runRoutine([], { native: true, nativeUnavailable });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.environment).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "desktop", botId: "home-1" }),
        expect.anything(),
      );
    },
  );

  it("starts the computer the first time a tool needs it and reuses it", async () => {
    const { finalizeRun, sandbox, sleepJobs, toolResults } = await runRoutine([
      { name: "list_files", args: { path: "" } },
      { name: "list_files", args: { path: "" } },
    ]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledWith(
      expect.anything(),
      "computer-1",
      expect.objectContaining({ runId: "run-1" }),
      "bot",
    );
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledWith(COMPUTER, expect.any(String), expect.anything());
    expect(toolResults[0]).toMatchObject({ entries: [{ path: "notes.txt" }] });
    expect(sleepJobs).toHaveLength(1);
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(COMPUTER, expect.anything());
  });

  it("completes the run when its closing workspace checkpoint fails", async () => {
    const { finalizeRun, sandbox } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      {
        attachments: "file",
        exportError: new Error("Boat API request failed (HTTP 502, sandbox_direct_failed)"),
      },
    );

    expect(sandbox.exportWorkspace).toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "computer.checkpoint_deferred" }),
    );
  });

  it("starts the computer before handing its screen to the user", async () => {
    await runRoutine([], { takeover: true });

    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("queues the continuation when release wins the race with the takeover pause", async () => {
    const publish = vi.spyOn(runMessages, "publishMessage").mockResolvedValue(null);
    try {
      const { enqueue, finalizeRun } = await runRoutine([], {
        takeover: true,
        takeoverReleased: true,
      });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
      );
      expect(finalizeRun).not.toHaveBeenCalled();
    } finally {
      publish.mockRestore();
    }
  });

  it("restarts the idle timer when it asks the user to take over", async () => {
    const { sleepJobs } = await runRoutine([], { takeover: true });

    // One from starting the computer, one from the takeover request.
    expect(sleepJobs).toHaveLength(2);
  });

  it("keeps setup-failure retry semantics when the computer cannot start", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    await expect(runRoutine([{ name: "list_files", args: { path: "" } }])).rejects.toThrow(
      "Run setup failed; retrying",
    );
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "error", message: "run setup failed" }),
    );
  });

  it("retries setup after a computer provider outage without an error report", async () => {
    provisionComputer.mockRejectedValue(new SandboxUnresponsiveError("Boat could not be reached"));

    await expect(runRoutine([{ name: "list_files", args: { path: "" } }])).rejects.toThrow(
      "Run setup failed; retrying",
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "run setup failed" }),
    );
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("does not report setup that a lost run lease aborted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      provisionComputer.mockImplementation(
        async (
          deps: { prisma: { run: { updateMany: ReturnType<typeof vi.fn> } } },
          _id: string,
          context: { signal: AbortSignal },
        ) => {
          deps.prisma.run.updateMany.mockResolvedValueOnce({ count: 0 });
          vi.advanceTimersByTime(60_000);
          await new Promise((resolve) => context.signal.addEventListener("abort", resolve));
          throw context.signal.reason;
        },
      );

      await runRoutine([{ name: "list_files", args: { path: "" } }]).catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "run setup failed" }),
    );
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("fails the run instead of retrying once setup has failed too many times in a row", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    const { finalizeRun, enqueue, prisma } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { priorSetupFailures: 7 },
    );

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", error: "provider unavailable" }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    // Busy-computer and database waits between failures neither count nor reset the streak.
    expect(prisma.attempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: { status: "setup_failed", error: null } }),
      }),
    );
  });

  it.each([undefined, "abort", "recover"] as const)(
    "finishes rate-limited runs without retrying when the model handles tool failure as %s",
    async (toolFailure) => {
      const error = new SandboxRateLimitError({ cause: new Error("Provider account limit") });
      provisionComputer.mockRejectedValue(error);

      const { finalizeRun, enqueue } = await runRoutine(
        [{ name: "list_files", args: { path: "" } }],
        { toolFailure },
      );

      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", error: error.message }),
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("requeues a run aborted by shutdown so the next worker resumes it", async () => {
    const { finalizeRun, prisma, run, enqueue, resumeOnNextWorker } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      {
        toolFailure: "abort",
        shutdownSignal: new AbortController().signal,
      },
    );

    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeAt: null,
    });
    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "run-1",
          status: "running",
          leaseOwner: "worker-1",
        }),
        data: expect.objectContaining({ status: "queued", leaseOwner: null, leaseExpiresAt: null }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(prisma.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "interrupted" }) }),
    );

    const resumed = await resumeOnNextWorker();
    expect(resumed.runtimeRun).toHaveBeenCalled();
    expect(resumed.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("requeues a run whose stream ends after shutdown instead of completing it", async () => {
    const { finalizeRun, prisma, run, enqueue } = await runRoutine([], {
      shutdownSignal: new AbortController().signal,
    });

    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(prisma.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "interrupted" }) }),
    );
  });

  it("fails a pinned native turn after shutdown instead of replaying its stopped host binding", async () => {
    const { runtimeRun, finalizeRun, run, enqueue } = await runRoutine([], {
      codingAgent: true,
      shutdownSignal: new AbortController().signal,
    });
    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error:
          "Native run interrupted during server shutdown. Check the project before starting a new run.",
      }),
    );
    expect(run.status).not.toBe("queued");
    expect(continueJobs(enqueue)).toEqual([]);
  });

  it("requeues native setup interrupted before a host binding is pinned", async () => {
    const shutdown = new AbortController();
    const { runtimeRun, finalizeRun, run, enqueue } = await runRoutine([], {
      codingAgent: true,
      shutdownSignal: shutdown.signal,
      onRunStarted: () => shutdown.abort(),
    });
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(continueJobs(enqueue)).toHaveLength(1);
  });

  it("does not claim a run when the worker is already shutting down", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const { runtimeRun, run, enqueue, finalizeRun } = await runRoutine([], {
      shutdownSignal: shutdown.signal,
    });

    expect(runtimeRun).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("requeues a run when shutdown lands before the model starts", async () => {
    const shutdown = new AbortController();
    const { runtimeRun, finalizeRun, run, enqueue } = await runRoutine([], {
      shutdownSignal: shutdown.signal,
      onRunStarted: () => shutdown.abort(),
    });

    expect(runtimeRun).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
  });

  it("still fails an aborted run when the worker is not shutting down", async () => {
    const { finalizeRun, run, enqueue } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { toolFailure: "abort" },
    );

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(run.status).not.toBe("queued");
    expect(continueJobs(enqueue)).toEqual([]);
  });

  it("leaves a user-stopped run cancelled", async () => {
    const { finalizeRun, run, enqueue } = await runRoutine([], { cancelRun: true });

    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("cancelled");
    expect(continueJobs(enqueue)).toEqual([]);
  });

  it("does not requeue a run the user stopped while the worker is shutting down", async () => {
    const { finalizeRun, run, enqueue } = await runRoutine([], {
      cancelRun: true,
      shutdownSignal: new AbortController().signal,
    });

    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("cancelled");
    expect(continueJobs(enqueue)).toEqual([]);
  });
});

function continueJobs(enqueue: { mock: { calls: unknown[][] } }) {
  return enqueue.mock.calls
    .map((call) => call[0] as { name?: string })
    .filter((job) => job?.name === "run.continue");
}

/** Models the run reads but these tests do not care about behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
