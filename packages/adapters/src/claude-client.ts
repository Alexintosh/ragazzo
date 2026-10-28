import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CodexClient, CodexClientFactory, CodexMessage } from "./codex-app-server.js";
import { CodexRpcError } from "./codex-app-server.js";
import { resolveCodexExecutable } from "./codex-executable.js";
import { NativeProcess } from "./native-process.js";

const execute = promisify(execFile);
/** Structured authentication inspection; never forwards account details to UI. */
export async function claudeAccount(options: { managedRoot?: string } = {}) {
  const resolved = resolveCodexExecutable({ ...options, name: "claude" });
  const result = await execute(resolved.executable, ["auth", "status", "--json"], {
    env: resolved.env,
    timeout: 10_000,
    maxBuffer: 65536,
  }).catch((error) => {
    if (typeof error.stdout === "string" && error.stdout.trim().startsWith("{"))
      return { stdout: error.stdout };
    throw new Error("Claude authentication status is unavailable");
  });
  const auth = JSON.parse(result.stdout);
  return auth.loggedIn === true
    ? {
        type: "claude",
        method: auth.authMethod,
        account: {
          email: auth.email ?? null,
          organization: auth.orgId ?? null,
          apiKeySource: auth.apiKeySource ?? null,
          // An API-key source is not an account identifier. Without an attested
          // identity, start fresh context rather than resume across unknown accounts.
          unidentifiedGeneration: auth.email || auth.orgId ? undefined : randomUUID(),
        },
      }
    : undefined;
}

