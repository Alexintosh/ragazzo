import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import type { CodexTransport } from "./codex-runtime.js";
import { CodexAgentRuntime, HostCodexTransport } from "./codex-runtime.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { NativeToolBridge } from "./native-tool-bridge.js";

const tool: ConnectorTool = {
  name: "notes.write",
  description: "Write a note",
  readOnly: false,
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  route: { connectorId: "installed", resourceId: "notes", toolName: "write", resourceRevision: 1 },
};
const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "task",
  instructions: "instructions",
  history: [],
  tools: [tool],
  model: { provider: "codex-native", id: "default" },
  nativeRuntime: {
    executionTarget: "host",
    permission: "workspace",
    projectPath: "/project",
    computerKey: "computer",
    historyGeneration: 0,
  },
};
const call = {
  callId: "call",
  tool: "notes_write",
  arguments: { text: "hello" },
  executionId: JSON.stringify(["native-tool", "run", "call"]),
};
async function drain(runtime: CodexAgentRuntime, input: AgentRunRequest) {
  const events = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}
afterEach(() => vi.unstubAllGlobals());
describe("native application tool bridge", () => {
  it("exposes stable schemas, retains private routes, and omits runtime-owned callbacks", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const bridge = new NativeToolBridge({
      ...request,
      executeTool,
      tools: [
        tool,
        ...["ask_user", "request_takeover", "run_subagent"].map((name) => ({ ...tool, name })),
      ],
    });
    expect(bridge.catalog).toEqual([
      { name: "notes_write", description: tool.description, inputSchema: expect.any(Object) },
    ]);
    expect(JSON.stringify(bridge.catalog)).not.toContain("connectorId");
    expect(await bridge.execute(call, new AbortController().signal)).toMatchObject({
      paused: false,
      response: { success: true },
    });
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      tool.name,
      call.arguments,
      call.executionId,
      tool.route,
    );
    expect(
      new NativeToolBridge({
        ...request,
        tools: [{ ...tool, route: { ...tool.route!, resourceRevision: 2 } }],
      }).fingerprint,
    ).not.toBe(bridge.fingerprint);
  });
  it("forwards a computer screenshot to the native runtime as an image input", async () => {
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [
        { type: "text", text: "Managed browser observed" },
        { type: "image", mimeType: "image/jpeg", data: "AQID" },
      ],
      details: { frameId: "frame", width: 1280, height: 800 },
    }));
    const bridge = new NativeToolBridge({
      ...request,
      tools: [
        {
          name: "computer_observe",
          description: "Observe the computer",
          readOnly: true,
          inputSchema: { type: "object", properties: {} },
        },
      ],
      executeTool,
    });
    const result = await bridge.execute(
      { ...call, tool: "computer_observe", arguments: {} },
      new AbortController().signal,
    );
    expect(result).toEqual({
      paused: false,
      response: {
        success: true,
        contentItems: [
          { type: "inputText", text: "Managed browser observed" },
          { type: "inputImage", imageUrl: "data:image/jpeg;base64,AQID" },
        ],
      },
    });
  });

  it("rejects unknown tools and invalid arguments before dispatch", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const bridge = new NativeToolBridge({ ...request, executeTool });
    await expect(
      bridge.execute({ ...call, tool: "unknown" }, new AbortController().signal),
    ).rejects.toThrow(/unavailable/);
    expect(
      await bridge.execute({ ...call, arguments: { text: 1 } }, new AbortController().signal),
    ).toMatchObject({ paused: false, response: { success: false } });
    expect(executeTool).not.toHaveBeenCalled();
  });
  it.each(["approve", "reject"])(
    "leaves a gated tool pending and replays %s through the same executor identity",
    async (decision) => {
      const inputs: HostComputerRequest[] = [];
      const transport: CodexTransport = {
        async *request<T>(input: HostComputerRequest) {
          inputs.push(input);
          if (input.method === "codexRun") {
            if (input.after === 0)
              yield {
                sequence: 1,
                session: "session",
                toolCall: call,
                event: { type: "progress", text: "Using a tool" },
              } as T;
            else yield { sequence: 2, event: { type: "done" } } as T;
          } else yield null as T;
        },
      };
      let saved = "";
      const executeTool = vi
        .fn()
        .mockResolvedValueOnce(approvalPausedToolResult())
        .mockResolvedValueOnce(decision === "approve" ? { ok: true } : { error: "Rejected" });
      const onToolCompleted = vi.fn();
      const input = {
        ...request,
        executeTool,
        onToolCompleted,
        onCheckpoint: async (capture: () => string) => {
          saved = capture();
        },
      };
      const runtime = new CodexAgentRuntime(transport);
      const paused = await drain(runtime, input);
      expect(paused.at(-1)?.type).toBe("checkpoint");
      expect(JSON.parse(saved)).toMatchObject({ pendingToolCall: call });
      expect(
        inputs.some((item) => item.method === "codexToolResult" || item.method === "codexAbort"),
      ).toBe(false);
      const resumed = await drain(runtime, {
        ...input,
        turnCheckpoint: saved,
        resumeToolResult: { content: [{ type: "text", text: decision }] },
      });
      expect(resumed.at(-1)?.type).toBe("done");
      expect(executeTool.mock.calls.map((args) => args[2])).toEqual([
        call.executionId,
        call.executionId,
      ]);
      expect(inputs.some((item) => item.method === "codexAnswer")).toBe(false);
      expect(inputs.find((item) => item.method === "codexToolResult")).toMatchObject({
        callId: "call",
        response: { success: decision === "approve" },
      });
      expect(onToolCompleted).toHaveBeenCalledTimes(2);
    },
  );
  it("resends a durable tool response after a lost acknowledgement without executing again", async () => {
    const inputs: HostComputerRequest[] = [];
    let lost = true;
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        inputs.push(input);
        if (input.method === "codexRun") {
          if (!input.after)
            yield { sequence: 1, toolCall: call, event: { type: "progress", text: "Tool" } } as T;
          else yield { sequence: 2, event: { type: "done" } } as T;
        } else if (input.method === "codexToolResult" && lost) {
          lost = false;
          throw new Error("lost acknowledgement");
        } else yield null as T;
      },
    };
    let saved = "";
    const executeTool = vi.fn(async () => ({ written: true }));
    const input = {
      ...request,
      executeTool,
      onCheckpoint: async (capture: () => string) => {
        saved = capture();
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    await expect(drain(runtime, input)).rejects.toThrow("lost acknowledgement");
    expect(JSON.parse(saved).pendingToolCall.response.success).toBe(true);
    await drain(runtime, { ...input, turnCheckpoint: saved });
    expect(executeTool).toHaveBeenCalledOnce();
    const replies = inputs.filter((item) => item.method === "codexToolResult");
    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual(replies[1]);
    expect(inputs.some((item) => item.method === "codexAbort")).toBe(false);
  });
  it("refuses a changed catalog during a paused tool and forged provider execution identity", async () => {
    let saved = "";
    const executeTool = vi.fn(async () => approvalPausedToolResult());
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        if (input.method === "codexRun")
          yield { sequence: 1, toolCall: call, event: { type: "progress", text: "Tool" } } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    await drain(runtime, {
      ...request,
      executeTool,
      onCheckpoint: async (capture) => {
        saved = capture();
      },
    });
    await expect(drain(runtime, { ...request, tools: [], turnCheckpoint: saved })).rejects.toThrow(
      /catalog changed/,
    );
    const forged: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        if (input.method === "codexRun")
          yield {
            sequence: 1,
            toolCall: { ...call, executionId: "forged" },
            event: { type: "progress", text: "Tool" },
          } as T;
      },
    };
    await expect(drain(new CodexAgentRuntime(forged), { ...request, executeTool })).rejects.toThrow(
      /binding mismatch/,
    );
    expect(executeTool).toHaveBeenCalledOnce();
  });
  it("does not deliver a tool response after run revocation", async () => {
    const controller = new AbortController();
    const inputs: HostComputerRequest[] = [];
    const transport: CodexTransport = {
      async *request<T>(input: HostComputerRequest) {
        inputs.push(input);
        if (input.method === "codexRun")
          yield { sequence: 1, toolCall: call, event: { type: "progress", text: "Tool" } } as T;
      },
    };
    const runtime = new CodexAgentRuntime(transport);
    const executeTool = vi.fn(async () => {
      controller.abort();
      return { ok: true };
    });
    await expect(
      (async () => {
        for await (const _ of runtime.run(
          { ...request, executeTool },
          { signal: controller.signal },
        )) {
          /* Drain. */
        }
      })(),
    ).rejects.toThrow();
    expect(inputs.some((item) => item.method === "codexToolResult")).toBe(false);
    expect(inputs.some((item) => item.method === "codexAbort")).toBe(true);
  });
  it("drains the real authenticated host transport after the runtime emits done", async () => {
    const encoder = new TextEncoder();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ value: { sequence: 1, event: { type: "done" } } }) +
                  "\n" +
                  JSON.stringify({ done: true }) +
                  "\n",
              ),
            );
            controller.close();
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const events = await drain(
      new CodexAgentRuntime(new HostCodexTransport("http://localhost:1234", "test-token")),
      { ...request, tools: [] },
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
