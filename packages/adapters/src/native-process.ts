import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

/** A fresh, owned process group; stderr and environment never cross the host boundary. */
export class NativeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private stopped = false;
  private exited = false;
  private cleanupFailure?: Error;
  private readonly exitWait: Promise<void>;
  constructor(
    command: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
    onMessage: (value: any) => void,
    onExit: () => void,
  ) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Native process supervision requires macOS or Linux");
    this.child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.exitWait = new Promise((resolve) => {
      const exit = () => {
        if (this.exited) return;
        this.exited = true;
        if (!this.stopped) this.kill();
        resolve();
        if (!this.stopped) onExit();
      };
      this.child.once("exit", exit);
      this.child.once("error", exit);
    });
    let buffer = "";
    const decoder = new TextDecoder();
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) {
        this.close();
        onExit();
        return;
      }
      try {
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) onMessage(JSON.parse(line));
          newline = buffer.indexOf("\n");
        }
      } catch {
        this.close();
        onExit();
      }
    });
    this.child.stdin.on("error", () => {
      this.close();
      onExit();
    });
  }
  write(value: unknown) {
    if (this.stopped || this.exited || this.child.stdin.writableLength > 12 * 1024 * 1024)
      throw new Error("Native provider disconnected");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private kill() {
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        this.cleanupFailure = new Error("Native process cleanup is uncertain");
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.kill();
  }
  async cleanup() {
    this.close();
    if (this.cleanupFailure) throw this.cleanupFailure;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exitWait,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native process cleanup is uncertain")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.cleanupFailure) throw this.cleanupFailure;
    // Reaping the leader alone does not prove its ordinary child commands exited.
    // Check only the process group we created; never inspect or kill unrelated PIDs.
    const deadline = Date.now() + 1500;
    while (this.child.pid) {
      try {
        process.kill(-this.child.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw new Error("Native process cleanup is uncertain");
      }
      if (Date.now() >= deadline) throw new Error("Native process cleanup is uncertain");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
