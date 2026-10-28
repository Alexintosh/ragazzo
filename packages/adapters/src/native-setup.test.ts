import type { ChildProcess } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexExecutable } from "./codex-executable.js";
import { hostComputerRequest } from "./host-computer-protocol.js";
import { approveNativeSetup, NativeSetupManager, setupLoginChallenge } from "./native-setup.js";
import { readSetupFile, setupDirectory } from "./native-setup-paths.js";
import type { NativeSetupHostRequest } from "./native-setup-protocol.js";

const directories: string[] = [],
  managers: NativeSetupManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const owner = {
  method: "nativeSetup",
  botId: "setup",
  scopeKey: "a".repeat(64),
  registrationId: "host-a",
  kind: "codex",
} as const;
async function fixture(existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(path.join(tmpdir(), "rakazo-setup-")));
  if (!existingRoot) directories.push(root);
  const children: Array<
    EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
  > = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null));
        return true;
      }),
    });
    children.push(child);
    return child as unknown as ChildProcess;
  });
  let now = Date.now();
  const resolve = vi.fn(() => ({
    executable: "/fake/codex",
    env: { PATH: process.env.PATH ?? "", HOME: "/existing-home" },
  }));
  const manager = new NativeSetupManager({
    root,
    status: async () => ({ available: true, authenticated: false }),
    spawn,
    now: () => now,
    resolve,
    tickMs: 60000,
  });
  managers.push(manager);
  const request = (action: NativeSetupHostRequest["action"], sessionId?: string, changes = {}) =>
    manager.request({ ...owner, action, sessionId, ...changes });
  return {
    root,
    manager,
    spawn,
    children,
    request,
    expire: () => {
      now += 16 * 60_000;
    },
  };
}
describe("host-local runtime setup", () => {
  it("preserves an existing CLI/profile and selects only a private host-managed executable or authenticated profile", async () => {
    const f = await fixture();
    const existing = {
      managedRoot: f.root,
      env: { PATH: "/existing/bin", HOME: "/existing/home" },
      canExecute: (candidate: string) => candidate === "/existing/bin/codex",
    };
    expect(resolveCodexExecutable(existing)).toMatchObject({
      executable: "/existing/bin/codex",
      env: { HOME: "/existing/home" },
    });
    const base = await setupDirectory(f.root, "native-tools", "codex");
    await writeFile(path.join(base, "authenticated.json"), '{"version":1}', { mode: 0o600 });
    expect(resolveCodexExecutable(existing)).toMatchObject({
      executable: "/existing/bin/codex",
      env: { HOME: path.join(base, "home") },
    });
    await rm(path.join(base, "authenticated.json"));
    await mkdir(path.join(base, "node_modules/.bin"), { recursive: true });
    await mkdir(path.join(base, "node_modules/fake-provider"));
    await writeFile(path.join(base, "node_modules/fake-provider/codex"), "fake", { mode: 0o700 });
    await symlink("../fake-provider/codex", path.join(base, "node_modules/.bin/codex"));
    await writeFile(path.join(base, "installed.json"), '{"version":1}', { mode: 0o600 });
    const result = resolveCodexExecutable({ ...existing, canExecute: () => true });
    expect(result.executable).toBe(path.join(base, "node_modules/.bin/codex"));
    expect(result.env).toMatchObject({
      HOME: path.join(base, "home"),
      CODEX_HOME: path.join(base, "home/.codex"),
    });
    await chmod(path.join(base, "installed.json"), 0o644);
    expect(resolveCodexExecutable(existing).executable).toBe("/existing/bin/codex");
    expect(resolveCodexExecutable(existing).env).toMatchObject({ HOME: "/existing/home" });
  });
  it("plans without execution and requires a private host-local approval", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    expect(plan.session?.state).toBe("awaiting-consent");
    expect(f.spawn).not.toHaveBeenCalled();
    await f.manager.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    const confirm = vi.fn(async () => true);
    await approveNativeSetup(f.root, plan.session!.id, confirm);
    await f.manager.tick();
    await f.manager.tick();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["/fake/codex", "login", "--device-auth"] }),
    );
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const options = f.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    expect(options[2].env.HOME).toBe(path.join(f.root, "native-tools/codex/home"));
    expect(options[2].env.CODEX_HOME).toBe(path.join(f.root, "native-tools/codex/home/.codex"));
    expect(options[2].env.OPENAI_API_KEY).toBeUndefined();
  });
  it("binds session status, cancel and device codes to owner, registration and provider", async () => {
    const f = await fixture(),
      plan = await f.request("login"),
      id = plan.session!.id;
    await approveNativeSetup(f.root, id, async () => true);
    await f.manager.tick();
    f.children[0]!.stdout.write(
      "https://auth.openai.com/codex/device\nABCD-EFGH\nbearer-private-secret\n",
    );
    const result = await f.request("session", id);
    expect(result.session).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(JSON.stringify(result)).not.toContain("bearer-private-secret");
    for (const changes of [
      { scopeKey: "b".repeat(64) },
      { registrationId: "host-b" },
      { kind: "claude" },
    ]) {
      await expect(f.request("session", id, changes)).rejects.toThrow("unavailable");
      await expect(f.request("cancel", id, changes)).rejects.toThrow("unavailable");
      expect((await f.request("status", undefined, changes)).session).toBeUndefined();
    }
    const cancelled = await f.request("cancel", id);
    expect(cancelled.session).toMatchObject({ state: "cancelled" });
    expect(cancelled.session?.userCode).toBeUndefined();
    expect(f.children[0]!.kill).toHaveBeenCalled();
  });
  it("bounds install prefix, all caches, temp and home to the chosen data directory", async () => {
    const f = await fixture(),
      plan = await f.request("install");
    expect(plan.session!.command).toContain("--ignore-scripts");
    expect(plan.session!.command).toContain("@openai/codex");
    expect(plan.session!.command).not.toContain("--global");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.tick();
    const options = (
      f.spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv },
      ]
    )[2];
    for (const key of [
      "HOME",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "npm_config_cache",
      "npm_config_userconfig",
    ])
      expect(options.env[key]).toMatch(new RegExp(`^${f.root}/native-tools/codex/`));
  });
  it("expires approved plans before execution", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    f.expire();
    await f.manager.tick();
    expect((await f.request("session", plan.session!.id)).session?.state).toBe("expired");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("cancels running setup on registration revoke and persists a tombstone across restarts", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.tick();
    await f.manager.revoke(owner.registrationId);
    expect(f.children[0]!.kill).toHaveBeenCalled();
    await expect(f.request("status")).rejects.toThrow("unavailable");
    const restarted = new NativeSetupManager({
      root: f.root,
      status: async () => ({ available: false, authenticated: false }),
      spawn: f.spawn,
    });
    managers.push(restarted);
    await expect(restarted.request({ ...owner, action: "login" })).rejects.toThrow("unavailable");
    await restarted.tick();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("does not resume an old approved plan after host restart", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.close();
    const restarted = new NativeSetupManager({
      root: f.root,
      status: async () => ({ available: false, authenticated: false }),
      spawn: f.spawn,
    });
    managers.push(restarted);
    await restarted.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    await expect(
      restarted.request({ ...owner, action: "session", sessionId: plan.session!.id }),
    ).rejects.toThrow("unavailable");
  });
  it("rejects symlink directories, approval files and forged proof", async () => {
    const f = await fixture(),
      outside = await mkdtemp(path.join(tmpdir(), "rakazo-setup-outside-"));
    directories.push(outside);
    await symlink(outside, path.join(f.root, "native-tools"));
    await expect(f.request("login")).rejects.toThrow("Unsafe setup directory");
    await rm(path.join(f.root, "native-tools"));
    const plan = await f.request("login"),
      approvals = await setupDirectory(f.root, "native-setup", "approvals");
    const target = path.join(outside, "proof.json");
    await writeFile(target, JSON.stringify({ id: plan.session!.id, digest: "forged" }), {
      mode: 0o600,
    });
    await symlink(target, path.join(approvals, `${plan.session!.id}.json`));
    await f.manager.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect((await f.request("session", plan.session!.id)).session?.state).toBe("failed");
  });
  it("rejects broad permissions and remote commands/paths/consent", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    const target = path.join(f.root, "native-setup/plans", `${plan.session!.id}.json`);
    await writeFile(target, "{}", { mode: 0o600 });
    await chmod(target, 0o644);
    await expect(readSetupFile(target)).rejects.toThrow("Unsafe setup file");
    for (const extras of [
      { command: ["sh", "-c", "bad"] },
      { destination: "/tmp/bad" },
      { approved: true },
    ])
      expect(
        hostComputerRequest.safeParse({ ...owner, action: "install", ...extras }).success,
      ).toBe(false);
  });
  it("serializes concurrent plans per provider and rejects generic ACP install/login", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.request("login"), f.request("login")]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    for (const action of ["install", "login"] as const)
      await expect(f.request(action, undefined, { kind: "acp" })).rejects.toThrow(
        "Configure ACP locally",
      );
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["install", "login"] as const)(
    "fences simultaneous %s processes across independent managers sharing a provider profile",
    async (action) => {
      const first = await fixture(),
        second = await fixture(first.root);
      const plans = await Promise.all([first.request(action), second.request(action)]);
      await Promise.all(
        plans.map((plan) => approveNativeSetup(first.root, plan.session!.id, async () => true)),
      );
      await Promise.all([first.manager.tick(), second.manager.tick()]);
      expect(first.spawn.mock.calls.length + second.spawn.mock.calls.length).toBe(1);
      const views = await Promise.all([first.request("status"), second.request("status")]);
      expect(views.map((view) => view.session?.state).sort()).toEqual(["failed", "running"]);
      const winner = first.children.length ? first : second;
      await winner.request(
        "cancel",
        winner.children === first.children ? plans[0]!.session!.id : plans[1]!.session!.id,
      );
      expect(await readdir(path.join(first.root, "native-setup/locks"))).toEqual([]);
      expect(await readdir(path.join(first.root, "native-setup/running"))).toEqual([]);
    },
  );
  it("checks crash journals again under the provider lock immediately before spawning", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await writeFile(
      path.join(f.root, "native-setup/running/crashed.json"),
      JSON.stringify({
        kind: "codex",
        registrationId: owner.registrationId,
        scopeKey: owner.scopeKey,
      }),
      { mode: 0o600 },
    );
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await expect(f.manager.tick()).rejects.toThrow("cleanup uncertain");
    expect(f.spawn).not.toHaveBeenCalled();
    await expect(f.manager.revokeScope(owner.scopeKey)).rejects.toThrow("cleanup uncertain");
    managers.splice(managers.indexOf(f.manager), 1);
    await expect(f.manager.close()).rejects.toThrow("cleanup uncertain");
    expect(await readdir(path.join(f.root, "native-setup/locks"))).toEqual(["codex"]);
  });
  it("refuses an existing provider fence without killing or removing its owner", async () => {
    const f = await fixture(),
      plan = await f.request("login"),
      locks = await setupDirectory(f.root, "native-setup", "locks");
    await mkdir(path.join(locks, "codex"), { mode: 0o700 });
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(await readdir(locks)).toEqual(["codex"]);
    await expect(f.manager.revokeScope(owner.scopeKey)).rejects.toThrow("cleanup uncertain");
  });
  it("retires bounded terminal history so repeated prepare/cancel remains available", async () => {
    const f = await fixture();
    let firstId = "";
    for (let index = 0; index < 132; index++) {
      const plan = await f.request("login");
      if (!index) firstId = plan.session!.id;
      await f.request("cancel", plan.session!.id);
    }
    await expect(f.request("session", firstId)).rejects.toThrow("unavailable");
    await expect(f.request("cancel", firstId, { scopeKey: "b".repeat(64) })).rejects.toThrow(
      "unavailable",
    );
    expect((await f.request("status")).session?.state).toBe("cancelled");
    expect(await readdir(path.join(f.root, "native-setup/plans"))).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("revokes an exact owner scope including local bridge plans and preserves sibling owners", async () => {
    const f = await fixture(),
      plan = await f.request("login", undefined, { registrationId: null });
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.revokeScope(owner.scopeKey);
    await f.manager.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    for (const action of ["status", "login", "session"] as const)
      await expect(f.request(action, plan.session!.id, { registrationId: null })).rejects.toThrow(
        "unavailable",
      );
    const restarted = await fixture(f.root);
    await expect(restarted.request("login", undefined, { registrationId: null })).rejects.toThrow(
      "unavailable",
    );
    expect(
      (
        await restarted.request("login", undefined, {
          scopeKey: "b".repeat(64),
          registrationId: null,
        })
      ).session?.state,
    ).toBe("awaiting-consent");
  });
  it("kills and awaits a running setup before acknowledging exact scope revocation", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.tick();
    await f.manager.revokeScope(owner.scopeKey);
    expect(f.children[0]!.kill).toHaveBeenCalled();
    expect(await readdir(path.join(f.root, "native-setup/locks"))).toEqual([]);
    expect(await readdir(path.join(f.root, "native-setup/running"))).toEqual([]);
  });
  it("marks completion without saving provider output and clears the challenge", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await f.manager.tick();
    f.children[0]!.stdout.write("https://auth.openai.com/codex/device\nABCD-EFGH\nsecret-token");
    f.children[0]!.emit("exit", 0);
    await vi.waitFor(async () =>
      expect((await f.request("session", plan.session!.id)).session?.state).toBe("succeeded"),
    );
    expect((await f.request("session", plan.session!.id)).session?.userCode).toBeUndefined();
    expect(await readFile(path.join(f.root, "native-tools/codex/authenticated.json"), "utf8")).toBe(
      '{"version":1}',
    );
  });
  it("ignores unapproved local rejection and never forwards arbitrary OAuth URLs", async () => {
    const f = await fixture(),
      plan = await f.request("login");
    expect(await approveNativeSetup(f.root, plan.session!.id, async () => false)).toBe(false);
    await f.manager.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(
      setupLoginChallenge("codex", "https://evil.example/ABCD-EFGH?access_token=secret"),
    ).toEqual({});
    expect(
      setupLoginChallenge("codex", "https://auth.openai.com/codex/device?token=secret ABCD-EFGH"),
    ).toEqual({});
    expect(setupLoginChallenge("claude", "https://claude.ai/oauth?code=secret")).toEqual({});
  });
  it("does not acknowledge an unresolved setup process journal after a host crash", async () => {
    const f = await fixture(),
      running = await setupDirectory(f.root, "native-setup", "running");
    await writeFile(
      path.join(running, "old.json"),
      JSON.stringify({ registrationId: owner.registrationId, kind: "codex" }),
      { mode: 0o600 },
    );
    await expect(f.request("login")).rejects.toThrow("cleanup uncertain");
    await expect(f.manager.revoke(owner.registrationId)).rejects.toThrow("cleanup uncertain");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("kills and awaits its real fake CLI process on revoke", async () => {
    const f = await fixture();
    let child: ChildProcess | undefined;
    const manager = new NativeSetupManager({
      root: f.root,
      status: async () => ({ available: true, authenticated: false }),
      tickMs: 60000,
      resolve: () => ({ executable: "/fake/codex", env: { PATH: process.env.PATH ?? "" } }),
      spawn: (_command, _args, options) => {
        child = spawnProcess(
          process.execPath,
          [
            "-e",
            'process.stdout.write("https://auth.openai.com/codex/device\\nABCD-EFGH\\n"); setInterval(() => {},1000)',
          ],
          { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        return child;
      },
    });
    managers.push(manager);
    const plan = await manager.request({ ...owner, action: "login" });
    await approveNativeSetup(f.root, plan.session!.id, async () => true);
    await manager.tick();
    await vi.waitFor(async () =>
      expect(
        (await manager.request({ ...owner, action: "session", sessionId: plan.session!.id }))
          .session?.userCode,
      ).toBe("ABCD-EFGH"),
    );
    const pid = child!.pid!;
    expect(() => process.kill(pid, 0)).not.toThrow();
    await manager.revoke(owner.registrationId);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
