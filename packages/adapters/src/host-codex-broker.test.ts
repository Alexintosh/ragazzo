import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexClientFactory, CodexMessage } from "./codex-app-server.js";
import { CodexRpcError } from "./codex-app-server.js";
import { HostCodexBroker } from "./host-codex-broker.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { nativeContextScope } from "./native-context.js";
import { NativeWriteScopes } from "./native-write-scope.js";

describe("native Codex host ownership", () => {
  let root: string;
  const brokers: HostCodexBroker[] = [];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-native-")));
  });
  afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.close();
    await rm(root, { recursive: true, force: true });
  });
  function setup(
    options: {
      loseStart?: boolean;
      exitOnClose?: boolean;
      requests?: Record<string, (params: any) => Promise<any>>;
    } = {},
  ) {
    let emit: (message: CodexMessage) => void = () => undefined;
    const calls: Array<{ method: string; params: any }> = [];
    const close = vi.fn();
    const reply = vi.fn();
    const factory: CodexClientFactory = vi.fn((listener, onExit) => {
      emit = listener;
      if (options.exitOnClose) close.mockImplementation(onExit);
      return {
        close,
        reply,
        notify: vi.fn(),
        async request(method: string, params: unknown) {
          calls.push({ method, params });
          if (options.requests?.[method]) return options.requests[method]!(params);
          if (method === "config/read") return { config: {} };
          if (method === "model/list")
            return {
              data: [
                {
                  model: "test-model",
                  displayName: "Test model",
                  isDefault: true,
                  defaultReasoningEffort: "low",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low" },
                    { reasoningEffort: "ultra" },
                  ],
                },
              ],
              nextCursor: null,
            };
          if (method === "account/read")
            return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
          if (method === "thread/start" || method === "thread/resume")
            return { thread: { id: "native-session" } };
          if (method === "turn/start") {
            if (options.loseStart)
              throw new Error("Native Codex response uncertain; do not retry the turn");
            return { turn: { id: "native-turn" } };
          }
          if (method === "turn/interrupt")
            emit({
              method: "turn/completed",
              params: {
                threadId: "native-session",
                turn: { id: "native-turn", status: "interrupted" },
              },
            });
          if (method === "thread/backgroundTerminals/list") return { data: [] };
          return {};
        },
      };
    });
    const broker = new HostCodexBroker(
      path.join(root, "state"),
      factory,
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    brokers.push(broker);
    const input: Extract<HostComputerRequest, { method: "codexRun" }> = {
      method: "codexRun",
      botId: "bot-a",
      threadId: "thread-a",
      runId: "run-a",
      after: 0,
      config: {
        projectPath: root,
        permission: "workspace",
        computerKey: "host-workspace",
        historyGeneration: 0,
      },
      prompt: "task",
      instructions: "instructions",
      model: "test-model",
    };
    return {
      broker,
      input,
      calls,
      close,
      reply,
      factory,
      emit: (message: CodexMessage) => emit(message),
    };
  }
  it("runs two disjoint same-bot tasks concurrently, queues collisions and stops only one", async () => {
    await mkdir(path.join(root, "left"));
    await mkdir(path.join(root, "right"));
    const a = setup();
    const b = setup();
    const collision = setup();
    a.input.config.writeSubdirectory = "left";
    b.input = {
      ...b.input,
      threadId: "thread-b",
      runId: "run-b",
      config: { ...b.input.config, writeSubdirectory: "right" },
    };
    collision.input = {
      ...collision.input,
      botId: "bot-c",
      threadId: "thread-c",
      runId: "run-c",
      config: { ...collision.input.config, writeSubdirectory: "left" },
    };
    const drain = async (item: typeof a) => {
      for await (const _event of item.broker.run(item.input, new AbortController().signal)) {
      }
    };
    const left = drain(a).catch((error) => error);
    const right = drain(b).catch((error) => error);
    await vi.waitFor(() => {
      expect(a.calls.some((call) => call.method === "turn/start")).toBe(true);
      expect(b.calls.some((call) => call.method === "turn/start")).toBe(true);
    });
    const turn = b.calls.find((call) => call.method === "turn/start")!.params;
    expect(turn.cwd).toBe(path.join(root, "right"));
    expect(turn.sandboxPolicy.writableRoots).toEqual([path.join(root, "right")]);
    expect(turn.sandboxPolicy.excludeSlashTmp).toBe(true);
    expect(turn.approvalPolicy).toBe("never");
    expect(b.factory).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      cwd: path.join(root, "right"),
    });
    const queued = drain(collision).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(collision.calls.some((call) => call.method === "turn/start")).toBe(false);
    await a.broker.abort(a.input);
    await left;
    await vi.waitFor(() =>
      expect(collision.calls.some((call) => call.method === "turn/start")).toBe(true),
    );
    expect(b.close).not.toHaveBeenCalled();
    b.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    await right;
    await collision.broker.abort(collision.input);
    await queued;
  });
  async function started(s: ReturnType<typeof setup>) {
    const stream = s.broker.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value?.event.type).toBe("progress");
    await vi.waitFor(() =>
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(1),
    );
    return stream;
  }
  it("forwards native preferences and resets changed effort in a fresh session with history", async () => {
    const s = setup();
    s.input.thinkingLevel = "ultra";
    let stream = await started(s);
    expect(s.calls.find((call) => call.method === "thread/start")?.params.model).toBe("test-model");
    expect(s.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      model: "test-model",
      effort: "ultra",
    });
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    for await (const _event of { [Symbol.asyncIterator]: () => stream }) {
    }
    s.calls.length = 0;
    s.input = { ...s.input, runId: "run-b", thinkingLevel: "ultra" };
    stream = await started(s);
    expect(s.calls.find((call) => call.method === "thread/resume")?.params.model).toBe(
      "test-model",
    );
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    for await (const _event of { [Symbol.asyncIterator]: () => stream }) {
    }
    s.calls.length = 0;
    s.input = {
      ...s.input,
      runId: "run-c",
      model: "default",
      thinkingLevel: null,
      history: "Authorized conversation",
    };
    stream = await started(s);
    expect(s.calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(s.calls.find((call) => call.method === "thread/start")?.params.model).toBeNull();
    expect(s.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      model: null,
      effort: null,
      input: [
        expect.objectContaining({ text: expect.stringContaining("Authorized conversation") }),
      ],
    });
    await s.broker.abort(s.input);
    await stream.next().catch(() => undefined);
  });
  it("reads configured inherited defaults in the bot project and uses catalog defaults for explicit models", async () => {
    const s = setup({
      requests: {
        "config/read": async () => ({
          config: { model: "configured-model", model_reasoning_effort: "high" },
        }),
      },
    });
    expect(await s.broker.models(root)).toMatchObject({
      defaultModelId: "configured-model",
      defaultThinkingLevel: "high",
    });
    expect(s.calls.find((call) => call.method === "config/read")?.params.cwd).toBe(root);
    expect(s.factory).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      cwd: root,
    });
    expect(s.calls.some((call) => call.method === "turn/start")).toBe(false);
    s.calls.length = 0;
    s.input.thinkingLevel = null;
    const stream = await started(s);
    expect(s.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({
      model: "test-model",
      effort: "low",
    });
    await s.broker.abort(s.input);
    await stream.next().catch(() => undefined);
  });
  it("refreshes inherited defaults when project configuration changes between turns", async () => {
    let configured = { model: "configured-first", model_reasoning_effort: "high" };
    const s = setup({ requests: { "config/read": async () => ({ config: configured }) } });
    s.input.model = "default";
    s.input.thinkingLevel = null;
    let stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    for await (const _event of { [Symbol.asyncIterator]: () => stream }) {
    }
    s.calls.length = 0;
    configured = { model: "configured-second", model_reasoning_effort: "low" };
    s.input = { ...s.input, runId: "updated-config", history: "Authorized history" };
    stream = await started(s);
    expect(s.calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(s.calls.find((call) => call.method === "turn/start")?.params.input[0].text).toContain(
      "Authorized history",
    );
    await s.broker.abort(s.input);
    await stream.next().catch(() => undefined);
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  it.each(["codex", "claude", "acp"] as const)(
    "keeps %s transcripts separate while continuing each private or channel conversation",
    async (nativeKind) => {
      let sessionNumber = 0;
      const s = setup({
        requests: {
          "thread/start": async () => ({ thread: { id: `session-${++sessionNumber}` } }),
          "thread/resume": async (params) => ({ thread: { id: params.threadId } }),
        },
      });
      s.input.nativeKind = nativeKind;
      const context = (id: string, trigger: string, channelId?: string) =>
        nativeContextScope(
          {
            id,
            trigger,
            spaceId: "space-a",
            userId: "owner-a",
          },
          channelId,
        );
      const surfaces = [
        { trigger: "user" },
        { trigger: "messaging" },
        { trigger: "messaging", channelId: "channel-a" },
        { trigger: "messaging", channelId: "channel-b" },
        { trigger: "messaging", channelId: "channel-a" },
        { trigger: "routine" },
        { trigger: "routine" },
        { trigger: "user" },
      ];
      const sessions: string[] = [];
      for (const [index, surface] of surfaces.entries()) {
        const runId = `scope-run-${index}`;
        const input = {
          ...s.input,
          runId,
          prompt: `Request ${index}`,
          history: `Authorized history ${index}`,
          config: {
            ...s.input.config,
            contextScope: context(runId, surface.trigger, surface.channelId),
          },
        };
        const stream = s.broker.run(input, new AbortController().signal)[Symbol.asyncIterator]();
        await stream.next();
        await vi.waitFor(() =>
          expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(index + 1),
        );
        const turn = s.calls.filter((call) => call.method === "turn/start").at(-1)!.params;
        sessions.push(turn.threadId);
        const resumed = [1, 4, 7].includes(index);
        expect(turn.input[0].text).toBe(
          resumed
            ? input.prompt
            : `Conversation context:\n${input.history}\n\nCurrent request:\n${input.prompt}`,
        );
        s.emit({
          method: "turn/completed",
          params: { threadId: turn.threadId, turn: { id: "native-turn", status: "completed" } },
        });
        while (!(await stream.next()).done) {}
      }
      expect(sessions).toEqual([
        "session-1",
        "session-1",
        "session-2",
        "session-3",
        "session-2",
        "session-4",
        "session-5",
        "session-1",
      ]);
      expect(s.calls.filter((call) => call.method === "thread/start")).toHaveLength(5);
      expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(3);
    },
  );

  it("preserves legacy continuation but never adopts a legacy session for a scoped run", async () => {
    const s = setup();
    const finish = async (input: typeof s.input) => {
      const stream = s.broker.run(input, new AbortController().signal)[Symbol.asyncIterator]();
      await stream.next();
      const count = s.calls.filter(
        (call) => call.method === "thread/start" || call.method === "thread/resume",
      ).length;
      await vi.waitFor(() =>
        expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(count),
      );
      s.emit({
        method: "turn/completed",
        params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
      });
      while (!(await stream.next()).done) {}
    };
    await finish(s.input);
    await finish({ ...s.input, runId: "legacy-next" });
    expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    const scoped = {
      ...s.input,
      runId: "scoped-next",
      config: { ...s.input.config, contextScope: "channel-a" },
    };
    const foreign = s.broker
      .run({ ...scoped, session: "native-session" }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(foreign.next()).rejects.toThrow("does not belong");
    expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    await finish({ ...scoped, runId: "scoped-fresh" });
    expect(s.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    await finish({ ...scoped, runId: "scoped-repeat" });
    expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(2);
  });
  it("rejects late steering before submission without failing completion while terminal cleanup is held", async () => {
    const held = deferred<void>();
    let cleans = 0;
    const s = setup({
      requests: {
        "thread/backgroundTerminals/clean": async () => {
          if (++cleans === 2) await held.promise;
          return {};
        },
      },
    });
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    await vi.waitFor(() => expect(cleans).toBe(2));
    const input = {
      ...s.input,
      method: "codexSteer" as const,
      messageId: "late",
      text: "next request",
    };
    await expect(s.broker.steer(input)).resolves.toEqual({ accepted: false, reason: "turn-ended" });
    await expect(s.broker.steer(input)).resolves.toEqual({ accepted: false, reason: "turn-ended" });
    expect(
      s.calls.filter((call) => call.method === "turn/steer" || call.method === "turn/interrupt"),
    ).toHaveLength(0);
    held.resolve();
    expect((await stream.next()).value?.event).toEqual({ type: "done" });
    await stream.return?.();
  });
  it("answers batched questions independently and serializes concurrent requests", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      id: 50,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        questions: [
          { id: "color", question: "Color?", options: [{ label: "Blue", description: "Ocean" }] },
          { id: "size", question: "Size?" },
        ],
      },
    });
    s.emit({
      id: 51,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        command: "echo hello",
        cwd: root,
      },
    });
    const first = (await stream.next()).value!;
    expect(first.event).toMatchObject({ type: "ask", text: "Color?", detail: "Blue: Ocean" });
    s.broker.answer(s.input, first.approvalId!, "Blue");
    expect(s.reply).not.toHaveBeenCalled();
    // Replaying the first answer must neither skip nor answer the second question.
    s.broker.answer(s.input, first.approvalId!, "Blue");
    const second = (await stream.next()).value!;
    expect(second.event).toMatchObject({ type: "ask", text: "Size?" });
    s.broker.answer(s.input, second.approvalId!, "Large");
    expect(s.reply).toHaveBeenNthCalledWith(1, 50, {
      answers: { color: { answers: ["Blue"] }, size: { answers: ["Large"] } },
    });
    const approval = (await stream.next()).value!;
    s.broker.answer(s.input, approval.approvalId!, "reject");
    expect(s.reply).toHaveBeenNthCalledWith(2, 51, { decision: "decline" });
    await stream.return?.();
  });
  it("steers the owned active turn once and rejects changed replay payloads", async () => {
    const s = setup({ requests: { "turn/steer": async () => ({ turnId: "native-turn" }) } });
    const stream = await started(s);
    const steer = {
      ...s.input,
      method: "codexSteer" as const,
      messageId: "steer-1",
      text: "Use blue",
      images: ["data:image/png;base64,AQ=="],
    };
    await Promise.all([s.broker.steer(steer), s.broker.steer(steer)]);
    expect(s.calls.filter((call) => call.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "native-session",
          expectedTurnId: "native-turn",
          clientUserMessageId: "steer-1",
          input: [
            { type: "text", text: "Use blue", text_elements: [] },
            { type: "image", url: "data:image/png;base64,AQ==" },
          ],
        },
      },
    ]);
    await expect(s.broker.steer({ ...steer, text: "Use red" })).rejects.toThrow("binding mismatch");
    await stream.return?.();
  });
  it("attaches explicit project deliverables before done while refusing links outside the project and symlinks", async () => {
    const s = setup();
    const stream = await started(s);
    await writeFile(path.join(root, "report.txt"), "output");
    await writeFile(path.join(root, "state", "private.txt"), "private");
    await symlink(path.join(root, "state", "private.txt"), path.join(root, "link.txt"));
    s.emit({
      method: "item/completed",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        item: {
          type: "agentMessage",
          text: "[Report](report.txt) [Again](report.txt) [Link](link.txt) [Outside](../outside.txt) [Remote](https://example.com/file.txt)",
        },
      },
    });
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    const events = [];
    for await (const envelope of { [Symbol.asyncIterator]: () => stream }) events.push(envelope);
    expect(events.filter((event) => event.outputFile)).toEqual([
      expect.objectContaining({
        outputFile: {
          id: expect.any(String),
          path: "report.txt",
          content: Buffer.from("output").toString("base64"),
        },
      }),
    ]);
    expect(events.at(-1)?.event.type).toBe("done");
  });
  it("requires a verified cleanup receipt for an unknown run after restart", async () => {
    const s = setup();
    const stream = await started(s);
    const restarted = new HostCodexBroker(
      path.join(root, "state"),
      s.factory,
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    brokers.push(restarted);
    await expect(restarted.stopBot("host-workspace", "run-a", true)).rejects.toThrow(
      "cleanup failed",
    );
    expect(s.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(0);
    await s.broker.stopBot("host-workspace", "run-a", true);
    await stream.return?.();
    await expect(restarted.stopBot("host-workspace", "run-a", true)).resolves.toBeUndefined();
    // Unrelated identities have no start fence and can be cancelled before launch.
    await expect(restarted.stopBot("other-workspace", "run-a", true)).resolves.toBeUndefined();
    await expect(restarted.stopBot("host-workspace", "other-run", true)).resolves.toBeUndefined();
    expect(s.factory).toHaveBeenCalledTimes(1);
  });
  it("durably cancels pinned work before host registration and refuses its delayed launch after restart", async () => {
    const s = setup();
    await s.broker.stopBot("host-workspace", "run-a", true);
    const restarted = new HostCodexBroker(
      path.join(root, "state"),
      s.factory,
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    brokers.push(restarted);
    await expect(restarted.stopBot("host-workspace", "run-a", true)).resolves.toBeUndefined();
    const stream = restarted.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow();
    expect(s.factory).not.toHaveBeenCalled();
  });
  it("does not certify an unknown run when an unresolved legacy launch journal exists", async () => {
    const s = setup();
    const stream = await started(s);
    await s.broker.stopBot("host-workspace", "run-a", true);
    await stream.return?.();
    await writeFile(
      path.join(root, "state", "legacy.run"),
      JSON.stringify({ state: "started", session: "legacy-session" }),
    );
    await expect(s.broker.stopBot("host-workspace", "unknown-run", true)).rejects.toThrow(
      "cleanup failed",
    );
  });

  it("cannot turn an uncertain journal replay into a cleanup receipt", async () => {
    const s = setup();
    const stream = await started(s);
    const restarted = new HostCodexBroker(
      path.join(root, "state"),
      s.factory,
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    const replay = restarted.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(replay.next()).rejects.toThrow("uncertain");
    await expect(restarted.stopBot("host-workspace", "run-a", true)).rejects.toThrow("uncertain");
    await restarted.close().catch(() => undefined);
    await s.broker.stopBot("host-workspace", "run-a", true);
    await stream.return?.();
  });

  it.each(["abort", "stopBot", "close"])(
    "%s sees ownership before asynchronous path validation",
    async (method) => {
      const s = setup();
      const stream = s.broker.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
      const result = stream.next().catch((error: Error) => error);
      if (method === "abort") await s.broker.abort(s.input);
      else if (method === "stopBot") await s.broker.stopBot("host-workspace");
      else await s.broker.close();
      expect(await result).toBeInstanceOf(Error);
      expect(s.factory).not.toHaveBeenCalled();
    },
  );
  it("remembers an exact cancellation that arrives before the stream is consumed", async () => {
    const s = setup();
    await s.broker.abort(s.input);
    const stream = s.broker.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow("stopped");
    expect(s.factory).not.toHaveBeenCalled();
  });
  it.each(["initialize", "account/read", "config/read", "thread/start"])(
    "cancels while %s is pending without launching later work",
    async (method) => {
      const gate = deferred<any>();
      const s = setup({ requests: { [method]: () => gate.promise } });
      const stream = s.broker.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
      const result = stream.next().catch((error: Error) => error);
      await vi.waitFor(() => expect(s.calls.some((call) => call.method === method)).toBe(true));
      const stop = s.broker.abort(s.input);
      gate.resolve(
        method === "account/read"
          ? { account: { type: "chatgpt" } }
          : method === "config/read"
            ? { config: {} }
            : method === "thread/start"
              ? { thread: { id: "native-session" } }
              : {},
      );
      await stop;
      expect(await result).toBeInstanceOf(Error);
      expect(s.calls.some((call) => call.method === "turn/start")).toBe(false);
      if (method === "initialize")
        expect(s.calls.some((call) => call.method === "account/read")).toBe(false);
      expect(s.close).toHaveBeenCalledTimes(1);
    },
  );
  it("waits for a pending turn/start ID and interrupts that owned turn", async () => {
    const gate = deferred<any>();
    const s = setup({ requests: { "turn/start": () => gate.promise } });
    const stream = await started(s);
    await stream.return?.();
    const stop = s.broker.abort(s.input);
    expect(s.close).not.toHaveBeenCalled();
    gate.resolve({ turn: { id: "native-turn" } });
    await stop;
    expect(s.calls.filter((call) => call.method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "native-session", turnId: "native-turn" },
      },
    ]);
    expect(s.close).toHaveBeenCalledTimes(1);
  });
  it("awaits interrupt, the exact terminal, and verified cleanup before acknowledging duplicate stops", async () => {
    const interrupt = deferred<any>(),
      clean = deferred<any>(),
      list = deferred<any>();
    let cleans = 0,
      lists = 0;
    const s = setup({
      requests: {
        "turn/interrupt": () => interrupt.promise,
        "thread/backgroundTerminals/clean": async () => (++cleans === 1 ? {} : clean.promise),
        "thread/backgroundTerminals/list": async () =>
          ++lists === 1 ? { data: [] } : list.promise,
      },
    });
    const stream = await started(s);
    s.emit({
      id: 60,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        command: "test",
        cwd: root,
      },
    });
    const approval = (await stream.next()).value!;
    await stream.return?.();
    let stopped = false;
    const stop = s.broker.abort(s.input).then(() => {
      stopped = true;
    });
    const duplicate = s.broker.stopBot("host-workspace");
    const closed = s.broker.close();
    expect(() => s.broker.answer(s.input, approval.approvalId!, "approve")).toThrow(
      "no longer available",
    );
    const competing = s.broker.run(
      { ...s.input, runId: "competing" },
      new AbortController().signal,
    );
    await expect(competing[Symbol.asyncIterator]().next()).rejects.toThrow("already running");
    await vi.waitFor(() =>
      expect(s.calls.some((call) => call.method === "turn/interrupt")).toBe(true),
    );
    interrupt.resolve({});
    s.emit({
      method: "turn/completed",
      params: {
        threadId: "other-session",
        turn: { id: "native-turn", status: "interrupted" },
      },
    });
    s.emit({
      method: "turn/completed",
      params: {
        threadId: "native-session",
        turn: { id: "other-turn", status: "interrupted" },
      },
    });
    await Promise.resolve();
    expect(cleans).toBe(1);
    s.emit({
      method: "turn/completed",
      params: {
        threadId: "native-session",
        turn: { id: "native-turn", status: "interrupted" },
      },
    });
    await vi.waitFor(() => expect(cleans).toBe(2));
    expect(stopped).toBe(false);
    expect(s.close).not.toHaveBeenCalled();
    clean.resolve({});
    await vi.waitFor(() => expect(lists).toBe(2));
    expect(stopped).toBe(false);
    expect(s.close).not.toHaveBeenCalled();
    list.resolve({ data: [] });
    await Promise.all([stop, duplicate, closed]);
    expect(s.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(1);
    expect(s.close).toHaveBeenCalledTimes(1);
  });
  it("cleans a successful turn before emitting done without interrupting it", async () => {
    const gate = deferred<any>();
    let cleans = 0;
    const s = setup({
      exitOnClose: true,
      requests: {
        "thread/backgroundTerminals/clean": async () => (++cleans === 1 ? {} : gate.promise),
      },
    });
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: {
        threadId: "native-session",
        turn: { id: "native-turn", status: "completed" },
      },
    });
    let done = false;
    const result = stream.next().then((event) => {
      done = true;
      return event;
    });
    await vi.waitFor(() => expect(cleans).toBe(2));
    expect(done).toBe(false);
    expect(s.close).not.toHaveBeenCalled();
    gate.resolve({});
    expect((await result).value?.event.type).toBe("done");
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.calls.some((call) => call.method === "turn/interrupt")).toBe(false);
    await stream.return?.();
  });
  it("bounds cleanup failure, closes its transport, and never reports successful cancellation", async () => {
    let cleans = 0;
    const s = setup({
      requests: {
        "thread/backgroundTerminals/clean": async () =>
          ++cleans === 1 ? {} : new Promise(() => undefined),
      },
    });
    const stream = await started(s);
    await stream.return?.();
    vi.useFakeTimers();
    try {
      const stopped = s.broker.abort(s.input).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await stopped).toMatchObject({ message: expect.stringContaining("cleanup failed") });
      expect(s.close).toHaveBeenCalledTimes(1);
      const competing = s.broker.run(
        { ...s.input, runId: "competing" },
        new AbortController().signal,
      );
      await expect(competing[Symbol.asyncIterator]().next()).rejects.toThrow("already running");
    } finally {
      vi.useRealTimers();
      brokers.splice(brokers.indexOf(s.broker), 1);
    }
  });
  it("requires native terminal cleanup support before sending turn/start", async () => {
    const s = setup({
      requests: {
        "thread/backgroundTerminals/clean": async () => {
          throw new Error("Method not found");
        },
      },
    });
    const stream = s.broker.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow("cleanup failed");
    expect(s.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(s.close).toHaveBeenCalledTimes(1);
    brokers.splice(brokers.indexOf(s.broker), 1);
  });
  it("rejects cancellation when cleanup still lists owned terminals", async () => {
    let lists = 0;
    const s = setup({
      requests: {
        "thread/backgroundTerminals/list": async () => ({
          data: ++lists === 1 ? [] : [{ processId: "still-alive" }],
        }),
      },
    });
    const stream = await started(s);
    await stream.return?.();
    vi.useFakeTimers();
    try {
      const stopped = s.broker.abort(s.input).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(7500);
      expect(await stopped).toMatchObject({ message: expect.stringContaining("cleanup failed") });
      expect(s.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      brokers.splice(brokers.indexOf(s.broker), 1);
    }
  });
  it("keeps the client alive after clean acknowledgement until the terminal registry drains", async () => {
    let lists = 0;
    const s = setup({
      requests: {
        "thread/backgroundTerminals/list": async () => ({
          data: ++lists === 2 ? [{ processId: "exiting-terminal" }] : [],
        }),
      },
    });
    const stream = await started(s);
    await stream.return?.();
    vi.useFakeTimers();
    try {
      let stopped = false;
      const stop = s.broker.abort(s.input).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(lists).toBe(2);
      expect(stopped).toBe(false);
      expect(s.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24);
      expect(s.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stop;
      expect(lists).toBe(3);
      expect(s.close).toHaveBeenCalledTimes(1);
      expect(
        s.calls.filter((call) => call.method === "thread/backgroundTerminals/clean"),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cleans terminals even if the interrupt request fails", async () => {
    const s = setup({
      requests: {
        "turn/interrupt": async () => {
          throw new Error("Lost interrupt acknowledgement");
        },
      },
    });
    const stream = await started(s);
    await stream.return?.();
    await expect(s.broker.abort(s.input)).rejects.toThrow("cleanup failed");
    expect(
      s.calls.filter((call) => call.method === "thread/backgroundTerminals/clean"),
    ).toHaveLength(2);
    expect(s.close).toHaveBeenCalledTimes(1);
    brokers.splice(brokers.indexOf(s.broker), 1);
  });
  it("starts only once across reattachment and binds approval replies to bot/thread/run", async () => {
    const s = setup();
    const stream = await started(s);
    expect(s.calls.find((c) => c.method === "thread/start")?.params).toMatchObject({
      cwd: root,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    s.emit({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        command: "test-command",
        cwd: root,
      },
    });
    const approval = (await stream.next()).value!;
    expect(approval.event.type).toBe("ask");
    await stream.return?.();
    expect(() =>
      s.broker.answer({ ...s.input, botId: "wrong" }, approval.approvalId!, "approve"),
    ).toThrow();
    s.broker.answer(s.input, approval.approvalId!, "approve");
    s.broker.answer(s.input, approval.approvalId!, "approve");
    expect(s.reply).toHaveBeenCalledExactlyOnceWith(41, { decision: "accept" });
    expect(() => s.broker.answer(s.input, approval.approvalId!, "reject")).toThrow();
    const resumed = s.broker
      .run({ ...s.input, after: 2 }, new AbortController().signal)
      [Symbol.asyncIterator]();
    s.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "native-session", turnId: "native-turn", delta: "done" },
    });
    expect((await resumed.next()).value?.event).toEqual({ type: "text", text: "done" });
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    expect((await resumed.next()).value?.event.type).toBe("done");
    await resumed.return?.();
    expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
  });
  it("refuses replay after host restart and kills only the broker-owned process", async () => {
    const s = setup();
    const stream = await started(s);
    await stream.return?.();
    await s.broker.close();
    expect(s.close).toHaveBeenCalledTimes(1);
    const restarted = new HostCodexBroker(
      path.join(root, "state"),
      s.factory,
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    brokers.push(restarted);
    const recovered = restarted.run(s.input, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(recovered.next()).rejects.toThrow("uncertain");
    await expect(restarted.close()).rejects.toThrow("uncertain");
    brokers.splice(brokers.indexOf(restarted), 1);
    expect(s.factory).toHaveBeenCalledTimes(1);
  });
  it("persists session binding for the next run and rejects foreign native session ids", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    expect((await stream.next()).value?.event.type).toBe("done");
    await stream.return?.();
    const next = s.broker
      .run({ ...s.input, runId: "run-b" }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await next.next();
    expect(s.calls.find((c) => c.method === "thread/resume")?.params.threadId).toBe(
      "native-session",
    );
    await next.return?.();
    await s.broker.abort({ ...s.input, runId: "run-b" });
    const foreign = s.broker
      .run({ ...s.input, runId: "run-c", session: "foreign" }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(foreign.next()).rejects.toThrow("does not belong");
  });
  it("transport cancellation detaches without silently restarting or killing work", async () => {
    const s = setup();
    const signal = new AbortController();
    const stream = s.broker.run(s.input, signal.signal)[Symbol.asyncIterator]();
    await stream.next();
    signal.abort();
    await expect(stream.next()).rejects.toThrow();
    expect(s.close).not.toHaveBeenCalled();
    await s.broker.abort({ ...s.input, threadId: "other" });
    expect(s.close).not.toHaveBeenCalled();
    await s.broker.abort(s.input);
    expect(s.close).toHaveBeenCalledTimes(1);
  });
  it("computer stop cancels a paused approval using its workspace ownership key", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      method: "item/started",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        item: {
          type: "fileChange",
          id: "patch-a",
          changes: [{ path: "/outside/file.txt", diff: "+ proposed change" }],
        },
      },
    });
    await stream.next();
    s.emit({
      id: 47,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        itemId: "patch-a",
        grantRoot: "/outside",
      },
    });
    const approval = (await stream.next()).value!;
    if (approval.event.type === "ask") {
      expect(approval.event.detail).toContain("Requested write root: /outside");
      expect(approval.event.detail).toContain("/outside/file.txt");
      expect(approval.event.detail).toContain("+ proposed change");
    } else throw new Error("Expected an approval");
    await stream.return?.();
    await s.broker.stopBot("another-workspace");
    expect(s.close).not.toHaveBeenCalled();
    await s.broker.stopBot("host-workspace");
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(() => s.broker.answer(s.input, approval.approvalId!, "approve")).toThrow(
      "no longer available",
    );
  });
  it("fails closed when native file approval does not identify the changed files", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      id: 48,
      method: "item/fileChange/requestApproval",
      params: { threadId: "native-session", turnId: "native-turn", itemId: "unknown" },
    });
    await expect(stream.next()).rejects.toThrow("scope is unavailable");
    expect(s.reply).not.toHaveBeenCalled();
  });
  it("creates a new native session after conversation history is cleared", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    await stream.next();
    await stream.return?.();
    const next = s.broker
      .run(
        {
          ...s.input,
          runId: "run-after-clear",
          config: { ...s.input.config, historyGeneration: 1 },
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await next.next();
    expect(s.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
    await next.return?.();
  });
  it("creates a fresh provider session after a runtime configuration generation change", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    await stream.next();
    await stream.return?.();
    const next = s.broker
      .run(
        {
          ...s.input,
          runId: "run-after-switch",
          config: { ...s.input.config, runtimeGeneration: 2 },
          history: "user: previous work",
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await next.next();
    await vi.waitFor(() =>
      expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(2),
    );
    expect(s.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
    expect(s.calls.filter((call) => call.method === "thread/resume")).toHaveLength(0);
    expect(
      s.calls.filter((call) => call.method === "turn/start").at(-1)?.params.input[0].text,
    ).toContain("previous work");
    await next.return?.();
  });
  it("refuses a bare foreign session override without a persisted scoped association", async () => {
    const s = setup();
    const stream = s.broker
      .run({ ...s.input, session: "foreign" }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow("does not belong");
    expect(s.calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(s.calls.some((call) => call.method === "turn/start")).toBe(false);
  });
  it("accounts each model call once and excludes token usage from resumed history", async () => {
    const s = setup();
    const stream = await started(s);
    const usage = (last: number, total: number, turnId = "native-turn") => ({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "native-session",
        turnId,
        tokenUsage: {
          last: { inputTokens: last, outputTokens: 0, totalTokens: last, cachedInputTokens: 0 },
          total: { totalTokens: total },
        },
      },
    });
    s.emit(usage(1000, 1000, "historical-turn"));
    s.emit(usage(100, 1100));
    s.emit(usage(150, 1250));
    s.emit(usage(150, 1250));
    s.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "native-session", turnId: "native-turn", delta: "finished calls" },
    });
    const first = (await stream.next()).value!.event;
    const second = (await stream.next()).value!.event;
    expect(first.type).toBe("usage");
    expect(second.type).toBe("usage");
    if (first.type === "usage" && second.type === "usage")
      expect(first.inputTokens! + second.inputTokens!).toBe(250);
    expect((await stream.next()).value!.event).toEqual({ type: "text", text: "finished calls" });
    await stream.return?.();
  });
  it("never replays turn/start after a lost start response", async () => {
    const s = setup({ loseStart: true });
    const consume = async () => {
      for await (const _ of s.broker.run(s.input, new AbortController().signal)) {
        /* Consume. */
      }
    };
    await expect(consume()).rejects.toThrow("uncertain");
    await expect(consume()).rejects.toThrow("uncertain");
    expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    const competing = s.broker.run(
      { ...s.input, runId: "another-run" },
      new AbortController().signal,
    );
    await expect(competing[Symbol.asyncIterator]().next()).rejects.toThrow("already running");
    brokers.splice(brokers.indexOf(s.broker), 1);
  });
  it("answers an approval at most once even when its response is lost", async () => {
    const s = setup();
    const stream = await started(s);
    s.emit({
      id: 51,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        command: "test-command",
        cwd: root,
      },
    });
    const approval = (await stream.next()).value!;
    s.reply.mockImplementationOnce(() => {
      throw new Error("Lost native response");
    });
    expect(() => s.broker.answer(s.input, approval.approvalId!, "approve")).toThrow(
      "Lost native response",
    );
    s.broker.answer(s.input, approval.approvalId!, "approve");
    expect(() => s.broker.answer(s.input, approval.approvalId!, "reject")).toThrow(
      "already answered",
    );
    expect(s.reply).toHaveBeenCalledExactlyOnceWith(51, { decision: "accept" });
    await stream.return?.();
  });
  it("registers dynamic tools, binds their RPCs, and idempotently replays a lost tool response", async () => {
    const s = setup();
    s.input.tools = [
      { name: "notes_write", description: "Write notes", inputSchema: { type: "object" } },
    ];
    s.input.toolCatalogFingerprint = "catalog-1";
    const stream = await started(s);
    expect(s.calls.find((call) => call.method === "thread/start")?.params.dynamicTools).toEqual([
      { type: "function", ...s.input.tools[0] },
    ]);
    const message = {
      id: "rpc-1",
      method: "item/tool/call",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        callId: "call",
        tool: "notes_write",
        arguments: { text: "hello" },
      },
    };
    s.emit(message);
    const envelope = (await stream.next()).value!;
    expect(envelope.toolCall).toMatchObject({
      callId: "call",
      tool: "notes_write",
      executionId: JSON.stringify(["native-tool", "run-a", "call"]),
    });
    expect(s.reply).not.toHaveBeenCalled();
    s.emit({ ...message, id: "rpc-2" });
    const result = { success: true, contentItems: [{ type: "inputText" as const, text: "saved" }] };
    expect(() => s.broker.toolResult({ ...s.input, runId: "forged" }, "call", result)).toThrow(
      /no longer/,
    );
    expect(() => s.broker.toolResult(s.input, "unknown", result)).toThrow(/binding/);
    s.broker.toolResult(s.input, "call", result);
    expect(s.reply).toHaveBeenCalledWith("rpc-1", result);
    expect(s.reply).toHaveBeenCalledWith("rpc-2", result);
    s.broker.toolResult(s.input, "call", result);
    expect(() => s.broker.toolResult(s.input, "call", { ...result, success: false })).toThrow(
      /already answered/,
    );
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    while (!(await stream.next()).done) {
      /* Drain completion. */
    }
    expect(() => s.broker.toolResult(s.input, "call", result)).not.toThrow();
  });
  it.each(["unknown", "forged-turn"])(
    "fails closed on a %s dynamic tool request",
    async (attack) => {
      const s = setup();
      s.input.tools = [
        { name: "notes_write", description: "Write notes", inputSchema: { type: "object" } },
      ];
      const stream = await started(s);
      s.emit({
        id: "rpc",
        method: "item/tool/call",
        params: {
          threadId: "native-session",
          turnId: attack === "forged-turn" ? "other-turn" : "native-turn",
          callId: "call",
          tool: attack === "unknown" ? "forged" : "notes_write",
          arguments: {},
        },
      });
      await expect(stream.next()).rejects.toThrow(/binding mismatch/);
      expect(s.reply).not.toHaveBeenCalled();
    },
  );
  it("revokes pending application RPCs when host access stops", async () => {
    const s = setup();
    s.input.tools = [{ name: "notes_write", description: "Write notes", inputSchema: {} }];
    const stream = await started(s);
    s.emit({
      id: "rpc",
      method: "item/tool/call",
      params: {
        threadId: "native-session",
        turnId: "native-turn",
        callId: "call",
        tool: "notes_write",
        arguments: {},
      },
    });
    await stream.next();
    await s.broker.close();
    expect(() => s.broker.toolResult(s.input, "call", { contentItems: [], success: true })).toThrow(
      /no longer/,
    );
    expect(s.reply).not.toHaveBeenCalled();
    await stream.return?.();
  });
  it.each(["catalog", "account"])(
    "starts a fresh session with application history after the %s changes",
    async (change) => {
      let account = "first@example.invalid";
      const s = setup({
        requests: {
          "account/read": async () => ({ account: { type: "chatgpt", email: account } }),
        },
      });
      s.input.toolCatalogFingerprint = "catalog-1";
      const stream = await started(s);
      s.emit({
        method: "turn/completed",
        params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
      });
      while (!(await stream.next()).done) {
        /* Drain. */
      }
      if (change === "account") account = "second@example.invalid";
      const next = s.broker
        .run(
          {
            ...s.input,
            runId: "run-b",
            history: "user: previous application context",
            toolCatalogFingerprint: change === "catalog" ? "catalog-2" : "catalog-1",
          },
          new AbortController().signal,
        )
        [Symbol.asyncIterator]();
      await next.next();
      await vi.waitFor(() =>
        expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(2),
      );
      expect(s.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
      expect(s.calls.some((call) => call.method === "thread/resume")).toBe(false);
      expect(
        s.calls.filter((call) => call.method === "turn/start").at(-1)?.params.input[0].text,
      ).toContain("previous application context");
      s.emit({
        method: "turn/completed",
        params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
      });
      while (!(await next.next()).done) {
        /* Drain. */
      }
    },
  );
  it("does not resume a pending native session after its account changes", async () => {
    let account = "first@example.invalid";
    const s = setup({
      requests: { "account/read": async () => ({ account: { type: "chatgpt", email: account } }) },
    });
    const stream = await started(s);
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    while (!(await stream.next()).done) {
      /* Drain. */
    }
    account = "second@example.invalid";
    const next = s.broker
      .run({ ...s.input, runId: "run-b", session: "native-session" }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(next.next()).rejects.toThrow(/does not belong/);
    expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });
  it("normalizes and caches a late explicit steering rejection after terminal completion", async () => {
    const held = deferred<unknown>();
    const s = setup({ requests: { "turn/steer": async () => held.promise } });
    const stream = await started(s);
    const input = {
      ...s.input,
      method: "codexSteer" as const,
      messageId: "steer",
      text: "follow up",
    };
    const task = s.broker.steer(input);
    await vi.waitFor(() => expect(s.calls.some((call) => call.method === "turn/steer")).toBe(true));
    s.emit({
      method: "turn/completed",
      params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } },
    });
    // A received RPC rejection is distinguishable from a transport timeout.
    // Resolve with a rejected promise to keep the deferred helper simple.
    held.resolve(Promise.reject(new CodexRpcError()));
    await expect(task).resolves.toEqual({ accepted: false, reason: "turn-ended" });
    await expect(s.broker.steer(input)).resolves.toEqual({ accepted: false, reason: "turn-ended" });
    while (!(await stream.next()).done) {
      /* Drain. */
    }
    expect(s.calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);
  });
});
