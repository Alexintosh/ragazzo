import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcpClientFactory } from "./acp-client.js";
import { createClaudeClient } from "./claude-client.js";
import { HostCodexBroker } from "./host-codex-broker.js";
import type { HostCodexEvent } from "./host-codex-protocol.js";
import { readNativeProviderConfiguration } from "./native-provider-config.js";
import { NativeWriteScopes } from "./native-write-scope.js";

const executable = vi.hoisted(() => ({ path: "" }));
vi.mock("./codex-executable.js", () => ({
  resolveCodexExecutable: () => ({
    executable: executable.path,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  }),
}));

const binding = { botId: "bot", threadId: "thread", runId: "run" };
describe.each(["claude", "acp"] as const)("%s real stdio protocol conformance", (kind) => {
  let root: string, project: string, broker: HostCodexBroker;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-native-provider-")));
    project = root;
    executable.path = path.join(root, "fixture");
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/native-provider.cjs", import.meta.url)),
      "utf8",
    );
    await writeFile(executable.path, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    broker = new HostCodexBroker(
      path.join(root, "state"),
      kind === "claude"
        ? (onMessage, onExit) => createClaudeClient(onMessage, onExit)
        : createAcpClientFactory({
            command: executable.path,
            args: ["--acp"],
            identity: "fixture-account-generation-1",
          }),
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
  });
  afterEach(async () => {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = (projectPath: string, prompt = "fixture") => ({
    ...binding,
    method: "codexRun" as const,
    nativeKind: kind,
    prompt,
    instructions: "Fixture instructions",
    model: "default",
    after: 0,
    config: {
      computerKey: "computer",
      historyGeneration: 0,
      runtimeGeneration: 0,
      contextScope: "fixture-private-context",
      projectPath,
      permission: "full" as const,
    },
  });
  it("inspects availability without generating a model response", async () => {
    expect(await broker.status()).toMatchObject({
      available: true,
      authenticated: true,
      capabilities: { workspace: false, applicationTools: true, steering: false, resume: true },
    });
  });
  it("round-trips one-action permission decisions and resumes only its owned session", async () => {
    const observed: HostCodexEvent[] = [];
    for await (const event of broker.run(input(project), AbortSignal.timeout(5000))) {
      observed.push(event);
      if (event.approvalId) {
        broker.answer(binding, event.approvalId, "reject");
        broker.answer(binding, event.approvalId, "reject");
        expect(() => broker.answer(binding, event.approvalId!, "approve")).toThrow();
      }
    }
    expect(observed.some((e) => e.event.type === "ask" && e.event.nativeApproval)).toBe(true);
    expect(
      observed
        .filter((e) => e.event.type === "text")
        .map((e) => (e.event.type === "text" ? e.event.text : ""))
        .join(""),
    ).toBe("fixture complete");
    expect(observed.at(-1)?.event.type).toBe("done");
    const session = observed.at(-1)!.session;
    const resumed: HostCodexEvent[] = [];
    for await (const event of broker.run(
      { ...input(project), runId: "second", session },
      AbortSignal.timeout(5000),
    )) {
      resumed.push(event);
      if (event.approvalId)
        broker.answer({ ...binding, runId: "second" }, event.approvalId, "approve");
    }
    expect(resumed.at(-1)?.session).toBe(session);
  });
  it("acknowledges repeated accepted MCP results while the native turn is live", async () => {
    let calls = 0;
    for await (const event of broker.run(
      {
        ...input(project, "application-tool"),
        tools: [
          { name: "test_tool", description: "Fixture tool", inputSchema: { type: "object" } },
        ],
        toolCatalogFingerprint: "fixture",
      },
      AbortSignal.timeout(5000),
    )) {
      if (event.toolCall) {
        calls++;
        const callId = event.toolCall.callId;
        expect(event.toolCall.arguments).toEqual({ value: 7 });
        const response = {
          success: true,
          contentItems: [{ type: "inputText" as const, text: "tool result" }],
        };
        broker.toolResult(binding, callId, response);
        // The process cannot finish between these synchronous calls: this models a
        // lost HTTP acknowledgement while the original provider interaction is live.
        expect(() => broker.toolResult(binding, callId, response)).not.toThrow();
        expect(() => broker.toolResult(binding, callId, { ...response, success: false })).toThrow(
          "already answered",
        );
      }
    }
    expect(calls).toBe(1);
  });
  it.skipIf(kind !== "acp")(
    "collects explicit output links split across ACP text chunks",
    async () => {
      await writeFile(path.join(project, "report.txt"), "fixture report");
      const observed: HostCodexEvent[] = [];
      for await (const event of broker.run(
        input(project, "linked-output"),
        AbortSignal.timeout(5000),
      )) {
        observed.push(event);
        if (event.approvalId) broker.answer(binding, event.approvalId, "approve");
      }
      expect(
        observed
          .filter((event) => event.event.type === "text")
          .map((event) => event.event.type === "text" && event.event.text)
          .join(""),
      ).toBe("[Report](<report.txt>)");
      expect(observed.flatMap((event) => (event.outputFile ? [event.outputFile] : []))).toEqual([
        {
          id: expect.any(String),
          path: "report.txt",
          content: Buffer.from("fixture report").toString("base64"),
        },
      ]);
      expect(observed.at(-1)?.event.type).toBe("done");
    },
  );
  it.skipIf(kind !== "acp")("starts fresh context when ACP cannot load sessions", async () => {
    await broker.close();
    broker = new HostCodexBroker(
      path.join(root, "no-resume-state"),
      createAcpClientFactory({
        command: executable.path,
        args: ["--acp", "--no-resume"],
        identity: "fixture",
      }),
      undefined,
      new NativeWriteScopes(path.join(root, "write-scopes")),
    );
    for (const runId of ["first-no-resume", "second-no-resume"]) {
      let completed = false;
      for await (const event of broker.run(
        { ...input(project), runId },
        AbortSignal.timeout(5000),
      )) {
        if (event.approvalId) broker.answer({ ...binding, runId }, event.approvalId, "approve");
        if (event.event.type === "done") completed = true;
      }
      expect(completed).toBe(true);
    }
  });
  it("fails closed for unverified workspace confinement", async () => {
    const request = input(project);
    await expect(async () => {
      for await (const _ of broker.run(
        { ...request, config: { ...request.config, permission: "workspace" } },
        AbortSignal.timeout(5000),
      )) {
      }
    }).rejects.toThrow();
  });
  it("interrupts only its owned process before a delayed file effect", async () => {
    const stream = broker
      .run(input(project, "hang"), AbortSignal.timeout(5000))
      [Symbol.asyncIterator]();
    await stream.next();
    const next = stream.next();
    await broker.abort(binding);
    await expect(next).rejects.toThrow();
    await stream.return?.();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await expect(readFile(path.join(project, "late-marker"))).rejects.toThrow();
    await broker.stopBot("computer", "run", true);
  });
});

it("reads ACP executable configuration only from a private host-local file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-config-"));
  try {
    const file = path.join(root, "native-providers.json");
    await writeFile(
      file,
      JSON.stringify({
        acp: { command: process.execPath, args: ["agent.cjs"], identity: "fixture-account" },
      }),
      { mode: 0o600 },
    );
    expect((await readNativeProviderConfiguration(root)).acp?.command).toBe(process.execPath);
    await chmod(file, 0o644);
    await expect(readNativeProviderConfiguration(root)).rejects.toThrow("private host-owned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
