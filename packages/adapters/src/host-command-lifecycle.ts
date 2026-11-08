import { createHash, randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readSetupFile, setupDirectory, writeSetupFile } from "./native-setup-paths.js";

const cancelled = () => new Error("Local computer run cancelled");
const uncertain = () => new Error("Local computer command cleanup uncertain");
type Pending = { key: string; abort: () => void; done: Promise<void> };

/** Host-owned tombstones and journals contain no commands, credentials, or PIDs.
 * An orphan journal blocks cleanup; a restart never guesses which process to kill.
 */
export class HostCommandLifecycle {
  private readonly cancelled = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly root: string) {}

  private key(computerKey: string, runId: string) {
    return createHash("sha256")
      .update(JSON.stringify([computerKey, runId]))
      .digest("hex");
  }
  private directory(key: string) {
    return setupDirectory(this.root, "host-command-lifecycle", key);
  }
  private async check(key: string, signal: AbortSignal) {
    const directory = await this.directory(key);
    try {
      await readSetupFile(path.join(directory, "cancelled.json"));
      this.cancelled.add(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.cancelled.has(key) || signal.aborted) throw cancelled();
    return directory;
  }
  private async unresolved(key: string) {
    for (const name of await readdir(await this.directory(key))) {
      if (name === "cancelled.json") continue;
      if (!this.pending.has(name)) throw uncertain();
    }
  }

  async begin(computerKey: string, runId: string, signal: AbortSignal, abort: () => void) {
    if (this.pending.size >= 256) throw new Error("Too many local commands");
    const key = this.key(computerKey, runId);
    const id = `${randomUUID()}.work`;
    let resolve!: () => void;
    const done = new Promise<void>((finished) => {
      resolve = finished;
    });
    this.pending.set(id, { key, abort, done });
    let journal: string | undefined;
    try {
      const directory = await this.check(key, signal);
      await this.unresolved(key);
      journal = path.join(directory, id);
      await writeSetupFile(journal, { version: 1 });
      await this.check(key, signal);
    } catch (error) {
      if (journal) await unlink(journal).catch(() => undefined);
      this.pending.delete(id);
      resolve();
      throw error;
    }
    return {
      stopped: () => this.cancelled.has(key) || signal.aborted,
      check: () => this.check(key, signal),
      // Keep the journal on any uncertain process/guard teardown, even if the
      // request itself has already failed or its HTTP connection has disappeared.
      finish: async (cleanupVerified: boolean) => {
        try {
          if (cleanupVerified) await unlink(journal!);
        } finally {
          this.pending.delete(id);
          resolve();
        }
      },
    };
  }

  async fence(computerKey: string, runId: string) {
    const key = this.key(computerKey, runId);
    // Gate synchronously, then persist before stopping owned effects. Requests
    // waiting on a write scope also observe this gate through stopped().
    this.cancelled.add(key);
    const directory = await this.directory(key);
    try {
      await writeSetupFile(path.join(directory, "cancelled.json"), { version: 1 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readSetupFile(path.join(directory, "cancelled.json"));
    }
    for (const pending of this.pending.values()) if (pending.key === key) pending.abort();
  }

  async drain(computerKey: string, runId: string) {
    const key = this.key(computerKey, runId);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(
          [...this.pending.values()]
            .filter((pending) => pending.key === key)
            .map((pending) => pending.done),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(uncertain()), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await this.unresolved(key);
  }
}
