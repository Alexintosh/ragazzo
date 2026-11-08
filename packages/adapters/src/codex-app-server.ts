import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { resolveCodexExecutable } from "./codex-executable.js";

export interface CodexMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: unknown;
}
/** A received provider rejection is distinct from a lost/uncertain transport response. */
export class CodexRpcError extends Error {
  constructor() {
    super("Native Codex request rejected");
  }
}

/** Narrow process boundary, injectable for deterministic offline tests. */
export interface CodexClient {
  request(method: string, params: unknown): Promise<any>;
  reply(id: number | string, result: unknown): void;
  notify(method: string, params?: unknown): void;
  close(): void;
}
export type CodexClientFactory = (
  onMessage: (message: CodexMessage) => void,
  onExit: () => void,
  options?: { cwd?: string },
) => CodexClient;

/** Own a fresh stdio process. Never attach to a user's existing daemon or process. */
export const createCodexClient: CodexClientFactory = (onMessage, onExit, options) =>
  createResolvedCodexClient(onMessage, onExit, undefined, options);
export const createCodexClientFactory =
  (managedRoot: string): CodexClientFactory =>
  (onMessage, onExit, options) =>
    createResolvedCodexClient(onMessage, onExit, managedRoot, options);
function createResolvedCodexClient(
  onMessage: Parameters<CodexClientFactory>[0],
  onExit: Parameters<CodexClientFactory>[1],
  managedRoot?: string,
  options?: { cwd?: string },
): CodexClient {
  const resolved = resolveCodexExecutable({ managedRoot });
  const child: ChildProcessWithoutNullStreams = spawn(
    resolved.executable,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: resolved.env,
      cwd: options?.cwd,
    },
  );
  // Provider stderr may contain account information; it is intentionally never forwarded.
  child.stderr.resume();
  const pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 0;
  let closed = false;
  const write = (message: unknown) => {
    if (closed) throw new Error("Native Codex disconnected");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const decoder = new TextDecoder();
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffered) > 12 * 1024 * 1024) {
      close();
      return;
    }
    try {
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const message = JSON.parse(buffered.slice(0, newline)) as CodexMessage;
        buffered = buffered.slice(newline + 1);
        if (typeof message.id === "number" && !message.method && pending.has(message.id)) {
          const waiter = pending.get(message.id)!;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new CodexRpcError());
          else waiter.resolve(message.result);
        } else onMessage(message);
        newline = buffered.indexOf("\n");
      }
    } catch {
      close();
    }
  });
  function exited() {
    if (closed) return;
    // The app-server may have spawned tools; reap its owned group on unexpected exit too.
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Native Codex disconnected"));
    }
    pending.clear();
    onExit();
  }
  function close() {
    if (closed) return;
    // Negative PID targets only the process group created by this adapter.
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* The process may already have exited. */
    }
    exited();
    child.stdout.destroy();
  }
  child.on("exit", exited);
  child.on("error", exited);
  child.stdin.on("error", () => close());
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Native Codex response uncertain; do not retry the turn"));
        }, 30_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          write({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    reply(id, result) {
      write({ id, result });
    },
    notify(method, params) {
      write({ method, ...(params === undefined ? {} : { params }) });
    },
    close,
  };
}

export async function initializeCodex(client: CodexClient) {
  const result = await client.request("initialize", {
    clientInfo: { name: "rakazo", title: "Rakazo", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
  return result;
}

/** Config tables merge: an empty table does not disable the user's configured MCP servers. */
export async function nativeCodexThreadConfig(
  client: CodexClient,
  cwd: string,
  readResult?: { config?: Record<string, unknown> },
) {
  const result = readResult ?? (await client.request("config/read", { includeLayers: false, cwd }));
  if (!result?.config || typeof result.config !== "object" || Array.isArray(result.config))
    throw new Error("Native Codex configuration is unavailable");
  const servers = result.config.mcp_servers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers))
    throw new Error("Native Codex MCP configuration is invalid");
  return {
    mcp_servers: Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }])),
    "features.apps": false,
    "features.plugins": false,
  };
}
