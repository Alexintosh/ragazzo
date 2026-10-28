import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeProcessTree } from "./desktop-process-tree.js";
import { windowsProcessTree } from "./desktop-process-tree.js";

export interface HostBrowserConnection {
  call<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<T>;
  close(): Promise<void>;
  onEvent?(
    listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void,
  ): () => void;
}

/** Chrome's private debugging pipe never opens a port or exposes a debugger URL. */
export class HostBrowserPipe implements HostBrowserConnection {
  private nextId = 0;
  private buffered = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  private closed = false;
  private stopping?: Promise<void>;
  private readonly listeners = new Set<
    (method: string, params: Record<string, unknown>, sessionId?: string) => void
  >();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly stop: () => Promise<void>,
    private readonly graceful = false,
  ) {
    output.on("data", (chunk: Buffer) => this.receive(chunk));
    output.on("error", () => this.fail(new Error("Managed browser connection failed")));
    output.on("end", () => this.fail(new Error("Managed browser connection closed")));
    input.on("error", () => this.fail(new Error("Managed browser connection failed")));
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("Managed browser is closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(new Error("Managed browser operation cancelled"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error("Managed browser operation timed out"));
      }, 30_000);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  private receive(chunk: Buffer) {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    // Screenshots are bounded by the fixed viewport. Refuse unbounded protocol responses.
    if (this.buffered.length > 24 * 1024 * 1024) {
      this.fail(new Error("Managed browser response too large"));
      return;
    }
    while (this.buffered.includes(0)) {
      const boundary = this.buffered.indexOf(0);
      const raw = this.buffered.subarray(0, boundary);
      this.buffered = this.buffered.subarray(boundary + 1);
      if (!raw.length) continue;
      try {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.method) {
          for (const listener of this.listeners)
            listener(message.method, message.params ?? {}, message.sessionId);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        // Protocol diagnostics may echo page expressions and saved login values.
        if (message.error) pending.reject(new Error("Managed browser operation failed"));
        else pending.resolve(message.result ?? {});
      } catch {
        this.fail(new Error("Invalid managed browser response"));
        return;
      }
    }
  }

  private fail(error: Error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.stopping ??= this.stop();
    void this.stopping.catch(() => undefined);
  }

  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    if (this.graceful && !this.closed) await this.call("Browser.close").catch(() => undefined);
    this.fail(new Error("Managed browser is closed"));
    try {
      await this.stopping;
    } catch (error) {
      this.stopping = undefined;
      throw error;
    }
    this.listeners.clear();
  }
}

export async function findHostBrowserExecutable(): Promise<string> {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  for (const executable of candidates) {
    try {
      await access(executable);
      return executable;
    } catch {
      /* Try another installed browser. */
    }
  }
  throw new Error("Install Chrome or Chromium to use the managed host browser");
}

async function stopChild(child: ChildProcess, tree?: NativeProcessTree) {
  if (tree) {
    tree.kill();
    for (let attempt = 0; attempt < 30 && tree.alive(); attempt++) await delay(100);
    if (tree.alive()) throw new Error("Managed browser process cleanup could not be verified");
    tree.close();
    return;
  }
  const pid = child.pid;
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (kind: NodeJS.Signals) => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, kind);
    } catch {
      /* Already stopped. */
    }
  };
  for (let attempt = 0; attempt < 5 && alive(); attempt++) await delay(100);
  if (!alive()) return;
  // A dedicated process group contains only this owned Chrome and its descendants.
  signal("SIGTERM");
  for (let attempt = 0; attempt < 30 && alive(); attempt++) await delay(100);
  if (alive()) signal("SIGKILL");
  for (let attempt = 0; attempt < 30 && alive(); attempt++) await delay(100);
  if (alive()) throw new Error("Managed browser process cleanup could not be verified");
}

// Delay Chrome startup until its Windows Job owns the wrapper. The private CDP
// pipe descriptors pass straight through; no renderer or shell sees them.
const WINDOWS_BROWSER_WRAPPER = `
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { executable, args } = JSON.parse(input);
  const child = spawn(executable, args, {stdio:['ignore','ignore','ignore',3,4],windowsHide:true,shell:false});
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
});
`;

export async function launchHostBrowser(
  profile: string,
  executablePath?: string,
): Promise<HostBrowserConnection> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const executable = executablePath ?? (await findHostBrowserExecutable());
  const args = [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-extensions",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--window-size=1280,800",
    "--password-store=basic",
    "about:blank",
  ];
  const windows = process.platform === "win32";
  const child = spawn(
    windows ? process.execPath : executable,
    windows ? ["-e", WINDOWS_BROWSER_WRAPPER] : args,
    {
      stdio: [windows ? "pipe" : "ignore", "ignore", "ignore", "pipe", "pipe"],
      ...(windows ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } } : {}),
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("Could not start the installed managed browser")));
  });
  let tree: NativeProcessTree | undefined;
  if (process.platform === "win32" && child.pid) {
    try {
      tree = windowsProcessTree(child.pid);
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(JSON.stringify({ executable, args }));
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  const connection = new HostBrowserPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable,
    () => stopChild(child, tree),
    true,
  );
  try {
    await connection.call("Browser.getVersion");
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}
