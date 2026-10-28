import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { NativeSetupKind, NativeSetupView } from "@rakazo/contracts";
import { resolveCodexExecutable } from "./codex-executable.js";
import { acquireSetupProviderLock } from "./native-setup-lock.js";
import {
  managedNativeEnvironment,
  managedNativeExecutable,
  readSetupFile,
  setupDirectory,
  writeSetupFile,
} from "./native-setup-paths.js";
import type { NativeSetupHostRequest } from "./native-setup-protocol.js";

type Session = NonNullable<NativeSetupView["session"]> & {
  kind: NativeSetupKind;
  scopeKey: string;
  registrationId: string | null;
  digest: string;
  env: NodeJS.ProcessEnv;
  child?: ChildProcess;
  settled?: Promise<void>;
  journal: string;
  starting?: Promise<void>;
  releaseLock?: () => Promise<void>;
  cleanupUncertain?: boolean;
  cleanup?: Promise<void>;
};
export type SetupSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;
const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const packages = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };

/** Output is consumed in memory, never logged, saved, or included in a model transcript. */
export function setupLoginChallenge(kind: NativeSetupKind, output: string) {
  if (kind !== "codex") return {};
  // Codex device authorization uses a fixed verification page. Never forward arbitrary URLs,
  // query strings, bearer credentials, callback URLs or OAuth authorization codes.
  const verificationUrl = output.match(
    /https:\/\/auth\.openai\.com\/codex\/device(?![\w/?#])/i,
  )?.[0];
  const userCode = output.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/)?.[1];
  return verificationUrl && userCode ? { verificationUrl, userCode } : {};
}

export class NativeSetupManager {
  private readonly sessions = new Map<string, Session>();
  private readonly revoked = new Set<string>();
  private readonly revokedScopes = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private ticking = false;
  private readonly planning = new Set<NativeSetupKind>();
  private epoch = 0;
  constructor(
    private readonly options: {
      root: string;
      status: (kind: NativeSetupKind) => Promise<{ available: boolean; authenticated: boolean }>;
      spawn?: SetupSpawn;
      now?: () => number;
      resolve?: typeof resolveCodexExecutable;
      tickMs?: number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private directory(...parts: string[]) {
    return setupDirectory(this.options.root, "native-setup", ...parts);
  }
  private async tombstoned(registrationId: string | null) {
    if (!registrationId) return false;
    if (this.revoked.has(registrationId)) return true;
    const directory = await this.directory("revoked");
    return existsSync(path.join(directory, `${hash(registrationId)}.json`));
  }
  private async scopeTombstoned(scopeKey: string) {
    return (
      this.revokedScopes.has(scopeKey) ||
      existsSync(path.join(await this.directory("revoked-scopes"), `${scopeKey}.json`))
    );
  }
  private async unavailable(session: Pick<Session, "registrationId" | "scopeKey">) {
    return (
      this.closed ||
      (await this.tombstoned(session.registrationId)) ||
      (await this.scopeTombstoned(session.scopeKey))
    );
  }
  private async retireTerminalSessions() {
    for (const session of this.sessions.values()) {
      if (this.sessions.size < 128) break;
      if (
        !terminal.has(session.state) ||
        session.child ||
        session.starting ||
        session.releaseLock ||
        session.cleanupUncertain
      )
        continue;
      await this.removePlan(session);
      this.sessions.delete(session.id);
    }
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
  }
  async request(input: NativeSetupHostRequest): Promise<NativeSetupView> {
    const epoch = this.epoch;
    if (await this.unavailable(input)) throw new Error("Runtime setup unavailable");
    let session: Session | undefined;
    if (input.action === "status")
      session = [...this.sessions.values()]
        .reverse()
        .find(
          (row) =>
            row.scopeKey === input.scopeKey &&
            row.registrationId === input.registrationId &&
            row.kind === input.kind,
        );
    if (input.action === "session" || input.action === "cancel") {
      session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
      if (
        !session ||
        session.scopeKey !== input.scopeKey ||
        session.registrationId !== input.registrationId ||
        session.kind !== input.kind
      )
        throw new Error("Runtime setup unavailable");
      if (input.action === "cancel") await this.stop(session, "cancelled");
    } else if (input.action === "install" || input.action === "login") {
      if (process.platform !== "darwin" && process.platform !== "linux")
        throw new Error("Runtime setup process supervision is unsupported on this host");
      if (input.kind === "acp") throw new Error("Configure ACP locally on this host");
      await this.retireTerminalSessions();
      if (this.sessions.size >= 128) throw new Error("Runtime setup capacity reached");
      if (
        this.planning.has(input.kind) ||
        [...this.sessions.values()].some(
          (row) => row.kind === input.kind && !terminal.has(row.state),
        )
      )
        throw new Error("Runtime setup is already pending");
      this.planning.add(input.kind);
      try {
        session = await this.plan(
          input as NativeSetupHostRequest & {
            kind: "codex" | "claude";
            action: "install" | "login";
          },
        );
        if ((await this.unavailable(input)) || epoch !== this.epoch)
          throw new Error("Runtime setup unavailable");
        this.sessions.set(session.id, session);
      } finally {
        this.planning.delete(input.kind);
      }
      if (!this.timer) {
        this.timer = setInterval(() => this.track(this.tick()), this.options.tickMs ?? 500);
        this.timer.unref();
      }
    }
    return this.view(input.kind, session);
  }
  private async view(kind: NativeSetupKind, session?: Session): Promise<NativeSetupView> {
    const status = await this.options
      .status(kind)
      .catch(() => ({ available: false, authenticated: false }));
    const managed = kind !== "acp" && !!managedNativeExecutable(this.options.root, kind);
    const visible = session && {
      id: session.id,
      action: session.action,
      state: session.state,
      expiresAt: session.expiresAt,
      command: session.command,
      destination: session.destination,
      localApproval: session.localApproval,
      ...(session.state === "running"
        ? { verificationUrl: session.verificationUrl, userCode: session.userCode }
        : {}),
    };
    return {
      kind,
      ...status,
      managed,
      installSupported:
        kind !== "acp" && (process.platform === "darwin" || process.platform === "linux"),
      loginSupported:
        kind !== "acp" && (process.platform === "darwin" || process.platform === "linux"),
      ...(visible ? { session: visible } : {}),
    };
  }
  private async plan(
    input: NativeSetupHostRequest & { kind: "codex" | "claude"; action: "install" | "login" },
  ): Promise<Session> {
    const root = await setupDirectory(this.options.root, "native-tools", input.kind);
    for (const file of await readdir(await this.directory("running"))) {
      const journal = await readSetupFile(path.join(await this.directory("running"), file));
      if (journal.kind === input.kind) throw new Error("Runtime setup cleanup uncertain");
    }
    for (const directory of ["home", "cache", "tmp"]) await setupDirectory(root, directory);
    await setupDirectory(root, "home", ".codex");
    await setupDirectory(root, "home", ".claude");
    const env = {
      ...resolveCodexExecutableEnvironment(this.options.resolve),
      ...managedNativeEnvironment(this.options.root, input.kind),
    };
    let command: string[];
    if (input.action === "install") {
      if (managedNativeExecutable(this.options.root, input.kind))
        throw new Error("Runtime is already installed");
      // No shell or lifecycle scripts. npm never writes to a global prefix or shared cache.
      const npm = resolveNpm(env.PATH ?? "");
      command = [
        npm,
        "install",
        "--prefix",
        root,
        "--cache",
        env.npm_config_cache!,
        "--registry",
        "https://registry.npmjs.org",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        packages[input.kind],
      ];
    } else {
      const resolved = (this.options.resolve ?? resolveCodexExecutable)({
        name: input.kind,
        managedRoot: this.options.root,
      });
      command = [
        resolved.executable,
        ...(input.kind === "codex" ? ["login", "--device-auth"] : ["auth", "login"]),
      ];
    }
    const id = randomUUID();
    const session: Session = {
      id,
      kind: input.kind,
      action: input.action,
      state: "awaiting-consent",
      expiresAt: new Date(this.now() + 15 * 60_000).toISOString(),
      command,
      destination: root,
      localApproval: `pnpm host:setup --data-dir ${quote(this.options.root)} --session ${id}`,
      scopeKey: input.scopeKey,
      registrationId: input.registrationId,
      digest: "",
      env,
      journal: path.join(await this.directory("running"), `${id}.json`),
    };
    session.digest = hash(
      JSON.stringify([id, command, root, session.expiresAt, input.scopeKey, input.registrationId]),
    );
    await writeSetupFile(path.join(await this.directory("plans"), `${id}.json`), {
      id,
      command,
      destination: root,
      expiresAt: session.expiresAt,
      digest: session.digest,
      warning:
        input.action === "install"
          ? "Downloads a CLI into this host data directory."
          : "Signs in using an isolated CLI profile. Continue in the host browser if opened.",
    });
    return session;
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const session of this.sessions.values()) {
        if (terminal.has(session.state)) continue;
        if (this.now() >= Date.parse(session.expiresAt)) {
          await this.stop(session, "expired");
          continue;
        }
        if (session.state !== "awaiting-consent") continue;
        const approval = path.join(await this.directory("approvals"), `${session.id}.json`);
        if (!existsSync(approval)) continue;
        try {
          const proof = await readSetupFile(approval);
          if (proof.id !== session.id || proof.digest !== session.digest) {
            await this.stop(session, "failed");
            continue;
          }
          await unlink(approval);
          if (await this.unavailable(session)) {
            await this.stop(session, "cancelled");
            continue;
          }
          if (session.state !== "awaiting-consent") continue;
          // Mark before spawning: overlapping timers must never start a plan twice.
          session.state = "running";
          session.starting = this.start(session);
          try {
            await session.starting;
          } finally {
            delete session.starting;
          }
        } catch {
          await this.stop(session, "failed");
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private async start(session: Session) {
    session.releaseLock = await acquireSetupProviderLock(this.options.root, session.kind, {
      sessionId: session.id,
      registrationId: session.registrationId,
      scopeKey: session.scopeKey,
    });
    // Recheck after the durable provider fence: planning is not a reservation.
    for (const file of await readdir(await this.directory("running"))) {
      const journal = await readSetupFile(path.join(await this.directory("running"), file));
      if (journal.kind === session.kind) {
        session.cleanupUncertain = true;
        throw new Error("Runtime setup cleanup uncertain");
      }
    }
    await writeSetupFile(session.journal, {
      registrationId: session.registrationId,
      scopeKey: session.scopeKey,
      kind: session.kind,
    });
    const unavailable = await this.unavailable(session);
    if (session.state !== "running" || unavailable) {
      if (unavailable && session.state === "running") session.state = "cancelled";
      await this.removeJournal(session);
      await this.removePlan(session);
      return;
    }
    const child = (
      this.options.spawn ??
      ((command, args, options) =>
        spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] }))
    )(session.command[0]!, session.command.slice(1), {
      cwd: session.destination,
      env: session.env,
    });
    session.child = child;
    let output = "",
      bytes = 0;
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        this.track(this.stop(session, "failed"));
        return;
      }
      if (session.action === "login" && session.kind === "codex") {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove ANSI color escapes from provider device-code output.
        output = (output + chunk.toString("utf8")).replace(/\u001b\[[0-9;]*m/g, "");
        Object.assign(session, setupLoginChallenge(session.kind, output));
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    session.settled = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        try {
          this.kill(child);
          delete session.child;
        } catch {
          session.cleanupUncertain = true;
          session.state = "failed";
          resolve();
          return;
        }
        const task = (async () => {
          if (session.state !== "running") return;
          const unavailable = await this.unavailable(session);
          if (session.state !== "running") return;
          if (unavailable || this.now() >= Date.parse(session.expiresAt)) {
            session.state = unavailable ? "cancelled" : "expired";
            return;
          }
          if (code !== 0) {
            session.state = "failed";
            return;
          }
          const marker = path.join(
            session.destination,
            session.action === "install" ? "installed.json" : "authenticated.json",
          );
          const created = !existsSync(marker);
          if (created) await writeSetupFile(marker, { version: 1 });
          const unavailableAfterActivation = await this.unavailable(session);
          if (session.state !== "running" || unavailableAfterActivation) {
            if (created) await unlink(marker);
            return;
          }
          session.state = "succeeded";
          delete session.userCode;
          delete session.verificationUrl;
        })()
          .catch(() => {
            session.state = "failed";
          })
          .finally(async () => {
            try {
              await this.removeJournal(session);
              await this.removePlan(session);
            } catch {
              session.cleanupUncertain = true;
              session.state = "failed";
            }
            resolve();
          });
        this.track(task);
      };
      child.once("exit", finish);
      child.once("error", () => finish(null));
    });
  }
  private kill(child: ChildProcess) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("Runtime setup cleanup uncertain");
      }
    } else child.kill("SIGKILL");
  }
  private async stop(session: Session, state: "cancelled" | "expired" | "failed") {
    if (terminal.has(session.state) && !session.child && !session.starting && !session.releaseLock)
      return;
    if (!terminal.has(session.state)) session.state = state;
    delete session.userCode;
    delete session.verificationUrl;
    if (session.starting) await session.starting.catch(() => undefined);
    if (session.cleanupUncertain) throw new Error("Runtime setup cleanup uncertain");
    if (session.child) this.kill(session.child);
    if (session.settled) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.settled,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Runtime setup cleanup uncertain")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      delete session.child;
    }
    await this.removeJournal(session);
    await this.removePlan(session);
  }
  private async removePlan(session: Session) {
    for (const directory of ["plans", "approvals"]) {
      await unlink(path.join(await this.directory(directory), `${session.id}.json`)).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    }
  }
  private async removeJournal(session: Session) {
    if (session.cleanupUncertain) throw new Error("Runtime setup cleanup uncertain");
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      await unlink(session.journal).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (session.releaseLock) {
        await session.releaseLock();
        delete session.releaseLock;
      }
    })();
    try {
      await session.cleanup;
    } finally {
      delete session.cleanup;
    }
  }
  private async assertLocksClean(
    matches: (owner: { registrationId?: string; scopeKey?: string }) => boolean,
  ) {
    const locks = await this.directory("locks");
    for (const kind of await readdir(locks)) {
      let owner: { registrationId?: string; scopeKey?: string };
      const directory = path.join(locks, kind);
      try {
        const info = await lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error("Unsafe setup lock");
        owner = await readSetupFile(path.join(directory, "owner.json"));
      } catch {
        const remains = await lstat(directory).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!remains) continue;
        throw new Error("Runtime setup cleanup uncertain");
      }
      if (matches(owner)) throw new Error("Runtime setup cleanup uncertain");
    }
  }
  async revoke(registrationId: string) {
    this.revoked.add(registrationId);
    const file = path.join(await this.directory("revoked"), `${hash(registrationId)}.json`);
    if (!existsSync(file)) await writeSetupFile(file, { revoked: true });
    for (const session of this.sessions.values())
      if (session.registrationId === registrationId) await this.stop(session, "cancelled");
    for (const file of await readdir(await this.directory("running"))) {
      const journal = await readSetupFile(path.join(await this.directory("running"), file));
      if (journal.registrationId === registrationId)
        throw new Error("Runtime setup cleanup uncertain");
    }
    await this.assertLocksClean(
      (owner) => !owner.registrationId || owner.registrationId === registrationId,
    );
  }
  async revokeScope(scopeKey: string) {
    if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new Error("Invalid setup scope");
    this.revokedScopes.add(scopeKey);
    const file = path.join(await this.directory("revoked-scopes"), `${scopeKey}.json`);
    await writeSetupFile(file, { revoked: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    for (const session of this.sessions.values())
      if (session.scopeKey === scopeKey) await this.stop(session, "cancelled");
    for (const file of await readdir(await this.directory("running"))) {
      const journal = await readSetupFile(path.join(await this.directory("running"), file));
      // Older journals have no owner scope, so cannot acknowledge scoped cleanup.
      if (!journal.scopeKey || journal.scopeKey === scopeKey)
        throw new Error("Runtime setup cleanup uncertain");
    }
    await this.assertLocksClean((owner) => !owner.scopeKey || owner.scopeKey === scopeKey);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.cancelAll();
    await Promise.allSettled([...this.tasks]);
  }
  async cancelAll() {
    this.epoch++;
    await Promise.all(
      [...this.sessions.values()].map((session) => this.stop(session, "cancelled")),
    );
  }
}
function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function resolveCodexExecutableEnvironment(resolve?: typeof resolveCodexExecutable) {
  // Resolver supplies the host's minimal environment even when no provider is installed.
  return (resolve ?? resolveCodexExecutable)({ canExecute: () => true }).env;
}
function resolveNpm(searchPath: string) {
  for (const directory of searchPath.split(path.delimiter)) {
    const executable = path.join(directory, "npm");
    if (path.isAbsolute(directory) && existsSync(executable)) {
      const info = lstatSync(executable);
      if (info.isFile() || info.isSymbolicLink()) return executable;
    }
  }
  throw new Error("npm is unavailable on this host");
}

/** Called only by the host-local interactive CLI; never exported through RPC. */
export async function approveNativeSetup(
  root: string,
  id: string,
  confirm: (plan: { command: string[]; destination: string; warning: string }) => Promise<boolean>,
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid setup session");
  const plans = await setupDirectory(root, "native-setup", "plans");
  const plan = await readSetupFile(path.join(plans, `${id}.json`));
  if (
    plan.id !== id ||
    Date.now() >= Date.parse(plan.expiresAt) ||
    !Array.isArray(plan.command) ||
    typeof plan.digest !== "string"
  )
    throw new Error("Setup plan is unavailable or expired");
  if (!(await confirm(plan))) return false;
  const approvals = await setupDirectory(root, "native-setup", "approvals");
  await writeSetupFile(path.join(approvals, `${id}.json`), { id, digest: plan.digest });
  return true;
}
