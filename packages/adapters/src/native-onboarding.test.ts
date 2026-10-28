import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { CodexTransport } from "./codex-runtime.js";
import {
  CodexAgentRuntime,
  NativeIntroHandoverError,
  readCodexCheckpoint,
} from "./codex-runtime.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { nativeIntroExecutionId } from "./native-context.js";

const profile: ConnectorTool = {
  name: "update_bot",
  description: "Update own profile",
  readOnly: false,
  inputSchema: { type: "object", properties: {} },
};
const write: ConnectorTool = { ...profile, name: "write_file", description: "Write file" };
const input: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  model: { provider: "codex-native", id: "default" },
  prompt: "Ask about purpose",
  instructions: "instructions",
  history: [],
  tools: [profile],
  nativeRuntime: {
    executionTarget: "host",
    permission: "workspace",
    projectPath: "/project",
    computerKey: "computer",
    historyGeneration: 0,
    contextScope: "isolated-intro",
  },
};
async function drain(runtime: CodexAgentRuntime, request: AgentRunRequest) {
  const events = [];
  for await (const event of runtime.run(request)) events.push(event);
  return events;
}
function fixture() {
  const calls: HostComputerRequest[] = [];
  let blob = "";
  let lostRetirement = false;
  let failReadySave: "before" | "after" | undefined;
  const save = async (capture: () => string) => {
    const next = capture();
    if (failReadySave === "before" && JSON.parse(next).introHandover?.phase === "ready") {
      failReadySave = undefined;
      throw new Error("crash before ready commit");
    }
    blob = next;
    if (failReadySave === "after" && JSON.parse(next).introHandover?.phase === "ready") {
      failReadySave = undefined;
      throw new Error("lost ready commit acknowledgement");
    }
  };
  const transport: CodexTransport = {
    async *request<T>(request: HostComputerRequest) {
      calls.push(request);
      if (request.method === "codexRetire") {
        if (lostRetirement) {
          lostRetirement = false;
          throw new Error("lost cleanup acknowledgement");
        }
        yield { cleanupVerified: true } as T;
      } else if (request.method === "codexRunContextScoped") {
        const child = request.runId !== "run";
        yield {
          sequence: 1,
          session: child ? "child-session" : "intro-session",
          approvalId: child ? "child-question" : "intro-question",
          event: {
            type: "ask",
            text: child ? "Another question?" : "What should I do?",
            executionId: child ? "child-question" : "intro-question",
          },
        } as T;
      } else yield null as T;
    },
  };
  const runtime = new CodexAgentRuntime(transport);
  return {
    calls,
    runtime,
    checkpoint: () => blob,
    intro: () => drain(runtime, { ...input, onCheckpoint: save }),
    resume: (overrides: Partial<AgentRunRequest> = {}) =>
      drain(runtime, {
        ...input,
        tools: [profile, write],
        turnCheckpoint: blob,
        onCheckpoint: save,
        nativeRuntime: { ...input.nativeRuntime!, introAnswer: "Write the requested file." },
        ...overrides,
      }),
    loseRetirement: () => {
      lostRetirement = true;
    },
    failReady: (when: "before" | "after") => {
      failReadySave = when;
    },
  };
}

describe("native intro catalog handover", () => {
  it("keeps the catalog guard unless a trusted persisted intro answer authorizes retirement", async () => {
    const f = fixture();
    await f.intro();
    expect(f.calls[0]).toMatchObject({ tools: [expect.objectContaining({ name: "update_bot" })] });
    const count = f.calls.length;
    await expect(f.resume({ nativeRuntime: input.nativeRuntime })).rejects.toThrow(
      "catalog changed",
    );
    expect(f.calls).toHaveLength(count);
    await f.resume();
    expect(f.calls[count]).toMatchObject({
      method: "codexRetire",
      runId: "run",
      computerKey: "computer",
    });
    expect(f.calls[count + 1]).toMatchObject({
      method: "codexRunContextScoped",
      runId: nativeIntroExecutionId("run"),
      after: 0,
      config: { applicationRunId: "run", contextScope: "isolated-intro" },
      prompt: "Write the requested file.",
      session: undefined,
      tools: [
        expect.objectContaining({ name: "update_bot" }),
        expect.objectContaining({ name: "write_file" }),
      ],
    });
    expect(f.calls.some((call) => call.method === "codexAnswer")).toBe(false);
    expect(readCodexCheckpoint(f.checkpoint())).toMatchObject({
      introHandover: { applicationRunId: "run", phase: "ready" },
      runId: nativeIntroExecutionId("run"),
    });
  });

  it("retries lost retirement acknowledgements without new provider work or generic command cancellation", async () => {
    const f = fixture();
    await f.intro();
    f.loseRetirement();
    await expect(f.resume()).rejects.toBeInstanceOf(NativeIntroHandoverError);
    expect(readCodexCheckpoint(f.checkpoint())).toMatchObject({
      runId: "run",
      introHandover: { phase: "stopping", answer: "Write the requested file." },
    });
    expect(f.calls.filter((call) => call.method.startsWith("codexRun"))).toHaveLength(1);
    await f.resume();
    expect(f.calls.filter((call) => call.method === "codexRetire")).toHaveLength(2);
    expect(f.calls.filter((call) => call.method.startsWith("codexRun"))).toHaveLength(2);
    expect(
      f.calls.some((call) => call.method === "cancelRunWork" || call.method === "codexAbort"),
    ).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "recovers a crash %s the atomic child checkpoint commit",
    async (when) => {
      const f = fixture();
      await f.intro();
      f.failReady(when);
      await expect(f.resume()).rejects.toBeInstanceOf(NativeIntroHandoverError);
      expect(f.calls.some((call) => call.method === "codexAbort")).toBe(false);
      expect(f.calls.filter((call) => call.method.startsWith("codexRun"))).toHaveLength(1);
      await f.resume();
      expect(f.calls.filter((call) => call.method === "codexRetire")).toHaveLength(
        when === "before" ? 2 : 1,
      );
      expect(f.calls.filter((call) => call.method.startsWith("codexRun"))).toHaveLength(2);
      expect(readCodexCheckpoint(f.checkpoint()).runId).toBe(nativeIntroExecutionId("run"));
    },
  );

  it.each(["context", "parent", "tools"] as const)(
    "rejects changed %s on ready child recovery",
    async (change) => {
      const f = fixture();
      await f.intro();
      await f.resume();
      const count = f.calls.length;
      await expect(
        f.resume(
          change === "context"
            ? {
                nativeRuntime: { ...input.nativeRuntime!, contextScope: "channel-b" },
              }
            : change === "parent"
              ? { runId: "another-application-run" }
              : { tools: [profile] },
        ),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(count);
    },
  );

  it("replays a child question after a crash before its ask card rather than reusing the intro answer", async () => {
    const f = fixture();
    await f.intro();
    await f.resume();
    const child = readCodexCheckpoint(f.checkpoint());
    expect(child.approvalId).toBe("child-question");
    const count = f.calls.length;
    await f.resume({ resumeToolResult: undefined });
    expect(f.calls.slice(count)).toEqual([
      expect.objectContaining({
        method: "codexRunContextScoped",
        runId: nativeIntroExecutionId("run"),
        after: 0,
        session: "child-session",
      }),
    ]);
  });
});
