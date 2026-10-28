import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { CodexTransport } from "./codex-runtime.js";
import { CodexAgentRuntime, readCodexCheckpoint } from "./codex-runtime.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { HOST_COMPUTER_MAX_BYTES, hostComputerRequest } from "./host-computer-protocol.js";

const request: AgentRunRequest = {
  botId: "bot-a",
  threadId: "thread-a",
  runId: "run-a",
  prompt: "task",
  instructions: "instructions",
  history: [],
  tools: [],
  model: { provider: "codex-native", id: "default" },
  nativeRuntime: {
    executionTarget: "host",
    permission: "workspace",
    projectPath: "/project",
    computerKey: "host-workspace",
    historyGeneration: 0,
  },
};
const binding = { botId: "bot-a", threadId: "thread-a", runId: "run-a" };
describe("native Codex runtime", () => {
  it.each(["codex", "claude", "acp"] as const)(
    "advertises direct image input only for supported native transport (%s)",
    (kind) => {
      const runtime = new CodexAgentRuntime({ async *request() {} }, kind);
      expect(runtime.describe().capabilities.images).toBe(kind === "codex" ? true : undefined);
    },
  );
  it("persists exact model and effort across checkpoint recovery and requires host support", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(hostComputerRequest.parse(input));
        yield {
          sequence: 1,
          session: "session",
          event: { type: "progress", text: "Working" },
        } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    let checkpoint = "";
    const selected = {
      ...request,
      model: { provider: "codex-native", id: "chosen-model", thinkingLevel: "ultra" as const },
    };
    for await (const _event of runtime.run({
      ...selected,
      async onCheckpoint(capture) {
        checkpoint = capture();
      },
    })) {
    }
    expect(calls[0]).toMatchObject({
      method: "codexRunModelSettings",
      model: "chosen-model",
      thinkingLevel: "ultra",
    });
    expect(JSON.parse(checkpoint)).toMatchObject({ model: "chosen-model", thinkingLevel: "ultra" });
    calls.length = 0;
    for await (const _event of runtime.run({ ...request, turnCheckpoint: checkpoint })) {
    }
    expect(calls[0]).toMatchObject({
      method: "codexRunModelSettings",
      model: "chosen-model",
      thinkingLevel: "ultra",
    });
  });
  it.each(["codex", "claude", "acp"] as const)(
    "binds %s recovery and the host request to authorized context",
    async (kind) => {
      const calls: HostComputerRequest[] = [];
      const transport: CodexTransport = {
        async *request<T>(input: HostComputerRequest) {
          calls.push(hostComputerRequest.parse(input));
          if (input.method === "codexRunContextScoped")
            yield {
              sequence: 1,
              session: "scope-session",
              event: { type: "progress", text: "Working" },
            } as T;
        },
      };
      const runtime = new CodexAgentRuntime(transport, kind);
      const scoped = {
        ...request,
        nativeRuntime: { ...request.nativeRuntime!, contextScope: "channel-a" },
      };
      let checkpoint = "";
      for await (const event of runtime.run({
        ...scoped,
        onCheckpoint: async (capture) => {
          checkpoint = capture();
        },
      })) {
        if (event.type === "checkpoint") checkpoint = event.blob;
      }
      expect(readCodexCheckpoint(checkpoint)).toMatchObject({
        contextScope: "channel-a",
        session: "scope-session",
        after: 1,
      });
      expect(calls[0]).toMatchObject({
        method: "codexRunContextScoped",
        ...(kind !== "codex" ? { nativeKind: kind } : {}),
        config: { contextScope: "channel-a" },
      });
      calls.length = 0;
      for await (const _event of runtime.run({ ...scoped, turnCheckpoint: checkpoint })) {
      }
      expect(calls[0]).toMatchObject({
        method: "codexRunContextScoped",
        config: { contextScope: "channel-a" },
        session: "scope-session",
        after: 1,
      });
      for (const contextScope of [undefined, "channel-b"]) {
        calls.length = 0;
        await expect(
          (async () => {
            for await (const _event of runtime.run({
              ...request,
              nativeRuntime: { ...request.nativeRuntime!, contextScope },
              turnCheckpoint: checkpoint,
            })) {
            }
          })(),
        ).rejects.toThrow("checkpoint binding mismatch");
        expect(calls).toEqual([]);
      }
      const legacy = JSON.stringify({ ...JSON.parse(checkpoint), contextScope: undefined });
      await expect(
        (async () => {
          for await (const _event of runtime.run({ ...scoped, turnCheckpoint: legacy })) {
          }
        })(),
      ).rejects.toThrow("checkpoint binding mismatch");
      expect(
        hostComputerRequest.safeParse({
          ...calls[0],
          ...binding,
          method: "codexRunContextScoped",
          config: request.nativeRuntime,
          prompt: "task",
          instructions: "instructions",
          model: "default",
        }).success,
      ).toBe(false);
    },
  );
  it("uses a fail-closed scoped method and binds scope into resumable checkpoints", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRunScoped") yield { sequence: 1, event: { type: "done" } } as T;
      },
    };
    let checkpoint = "";
    for await (const _event of new CodexAgentRuntime(transport).run({
      ...request,
      nativeRuntime: { ...request.nativeRuntime!, writeSubdirectory: "left" },
      async onCheckpoint(capture) {
        checkpoint = capture();
      },
    })) {
    }
    expect(calls[0]).toMatchObject({
      method: "codexRunScoped",
      config: { writeSubdirectory: "left" },
    });
    expect(readCodexCheckpoint(checkpoint).writeSubdirectory).toBe("left");
    await expect(
      (async () => {
        for await (const _event of new CodexAgentRuntime(transport).run({
          ...request,
          turnCheckpoint: checkpoint,
          nativeRuntime: { ...request.nativeRuntime!, writeSubdirectory: "right" },
        })) {
        }
      })(),
    ).rejects.toThrow("checkpoint binding mismatch");
  });
  it("defers every unsubmitted follow-up without aborting a completed native turn", async () => {
    let began!: () => void;
    const steeringBegan = new Promise<void>((resolve) => {
      began = resolve;
    });
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedDone!: () => void;
    const done = new Promise<void>((resolve) => {
      observedDone = resolve;
    });
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest, context: AdapterContext) {
        calls.push(input);
        if (input.method === "codexRun") {
          yield { sequence: 1, event: { type: "progress", text: "Working" } } as T;
          await steeringBegan;
          observedDone();
          yield { sequence: 2, event: { type: "done" } } as T;
        } else if (input.method === "codexSteer") {
          began();
          await response;
          expect(context.signal.aborted).toBe(false);
          yield { accepted: false, reason: "turn-ended" } as T;
        }
      },
    };
    const deferSteering = vi.fn(async () => undefined);
    const claimSteering = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "late-1", messageId: "m1", text: "first" },
        { id: "late-2", messageId: "m2", text: "second" },
      ]);
    const running = (async () => {
      for await (const event of new CodexAgentRuntime(transport).run({
        ...request,
        claimSteering,
        deferSteering,
      }))
        if (event.type === "done") observedDone();
    })();
    await done;
    release();
    await running;
    expect(deferSteering).toHaveBeenCalledExactlyOnceWith(["late-1", "late-2"]);
    expect(calls.filter((call) => call.method === "codexSteer")).toHaveLength(1);
    expect(calls.some((call) => call.method === "codexAbort")).toBe(false);
  });
  it.each([8, 10])(
    "falls back to materialized files for a %s MiB image before native submission",
    async (mebibytes) => {
      const calls: HostComputerRequest[] = [];
      const transport: CodexTransport = {
        async *request<T>(input: HostComputerRequest) {
          calls.push(input);
          expect(hostComputerRequest.safeParse(input).success).toBe(true);
          expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(HOST_COMPUTER_MAX_BYTES);
          if (input.method === "codexRun") yield { sequence: 1, event: { type: "done" } } as T;
        },
      };
      for await (const _ of new CodexAgentRuntime(transport).run({
        ...request,
        currentTurnImages: [
          {
            name: "large.png",
            mimeType: "image/png",
            data: new Uint8Array(mebibytes * 1024 * 1024),
          },
        ],
      })) {
        /* Drain. */
      }
      expect(calls[0]).toMatchObject({
        images: [],
        imageFallback: expect.stringContaining("large.png"),
      });
    },
  );
  it("applies the aggregate image budget to live steering and keeps the active turn healthy", async () => {
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        expect(hostComputerRequest.safeParse(input).success).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(HOST_COMPUTER_MAX_BYTES);
        if (input.method === "codexRun") {
          yield { sequence: 1, event: { type: "progress", text: "Working" } } as T;
          await finished;
          yield { sequence: 2, event: { type: "done" } } as T;
        } else if (input.method === "codexSteer") yield { accepted: true } as T;
      },
    };
    const images = ["first.png", "second.png"].map((name) => ({
      name,
      mimeType: "image/png" as const,
      data: new Uint8Array(5 * 1024 * 1024),
    }));
    const claimSteering = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "images", messageId: "m", text: "Compare attached images", images },
      ])
      .mockResolvedValue([]);
    for await (const _ of new CodexAgentRuntime(transport).run({
      ...request,
      claimSteering,
      onCheckpoint: async (capture) => {
        if (JSON.parse(capture()).steeringIds?.includes("images")) complete();
      },
    })) {
      /* Drain. */
    }
    const input = calls.find((call) => call.method === "codexSteer");
    expect(input).toMatchObject({
      imageFallback: expect.stringContaining("second.png"),
      images: [expect.any(String)],
    });
    expect(calls.some((call) => call.method === "codexAbort")).toBe(false);
  });
  it("submits live steering while the native stream is quiet and persists acknowledged ids", async () => {
    const calls: HostComputerRequest[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const saved: string[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRun") {
          yield { sequence: 1, event: { type: "progress", text: "Working" } } as T;
          await completed;
          yield { sequence: 2, event: { type: "done" } } as T;
        } else if (input.method === "codexSteer") yield { accepted: true } as T;
      },
    };
    const claimSteering = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "s1",
          messageId: "m1",
          text: "Use blue",
          images: [{ name: "image.png", mimeType: "image/png", data: new Uint8Array([1]) }],
        },
      ])
      .mockResolvedValue([]);
    const runtime = new CodexAgentRuntime(transport);
    const running = (async () => {
      for await (const _ of runtime.run({
        ...request,
        currentTurnImages: [
          { name: "initial.png", mimeType: "image/png", data: new Uint8Array([2]) },
        ],
        claimSteering,
        onCheckpoint: async (capture) => {
          saved.push(capture());
          if (JSON.parse(capture()).steeringIds?.includes("s1")) finish();
        },
      })) {
        /* Drain. */
      }
    })();
    await running;
    expect(calls.find((call) => call.method === "codexRun")).toMatchObject({
      images: ["data:image/png;base64,Ag=="],
    });
    expect(calls.find((call) => call.method === "codexSteer")).toMatchObject({
      messageId: "s1",
      text: "Use blue",
      images: ["data:image/png;base64,AQ=="],
    });
    expect(JSON.parse(saved.at(-1)!)).toMatchObject({ steeringIds: ["s1"] });
  });
  it("awaits file publication before advancing the native checkpoint", async () => {
    const published = vi.fn(async () => undefined);
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        if (input.method === "codexRun")
          yield {
            sequence: 1,
            event: { type: "progress", text: "Created a file" },
            outputFile: { id: "file-1", path: "report.txt", content: "aGk=" },
          } as T;
      },
    };
    for await (const event of new CodexAgentRuntime(transport).run({
      ...request,
      onOutputFile: published,
    })) {
      if (event.type === "checkpoint") expect(published).toHaveBeenCalledOnce();
    }
    expect(published).toHaveBeenCalledWith({
      id: "file-1",
      path: "report.txt",
      bytes: Buffer.from("hi"),
    });
  });
  it("replays an approval after a crash between cursor persistence and ask commit", async () => {
    const calls: HostComputerRequest[] = [];
    const ask = {
      type: "ask",
      executionId: "approval",
      text: "Approve this command?",
      actions: [{ id: "approve", label: "Approve" }],
    };
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRun")
          yield { sequence: 1, approvalId: "approval", event: ask } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    let blob = "";
    for await (const event of runtime.run(request))
      if (event.type === "checkpoint") blob = event.blob;
    calls.length = 0;
    const restored: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({
      ...request,
      prompt: "new clock text",
      turnCheckpoint: blob,
    }))
      restored.push(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "codexRun", after: 0, prompt: "task" });
    expect(restored.at(-1)).toEqual(ask);
    expect(calls.some((call) => call.method === "codexAnswer")).toBe(false);
  });
  it("awaits the durable initial checkpoint before dispatching native work", async () => {
    let saved = false;
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        if (input.method !== "codexRun") return;
        expect(saved).toBe(true);
        yield { sequence: 1, event: { type: "done" } } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    for await (const _ of runtime.run({
      ...request,
      onCheckpoint: async (capture, executionId) => {
        expect(executionId).toBe("native-start");
        expect(readCodexCheckpoint(capture()).prompt).toBe("task");
        await Promise.resolve();
        saved = true;
      },
    })) {
      /* Drain. */
    }
    expect(saved).toBe(true);
  });
  it("consumes queued input once at start and keeps the same prompt across approval resume", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method !== "codexRun") return;
        yield (
          input.after === 0
            ? {
                sequence: 1,
                approvalId: "approval",
                event: { type: "ask", executionId: "approval", text: "Approve?" },
              }
            : { sequence: 2, event: { type: "done" } }
        ) as T;
      },
    };
    const claimSteering = vi.fn().mockResolvedValue([
      { id: "q2", messageId: "m2", text: "second" },
      { id: "q1", messageId: "m1", text: "edited first" },
    ]);
    const runtime = new CodexAgentRuntime(transport);
    let blob = "";
    for await (const event of runtime.run({
      ...request,
      claimSteering,
      history: [{ id: "m1", role: "user", content: "old first" }],
    }))
      if (event.type === "checkpoint") blob = event.blob;
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith([], true);
    expect(calls[0]).toMatchObject({
      prompt: "task\n\nAdditional user context:\nsecond\nedited first",
      history: "",
    });
    for await (const _ of runtime.run({
      ...request,
      claimSteering,
      turnCheckpoint: blob,
      resumeToolResult: { content: [{ type: "text", text: "approve" }] },
    })) {
      /* Drain. */
    }
    expect(claimSteering).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toMatchObject({
      prompt: "task\n\nAdditional user context:\nsecond\nedited first",
    });
  });
  it("persists the provider approval cursor and resumes the original native run with an exact answer", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRun") {
          if (input.after === 0)
            yield {
              sequence: 1,
              session: "native-session",
              approvalId: "approval-id",
              event: {
                type: "ask",
                executionId: "approval-id",
                text: "Approve?",
                actions: [{ id: "approve", label: "Approve" }],
              },
            } as T;
          else yield { sequence: 2, session: "native-session", event: { type: "done" } } as T;
        } else yield null as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    const checkpoint = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({ ...request, onCheckpoint: checkpoint }))
      events.push(event);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint.mock.calls[0]![1]).toBe("native-start");
    expect(checkpoint.mock.calls[1]![1]).toBe("approval-id");
    const blob = checkpoint.mock.calls[1]![0]();
    expect(readCodexCheckpoint(blob)).toMatchObject({
      ...binding,
      after: 1,
      approvalId: "approval-id",
      session: "native-session",
    });
    expect(events.map((event) => event.type)).toEqual(["checkpoint", "ask"]);
    const resumed: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({
      ...request,
      runId: "continuation",
      turnCheckpoint: blob,
      resumeToolResult: { content: [{ type: "text", text: "reject" }] },
    }))
      resumed.push(event);
    expect(calls[1]).toEqual({
      method: "codexAnswer",
      ...binding,
      approvalId: "approval-id",
      answer: "reject",
    });
    expect(calls[2]).toMatchObject({
      method: "codexRun",
      ...binding,
      after: 1,
      session: "native-session",
    });
    expect(resumed.at(-1)?.type).toBe("done");
    expect(calls.filter((call) => call.method === "codexAbort")).toEqual([]);
    const before = calls.length;
    await expect(async () => {
      for await (const _ of runtime.run({ ...request, botId: "foreign", turnCheckpoint: blob })) {
        /* Consume. */
      }
    }).rejects.toThrow("binding mismatch");
    expect(calls).toHaveLength(before);
  });
  it("aborts owned native work using a fresh authenticated request when the lease signal dies", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest, context: AdapterContext) {
        calls.push(input);
        if (input.method === "codexRun") {
          yield { sequence: 1, event: { type: "progress", text: "working" } } as T;
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          context.signal.throwIfAborted();
        } else {
          expect(context.signal.aborted).toBe(false);
          yield null as T;
        }
      },
    };
    const controller = new AbortController();
    const runtime = new CodexAgentRuntime(transport);
    const stream = runtime.run(request, { signal: controller.signal })[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    const waiting = stream.next();
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(calls.filter((call) => call.method === "codexAbort")).toEqual([
      { method: "codexAbort", ...binding },
    ]);
  });
  it.each(["transport", "malformed response", "usage persistence"])(
    "aborts host work when %s fails after the run starts",
    async (failure) => {
      const calls: HostComputerRequest[] = [];
      const controller = new AbortController();
      const error = new Error("run failed");
      const transport: CodexTransport = {
        async *request<T>(input: HostComputerRequest, context: AdapterContext) {
          calls.push(input);
          if (input.method === "codexRun") {
            yield { sequence: 1, event: { type: "progress", text: "working" } } as T;
            if (failure === "transport") throw error;
            if (failure === "malformed response") yield { sequence: 2 } as T;
            else
              yield {
                sequence: 2,
                event: {
                  type: "usage",
                  provider: "openai-codex",
                  model: "default",
                  inputTokens: 100,
                  outputTokens: 25,
                },
              } as T;
          } else {
            expect(context.signal).not.toBe(controller.signal);
            expect(context.signal.aborted).toBe(false);
            yield null as T;
          }
        },
      };
      const runtime = new CodexAgentRuntime(transport);
      const consume = async () => {
        for await (const _ of runtime.run(
          { ...request, onUsage: async () => Promise.reject(error) },
          { signal: controller.signal },
        )) {
          /* Consume until the failure. */
        }
      };
      if (failure === "malformed response") await expect(consume()).rejects.toThrow();
      else await expect(consume()).rejects.toBe(error);
      await runtime.abort(request.runId);
      expect(calls.filter((call) => call.method === "codexAbort")).toEqual([
        { method: "codexAbort", ...binding },
      ]);
    },
  );
  it("preserves the original failure when host abort also fails", async () => {
    const error = new Error("run failed");
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        if (input.method === "codexRun") {
          yield { sequence: 1, event: { type: "progress", text: "working" } } as T;
          throw error;
        }
        throw new Error("abort failed");
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    await expect(async () => {
      for await (const _ of runtime.run(request)) {
        /* Consume. */
      }
    }).rejects.toBe(error);
  });
  it("does not abort or remove a replacement owner when an earlier iterator returns", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRun")
          yield { sequence: 1, event: { type: "progress", text: "working" } } as T;
        else yield null as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    const controller = new AbortController();
    const original = runtime.run(request, { signal: controller.signal })[Symbol.asyncIterator]();
    await original.next();
    const replacement = runtime.run(request)[Symbol.asyncIterator]();
    await replacement.next();
    controller.abort();
    await original.return?.();
    expect(calls.filter((call) => call.method === "codexAbort")).toEqual([]);
    await replacement.return?.();
    expect(calls.filter((call) => call.method === "codexAbort")).toEqual([
      { method: "codexAbort", ...binding },
    ]);
  });
  it("rejects unsupported targets and permissions before contacting the host", async () => {
    const transport: CodexTransport = { request: vi.fn() };
    const runtime = new CodexAgentRuntime(transport);
    await expect(async () => {
      for await (const _ of runtime.run({ ...request, nativeRuntime: undefined })) {
        /* Consume. */
      }
    }).rejects.toThrow("explicit host");
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("accounts usage before yielding a resumable cursor even if the consumer cancels", async () => {
    const onUsage = vi.fn();
    const calls: HostComputerRequest[] = [];
    const controller = new AbortController();
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest, context: AdapterContext) {
        calls.push(input);
        if (input.method === "codexAbort") {
          expect(context.signal).not.toBe(controller.signal);
          expect(context.signal.aborted).toBe(false);
          yield null as T;
          return;
        }
        yield {
          sequence: 1,
          event: {
            type: "usage",
            provider: "openai-codex",
            model: "default",
            inputTokens: 100,
            outputTokens: 25,
          },
        } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    const stream = runtime
      .run({ ...request, onUsage }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe("checkpoint");
    expect(onUsage).toHaveBeenCalledTimes(1);
    await stream.return?.();
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "codexAbort")).toEqual([
      { method: "codexAbort", ...binding },
    ]);
  });
});