/** Claude Code's supported streaming SDK control channel, normalized for shared supervision. */
export function createClaudeClient(
  onMessage: (message: CodexMessage) => void,
  onExit: () => void,
  diagnostic?: (event: { type: string; subtype?: string }) => void,
  options: { managedRoot?: string } = {},
): CodexClient {
  let child: NativeProcess | undefined;
  let session = "",
    turn = "",
    cwd = "",
    terminal = false,
    streamed = false;
  let failureCode: string | undefined;
  let closed = false;
  const acceptedToolReplies = new Map<string | number, string>();
  let tools: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  const controls = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const replies = new Map<
    string | number,
    { type: "permission" | "question" | "tool"; input?: any; mcpId?: string | number }
  >();
  const emit = (method: string, params: Record<string, any>) =>
    onMessage({ method, params: { threadId: session, turnId: turn, ...params } });
  const response = (id: string | number, value: unknown) =>
    child!.write({
      type: "control_response",
      response: { subtype: "success", request_id: id, response: value },
    });
  const control = (request: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        controls.delete(id);
        reject(new Error("Claude control response is uncertain"));
      }, 30_000);
      timer.unref();
      controls.set(id, { resolve, reject, timer });
      try {
        child!.write({ type: "control_request", request_id: id, request });
      } catch (error) {
        controls.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  const mcp = (id: string | number, message: any) => {
    const envelope = (result: unknown) =>
      response(id, { mcp_response: { jsonrpc: "2.0", id: message.id, result } });
    if (message.method === "initialize")
      envelope({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "rakazo", version: "0.1.0" },
        capabilities: { tools: {} },
      });
    else if (message.method === "tools/list") envelope({ tools });
    else if (
      message.method === "tools/call" &&
      typeof message.params?.name === "string" &&
      tools.some((tool) => tool.name === message.params.name) &&
      turn &&
      !terminal
    ) {
      replies.set(id, { type: "tool", mcpId: message.id });
      onMessage({
        id,
        method: "item/tool/call",
        params: {
          threadId: session,
          turnId: turn,
          callId: String(message.id),
          tool: message.params.name,
          arguments: message.params.arguments ?? {},
        },
      });
    } else if (!message.method || message.method.startsWith("notifications/")) envelope({});
    else
      response(id, {
        mcp_response: {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported tool operation" },
        },
      });
  };
  const receive = (message: any) => {
    diagnostic?.({
      type: String(message.type),
      subtype: message.type === "control_request" ? message.request?.subtype : message.subtype,
    });
    if (message.type === "control_response") {
      const r = message.response;
      const waiter = controls.get(r?.request_id);
      if (waiter) {
        controls.delete(r.request_id);
        clearTimeout(waiter.timer);
        if (r.subtype === "error") waiter.reject(new CodexRpcError());
        else waiter.resolve(r.response);
      }
      return;
    }
    if (message.type === "control_request") {
      const r = message.request;
      if (r?.subtype === "mcp_message" && r.server_name === "rakazo") {
        mcp(message.request_id, r.message);
        return;
      }
      if (
        r?.subtype !== "can_use_tool" ||
        !turn ||
        terminal ||
        !r.input ||
        typeof r.input !== "object"
      ) {
        response(message.request_id, { behavior: "deny", message: "Unsupported interaction" });
        return;
      }
      if (
        r.input.run_in_background ||
        r.tool_name === "Task" ||
        r.tool_name === "Agent" ||
        r.tool_name === "Monitor"
      ) {
        response(message.request_id, {
          behavior: "deny",
          message: "Background work is unavailable for this run",
        });
        return;
      }
      if (r.tool_name === "AskUserQuestion") {
        const questions = r.input.questions;
        if (!Array.isArray(questions) || !questions.length || questions.length > 20) {
          response(message.request_id, { behavior: "deny", message: "Invalid questions" });
          return;
        }
        replies.set(message.request_id, { type: "question", input: r.input });
        onMessage({
          id: message.request_id,
          method: "item/tool/requestUserInput",
          params: {
            threadId: session,
            turnId: turn,
            questions: questions.map((q: any, index: number) => ({
              id: String(index),
              question: q.question,
              options: q.options,
              isSecret: q.isSecret === true,
            })),
          },
        });
      } else {
        const detail = JSON.stringify(r.input);
        if (detail.length > 16000) {
          response(message.request_id, {
            behavior: "deny",
            message: "Tool scope exceeds the approval display limit",
          });
          return;
        }
        replies.set(message.request_id, { type: "permission", input: r.input });
        onMessage({
          id: message.request_id,
          method: "item/commandExecution/requestApproval",
          params: { threadId: session, turnId: turn, command: `${r.tool_name}: ${detail}`, cwd },
        });
      }
      return;
    }
    if (!turn || terminal) return;
    if (message.session_id && message.session_id !== session)
      throw new Error("Claude session binding mismatch");
    if (
      message.type === "stream_event" &&
      message.event?.type === "content_block_delta" &&
      message.event.delta?.type === "text_delta"
    ) {
      streamed = true;
      emit("item/agentMessage/delta", { delta: message.event.delta.text });
    }
    if (message.type === "assistant") {
      if (
        [
          "authentication_failed",
          "billing_error",
          "rate_limit",
          "invalid_request",
          "server_error",
          "unknown",
        ].includes(message.error)
      )
        failureCode = message.error;
      const text = (message.message?.content ?? [])
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text)
        .join("");
      if (!streamed && text) emit("item/agentMessage/delta", { delta: text });
      if (text) emit("item/completed", { item: { type: "agentMessage", text } });
      streamed = false;
    }
    if (message.type === "result") {
      const usage = message.usage;
      if (usage) {
        const last = {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
        };
        emit("thread/tokenUsage/updated", {
          tokenUsage: { last, total: { ...last, turn } },
          nativeProvider: "anthropic",
          usageSource: "claude-stream-json",
        });
      }
      terminal = true;
      emit("turn/completed", {
        turn: {
          id: turn,
          status: message.subtype === "success" && !message.is_error ? "completed" : "failed",
        },
        failureCode: failureCode ?? (message.is_error ? "provider-error" : undefined),
      });
    }
  };
  return {
    async request(method, params: any) {
      if (method === "initialize")
        return {
          nativeCapabilities: {
            workspace: false,
            images: true,
            applicationTools: true,
            steering: false,
            resume: true,
          },
        };
      if (method === "account/read") return { account: await claudeAccount(options) };
      if (method === "config/read") return { config: {} };
      if (method === "thread/start" || method === "thread/resume") {
        // Claude's Bash sandbox does not confine file tools or inherited hooks. Do not
        // promise a workspace boundary the standard protocol cannot attest.
        if (params.sandbox !== "danger-full-access")
          throw new Error(
            "Claude Code workspace confinement cannot be verified; choose Full access explicitly",
          );
        const resolved = resolveCodexExecutable({ ...options, name: "claude" });
        cwd = params.cwd;
        session = method === "thread/resume" ? params.threadId : randomUUID();
        tools = params.dynamicTools ?? [];
        const args = [
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--permission-prompt-tool",
          "stdio",
          "--permission-mode",
          "default",
          "--setting-sources",
          "",
          "--settings",
          JSON.stringify({
            disableAllHooks: true,
            enableAllProjectMcpServers: false,
            enabledPlugins: {},
          }),
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify({
            mcpServers: tools.length ? { rakazo: { type: "sdk", name: "rakazo" } } : {},
          }),
          "--no-chrome",
          "--disable-slash-commands",
          "--disallowedTools",
          "Agent,Task,Monitor",
          "--append-system-prompt",
          params.developerInstructions ?? "",
          method === "thread/resume" ? "--resume" : "--session-id",
          session,
        ];
        if (params.model) args.push("--model", params.model);
        child = new NativeProcess(
          resolved.executable,
          args,
          { cwd, env: resolved.env },
          receive,
          () => {
            closed = true;
            replies.clear();
            acceptedToolReplies.clear();
            onExit();
          },
        );
        await control({ subtype: "initialize", sdkMcpServers: tools.length ? ["rakazo"] : [] });
        return { thread: { id: session } };
      }
      if (method === "thread/backgroundTerminals/clean") {
        if (terminal) await child?.cleanup();
        return {};
      }
      if (method === "thread/backgroundTerminals/list") return { data: [] };
      if (method === "turn/start") {
        if (turn) throw new Error("Claude turn already submitted");
        const content = params.input.map((item: any) => {
          if (item.type === "text") return { type: "text", text: item.text };
          const match = /^data:(image\/[^;]+);base64,(.*)$/.exec(item.url ?? "");
          if (item.type === "image" && match)
            return {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            };
          throw new Error("Unsupported Claude input");
        });
        turn = randomUUID();
        child!.write({
          type: "user",
          uuid: turn,
          session_id: session,
          parent_tool_use_id: null,
          message: { role: "user", content },
        });
        return { turn: { id: turn } };
      }
      // stream-json user messages have no per-message accepted acknowledgement. A queued
      // follow-up is honest; treating stdin.write as accepted steering would lose messages.
      if (method === "turn/steer") throw new CodexRpcError();
      if (method === "turn/interrupt") {
        await child?.cleanup();
        terminal = true;
        emit("turn/completed", { turn: { id: turn, status: "interrupted" } });
        return {};
      }
      throw new Error("Unsupported Claude operation");
    },
    reply(id, result: any) {
      if (closed || terminal || !turn) throw new Error("Claude interaction is no longer available");
      const signature = createHash("sha256").update(JSON.stringify(result)).digest("hex");
      const accepted = acceptedToolReplies.get(id);
      if (accepted !== undefined) {
        if (accepted !== signature) throw new Error("Claude interaction already answered");
        return;
      }
      const pending = replies.get(id);
      if (!pending) throw new Error("Claude interaction binding mismatch");
      if (pending.type === "tool") {
        if (acceptedToolReplies.size >= 256) throw new Error("Claude tool reply limit exceeded");
        response(id, {
          mcp_response: {
            jsonrpc: "2.0",
            id: pending.mcpId,
            result: {
              isError: !result.success,
              content: result.contentItems.map((item: any) =>
                item.type === "inputText"
                  ? { type: "text", text: item.text }
                  : (() => {
                      const match = /^data:([^;]+);base64,(.*)$/.exec(item.imageUrl);
                      return match
                        ? { type: "image", mimeType: match[1], data: match[2] }
                        : { type: "text", text: "Image output unavailable" };
                    })(),
              ),
            },
          },
        });
        acceptedToolReplies.set(id, signature);
      } else if (pending.type === "question") {
        const answers: Record<string, string> = {};
        for (const [index, q] of pending.input.questions.entries())
          answers[q.question] = result.answers?.[String(index)]?.answers?.join("\n") ?? "";
        response(id, { behavior: "allow", updatedInput: { ...pending.input, answers } });
      } else
        response(
          id,
          result.decision === "accept"
            ? { behavior: "allow", updatedInput: pending.input }
            : { behavior: "deny", message: "The user rejected this action" },
        );
      replies.delete(id);
    },
    notify() {},
    close() {
      closed = true;
      replies.clear();
      acceptedToolReplies.clear();
      child?.close();
      for (const waiter of controls.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Claude closed"));
      }
      controls.clear();
    },
  };
}

export function createClaudeClientFactory(managedRoot: string): CodexClientFactory {
  return (onMessage, onExit) => createClaudeClient(onMessage, onExit, undefined, { managedRoot });
}
