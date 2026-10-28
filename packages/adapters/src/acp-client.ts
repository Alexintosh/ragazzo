import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { cwd as hostCwd } from "node:process";
import type { CodexClientFactory, CodexMessage } from "./codex-app-server.js";
import { CodexRpcError } from "./codex-app-server.js";
import { NativeMcpServer } from "./native-mcp-server.js";
import { NativeProcess } from "./native-process.js";
import { hostCommandEnvironment } from "./sandbox-command-environment.js";

/** Set only by the host operator. Never accepted from an API, renderer or bot. */
export interface AcpHostConfiguration {
  command: string;
  args: string[];
  /** Rotate whenever the logged-in account or provider settings change. No credentials. */
  identity: string;
}
export function validateAcpConfiguration(config: AcpHostConfiguration) {
  if (
    !path.isAbsolute(config.command) ||
    !config.identity ||
    config.identity.length > 256 ||
    !Array.isArray(config.args) ||
    config.args.length > 128 ||
    config.args.some((arg) => typeof arg !== "string" || arg.length > 8192)
  )
    throw new Error("Invalid host-local ACP configuration");
  accessSync(config.command, constants.X_OK);
  if (!statSync(config.command).isFile()) throw new Error("ACP command must be an executable file");
  return config;
}

/** ACP v1 JSON-RPC normalized into the broker's internal session/turn vocabulary. */
export function createAcpClientFactory(configuration: AcpHostConfiguration): CodexClientFactory {
  const config = validateAcpConfiguration(configuration);
  return (onMessage, onExit) => {
    let session = "",
      turn = "",
      cwd = "",
      instructions = "",
      terminal = false;
    let assistantText = "";
    let capabilities: any;
    let initialized: any;
    let loading = false;
    let mcp: NativeMcpServer | undefined;
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    const approvals = new Map<string | number, { allow?: string; reject?: string }>();
    const emit = (method: string, params: Record<string, any>) =>
      onMessage({ method, params: { threadId: session, turnId: turn, ...params } });
    const complete = (status: string) => {
      if (terminal) return;
      terminal = true;
      if (assistantText)
        emit("item/completed", { item: { type: "agentMessage", text: assistantText } });
      assistantText = "";
      emit("turn/completed", { turn: { id: turn, status } });
    };
    const process = new NativeProcess(
      config.command,
      config.args,
      { env: hostCommandEnvironment({}) },
      (message) => {
        if (message.jsonrpc !== "2.0") throw new Error("Invalid ACP JSON-RPC envelope");
        if (typeof message.id === "number" && !message.method && pending.has(message.id)) {
          const waiter = pending.get(message.id)!;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new CodexRpcError());
          else waiter.resolve(message.result);
          return;
        }
        const p = message.params;
        if (message.method === "session/update") {
          if (loading || p?.sessionId !== session || !turn || terminal) return;
          const u = p.update;
          if (
            u?.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text" &&
            typeof u.content.text === "string"
          ) {
            assistantText += u.content.text;
            emit("item/agentMessage/delta", { delta: u.content.text });
          } else if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update")
            emit("item/started", {
              item: { id: u.toolCallId, type: "commandExecution", command: u.title, cwd },
            });
          return;
        }
        if (message.id !== undefined && message.method) {
          if (
            message.method !== "session/request_permission" ||
            p?.sessionId !== session ||
            !turn ||
            terminal
          ) {
            process.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unsupported client capability" },
            });
            return;
          }
          const allow = p.options?.find((option: any) => option.kind === "allow_once")?.optionId;
          const reject = p.options?.find((option: any) => option.kind === "reject_once")?.optionId;
          const subject = p.toolCall;
          if (
            typeof allow !== "string" ||
            typeof reject !== "string" ||
            typeof subject?.title !== "string" ||
            !subject.title ||
            JSON.stringify(subject).length > 32768
          ) {
            process.write({
              jsonrpc: "2.0",
              id: message.id,
              result: { outcome: { outcome: "cancelled" } },
            });
            return;
          }
          approvals.set(message.id, { allow, reject });
          const notification: CodexMessage = {
            id: message.id,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: session,
              turnId: turn,
              command: `${subject.title}\n${JSON.stringify(subject.rawInput ?? subject.content ?? subject.locations ?? {})}`,
              cwd,
            },
          };
          onMessage(notification);
        }
      },
      () => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("ACP disconnected"));
        }
        pending.clear();
        onExit();
      },
    );
    const rpc = (method: string, params: unknown, timeout = 30_000): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("ACP response outcome is uncertain"));
        }, timeout);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          process.write({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    return {
      async request(method, params: any) {
        if (method === "initialize") {
          initialized = await rpc("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "rakazo", version: "0.1.0" },
            clientCapabilities: {},
          });
          if (initialized?.protocolVersion !== 1) throw new Error("ACP v1 is required");
          capabilities = initialized.agentCapabilities ?? {};
          return {
            nativeCapabilities: {
              workspace: false,
              images: capabilities.promptCapabilities?.image === true,
              applicationTools: capabilities.mcpCapabilities?.http === true,
              steering: false,
              resume: capabilities.loadSession === true,
            },
          };
        }
        if (method === "account/read") {
          // initialize advertises login methods, not current authentication. A session
          // creation is the standard non-generation operation that proves access.
          try {
            const probe = await rpc("session/new", { cwd: hostCwd(), mcpServers: [] });
            if (typeof probe?.sessionId !== "string" || !probe.sessionId) return {};
            if (capabilities.sessionCapabilities?.close)
              await rpc("session/close", { sessionId: probe.sessionId });
            return {
              canResume: capabilities.loadSession === true,
              account: {
                type: "acp",
                identity: createHash("sha256")
                  .update(JSON.stringify([config.command, config.args, config.identity]))
                  .digest("hex"),
              },
            };
          } catch {
            return {};
          }
        }
        if (method === "config/read") return { config: {} };
        if (method === "thread/start" || method === "thread/resume") {
          if (params.sandbox !== "danger-full-access")
            throw new Error(
              "ACP does not guarantee workspace confinement; choose Full access explicitly",
            );
          let mcpServers: unknown[] = [];
          if (params.dynamicTools?.length) {
            if (!capabilities.mcpCapabilities?.http)
              throw new Error("ACP agent does not support HTTP MCP application tools");
            mcp = new NativeMcpServer(params.dynamicTools, (id, tool, args) => {
              onMessage({
                id,
                method: "item/tool/call",
                params: { threadId: session, turnId: turn, callId: id, tool, arguments: args },
              });
            });
            mcpServers = [await mcp.start()];
          }
          cwd = params.cwd;
          instructions = params.developerInstructions;
          loading = true;
          try {
            if (method === "thread/resume") {
              if (!capabilities.loadSession)
                throw new Error("ACP agent does not support session resume");
              await rpc("session/load", { sessionId: params.threadId, cwd, mcpServers });
              session = params.threadId;
            } else session = (await rpc("session/new", { cwd, mcpServers }))?.sessionId;
          } finally {
            loading = false;
          }
          if (typeof session !== "string" || !session) throw new Error("ACP returned no session");
          return { thread: { id: session } };
        }
        if (method === "thread/backgroundTerminals/clean") {
          if (terminal) {
            mcp?.close();
            await process.cleanup();
          }
          return {};
        }
        if (method === "thread/backgroundTerminals/list") return { data: [] };
        if (method === "turn/start") {
          if (turn) throw new Error("ACP turn already submitted");
          const prompt = params.input.map((item: any) => {
            if (item.type === "text") return { type: "text", text: item.text };
            if (item.type === "image" && capabilities.promptCapabilities?.image) {
              const match = /^data:(image\/[^;]+);base64,(.*)$/.exec(item.url);
              if (match) return { type: "image", mimeType: match[1], data: match[2] };
            }
            throw new Error("ACP agent does not support this input capability");
          });
          if (instructions)
            prompt.unshift({ type: "text", text: `Application instructions:\n${instructions}` });
          turn = randomUUID();
          void rpc("session/prompt", { sessionId: session, prompt }, 24 * 60 * 60_000).then(
            (result) => complete(result?.stopReason === "end_turn" ? "completed" : "failed"),
            () => complete("failed"),
          );
          return { turn: { id: turn } };
        }
        if (method === "turn/interrupt") {
          process.write({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: session },
          });
          await process.cleanup();
          complete("interrupted");
          return {};
        }
        if (method === "turn/steer") throw new CodexRpcError();
        throw new Error("Unsupported ACP operation");
      },
      reply(id, result: any) {
        if (result?.contentItems) {
          mcp?.reply(id, result);
          return;
        }
        const approval = approvals.get(id);
        if (!approval) throw new Error("ACP permission binding mismatch");
        approvals.delete(id);
        process.write({
          jsonrpc: "2.0",
          id,
          result: {
            outcome: {
              outcome: "selected",
              optionId: result.decision === "accept" ? approval.allow : approval.reject,
            },
          },
        });
      },
      notify() {},
      close() {
        mcp?.close();
        process.close();
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("ACP closed"));
        }
        pending.clear();
      },
    };
  };
}