describe.each(["claude", "acp"] as const)("%s shared runtime checkpoints", (kind) => {
  it("pins engine identity on the transport and rejects a checkpoint from another engine", async () => {
    const calls: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        calls.push(input);
        if (input.method === "codexRun")
          yield {
            sequence: 1,
            session: "session",
            event: { type: "ask", text: "Allow?", executionId: "approval", nativeApproval: true },
            approvalId: "approval",
          } as T;
      },
    };
    let checkpoint = "";
    const runtime = new CodexAgentRuntime(transport, kind);
    for await (const event of runtime.run({
      ...request,
      nativeRuntime: { ...request.nativeRuntime!, permission: "full" },
    }))
      if (event.type === "checkpoint") checkpoint = event.blob;
    expect(calls[0]).toMatchObject({ nativeKind: kind, method: "codexRun" });
    expect(readCodexCheckpoint(checkpoint).runtime).toBe(kind);
    await expect(async () => {
      for await (const _ of new CodexAgentRuntime(
        transport,
        kind === "claude" ? "acp" : "claude",
      ).run({
        ...request,
        nativeRuntime: { ...request.nativeRuntime!, permission: "full" },
        turnCheckpoint: checkpoint,
      })) {
      }
    }).rejects.toThrow("binding mismatch");
    await runtime.abort(request.runId);
  });
});
