import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as CodexProcess from "./codex-app-server.js";
import type { CodexClientFactory } from "./codex-app-server.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";
import { nativeIntroExecutionId } from "./native-context.js";

// Replace only the provider process boundary. HTTP authentication, parsing,
// dispatch, persistent broker sessions and write ownership remain real.
const provider = vi.hoisted(() => ({ factory: vi.fn<CodexClientFactory>() }));
vi.mock("./codex-app-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CodexProcess>()),
  createCodexClientFactory: () => provider.factory,
}));

let root: string;
let server: Awaited<ReturnType<typeof startHostComputerServer>> | undefined;
const token = "cd".repeat(32);
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-context-http-")));
  await mkdir(path.join(root, "project"));
  calls.length = 0;
  let nextSession = 0;
  let nextTurn = 0;
  provider.factory.mockReset().mockImplementation((emit) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      notify() {},
      reply() {},
      close() {
        clearTimeout(timer);
      },
      async request(method, input) {
        const params = (input ?? {}) as Record<string, unknown>;
        calls.push({ method, params });
        if (method === "config/read") return { config: {} };
        if (method === "account/read") return { requiresOpenaiAuth: false };
        if (method === "thread/start") return { thread: { id: `session-${++nextSession}` } };
        if (method === "thread/resume") return { thread: { id: params.threadId } };
        if (method === "thread/backgroundTerminals/list") return { data: [] };
        if (method === "turn/start") {
          const turn = { id: `turn-${++nextTurn}`, status: "completed" };
          timer = setTimeout(() => {
            emit({ method: "turn/completed", params: { threadId: params.threadId, turn } });
          }, 10);
          return { turn: { id: turn.id } };
        }
        return {};
      },
    };
  });
  server = await startHostComputerServer({
    root,
    token,
    hostname: "127.0.0.1",
    writeScopeRoot: path.join(root, "write-scopes"),
  });
  server.setEnabled(true);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

function request(contextScope: string | undefined, runId: string, credential = token) {
  return fetch(`http://127.0.0.1:${server!.port}/computer`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      method: "codexRunContextScoped",
      botId: "same-bot",
      threadId: "same-thread",
      runId,
      config: {
        computerKey: "same-computer",
        historyGeneration: 0,
        projectPath: path.join(root, "project"),
        permission: "workspace",
        contextScope,
      },
      prompt: `request-${runId}`,
      history: `history-visible-only-to-${contextScope}`,
      instructions: "Test context isolation",
      model: "test-model",
      after: 0,
    }),
  });
}

it("keeps native transcript scope through authenticated HTTP parsing and dispatch", async () => {
  expect((await request("private", "unauthorized", "00".repeat(32))).status).toBe(401);
  expect((await request(undefined, "missing-scope")).status).toBe(400);
  expect(provider.factory).not.toHaveBeenCalled();

  const scopes = ["private", "channel-a", "channel-b", "channel-a", "private"];
  for (const [index, scope] of scopes.entries()) {
    const response = await request(scope, `run-${index}`);
    expect(response.status).toBe(200);
    const frames = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toEqual({ done: true });
    expect(frames.some((frame) => "error" in frame)).toBe(false);
    expect(frames.some((frame) => frame.value?.event.type === "done")).toBe(true);
  }

  const sessions = calls.filter((call) => ["thread/start", "thread/resume"].includes(call.method));
  expect(sessions.map((call) => call.method)).toEqual([
    "thread/start",
    "thread/start",
    "thread/start",
    "thread/resume",
    "thread/resume",
  ]);
  expect(sessions.slice(3).map((call) => call.params.threadId)).toEqual(["session-2", "session-1"]);
  const turns = calls.filter((call) => call.method === "turn/start");
  expect(turns.map((call) => call.params.threadId)).toEqual([
    "session-1",
    "session-2",
    "session-3",
    "session-2",
    "session-1",
  ]);
  for (const [index, turn] of turns.entries()) {
    const text = (turn.params.input as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(`request-run-${index}`);
    if (index < 3) expect(text).toContain(`history-visible-only-to-${scopes[index]}`);
    for (const other of scopes.filter((scope) => scope !== scopes[index]))
      expect(text).not.toContain(`history-visible-only-to-${other}`);
  }
});

it("keeps handover child application commands usable while native work is active and stops both identities", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  provider.factory.mockImplementation((emit) => ({
    notify() {},
    reply() {},
    close() {},
    async request(method) {
      if (method === "config/read") return { config: {} };
      if (method === "account/read") return { requiresOpenaiAuth: false };
      if (method === "thread/start") return { thread: { id: "active-child-session" } };
      if (method === "thread/backgroundTerminals/list") return { data: [] };
      if (method === "turn/start") {
        started();
        return { turn: { id: "active-child-turn" } };
      }
      if (method === "turn/interrupt")
        emit({
          method: "turn/completed",
          params: {
            threadId: "active-child-session",
            turn: { id: "active-child-turn", status: "interrupted" },
          },
        });
      return {};
    },
  }));
  const client = new HostComputerSandbox(`http://127.0.0.1:${server!.port}`, token);
  const context = {
    operationId: "fixture",
    traceId: "fixture",
    userId: "user",
    spaceId: "space",
    runId: "logical-run",
    signal: AbortSignal.timeout(15000),
  };
  const computer = await client.provision(
    { botId: "fixture-computer", homePath: "/unused" },
    context,
  );
  const physicalRunId = nativeIntroExecutionId(context.runId);
  const input = {
    method: "codexRunContextScoped" as const,
    botId: "bot",
    threadId: "thread",
    runId: physicalRunId,
    config: {
      computerKey: computer.botId,
      projectPath: path.join(root, "project"),
      permission: "workspace" as const,
      historyGeneration: 0,
      contextScope: "intro-scope",
      applicationRunId: context.runId,
    },
    prompt: "User task",
    instructions: "instructions",
    model: "default",
    after: 0,
  };
  const running = (async () => {
    for await (const _ of client.request(input, context)) {
    }
  })().catch((error: Error) => error);
  await began;
  try {
    // These operations run before native completion. Both require reentrant
    // ownership under the logical application run rather than the physical child.
    await client.writeFile(
      computer,
      { path: "notes/active.txt", content: Buffer.from("active child write") },
      context,
    );
    const output = [];
    for await (const event of client.execute(
      computer,
      { argv: [process.execPath, "-e", "process.stdout.write('active command')"] },
      context,
    ))
      output.push(event);
    expect(output).toContainEqual({ type: "stdout", data: "active command" });
    await client.cancelRunWork(computer, computer.id, physicalRunId, {
      ...context,
      requireRunCleanup: true,
    });
    await expect(
      client.writeFile(computer, { path: "notes/late.txt", content: Buffer.from("late") }, context),
    ).rejects.toThrow();
    expect(await running).toBeInstanceOf(Error);
  } finally {
    await client.cancelRunWork(computer, computer.id, physicalRunId, {
      ...context,
      signal: AbortSignal.timeout(10000),
      requireRunCleanup: true,
    });
    await running;
  }
});
