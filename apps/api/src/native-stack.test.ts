import type { ChildProcess, spawn as Spawn } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { startHostComputerServer } from "@rakazo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkNativeDockerSupervisor,
  checkNativeHostDefault,
  nativeStackSettings,
  startNativeStack,
  stopNativeProcessGroups,
} from "./native-stack.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  existsSync: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawn: vi.fn(),
}));
vi.mock("@rakazo/adapters", () => ({ startHostComputerServer: vi.fn() }));
const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
  disconnect: vi.fn(),
  end: vi.fn(),
}));
vi.mock("@rakazo/db", () => ({
  createDb: () => ({
    prisma: {
      deploymentSettings: { findUnique: database.findUnique },
      $disconnect: database.disconnect,
    },
    pool: { end: database.end },
  }),
  runAsSystem: (_reason: string, work: () => unknown) => work(),
}));
beforeEach(() => vi.clearAllMocks());

const env = {
  DATABASE_URL: "postgres://test:test@127.0.0.1/test",
  ENCRYPTION_KEY: "test-only",
  BETTER_AUTH_SECRET: "test-only",
  SCREEN_PROXY_SECRET: "test-only",
};
describe("standalone native stack", () => {
  it("requires explicit local consent and preexisting PostgreSQL/secrets", () => {
    expect(() => nativeStackSettings(env, "/project", false)).toThrow("--allow-host");
    expect(() => nativeStackSettings({}, "/project", true)).toThrow("DATABASE_URL");
    expect(() => nativeStackSettings({ DATABASE_URL: env.DATABASE_URL }, "/project", true)).toThrow(
      "ENCRYPTION_KEY",
    );
  });
  it("pins local listeners and uses durable queue plus authenticated host placement", () => {
    const settings = nativeStackSettings(
      {
        ...env,
        API_HOST: "0.0.0.0",
        WEB_ORIGIN: "https://other.example",
        WAKEUP_DRIVER: "memory",
        SANDBOX_PROVIDER: "docker",
        DATA_DIR: "state",
        API_PORT: "3110",
        WEB_PORT: "5180",
      },
      "/project",
      true,
    );
    expect(settings.dataDir).toBe("/project/state");
    expect(settings.env).toMatchObject({
      SANDBOX_PROVIDER: "desktop",
      WAKEUP_DRIVER: "graphile",
      API_HOST: "127.0.0.1",
      WEB_ORIGIN: "http://127.0.0.1:5180",
      API_PROXY_TARGET: "http://127.0.0.1:3110",
      DATABASE_URL: env.DATABASE_URL,
    });
    expect(settings.env).not.toHaveProperty("SANDBOX_HOST_TOKEN");
  });
  it.each(["NaN", "0", "-1", "1.5", "65536"])("rejects invalid listener port %s", (API_PORT) => {
    expect(() => nativeStackSettings({ ...env, API_PORT }, "/project", true)).toThrow("API_PORT");
  });
  it("refuses colliding listeners", () => {
    expect(() =>
      nativeStackSettings({ ...env, API_PORT: "5180", WEB_PORT: "5180" }, "/project", true),
    ).toThrow("must differ");
  });
  it("requires an existing explicitly configured supervisor for Docker opt-in", () => {
    expect(() => nativeStackSettings(env, "/project", true, true)).toThrow("--with-docker");
    const dockerEnv = {
      ...env,
      SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
      SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
    };
    expect(nativeStackSettings(dockerEnv, "/project", true).env.SANDBOX_PROVIDER).toBe("desktop");
    expect(nativeStackSettings(dockerEnv, "/project", true, true).env.SANDBOX_PROVIDER).toBe(
      "docker",
    );
    expect(() =>
      nativeStackSettings(
        { ...dockerEnv, SANDBOX_SUPERVISOR_URL: "file:///tmp/supervisor" },
        "/project",
        true,
        true,
      ),
    ).toThrow("HTTP(S)");
    expect(() =>
      nativeStackSettings(
        { ...dockerEnv, SANDBOX_SUPERVISOR_TOKEN: "short" },
        "/project",
        true,
        true,
      ),
    ).toThrow("at least 32 characters");
  });
  it("checks authenticated image readiness without provisioning", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, image: "rakazo/computer:local" }));
    await checkNativeDockerSupervisor(
      {
        SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091/",
        SANDBOX_SUPERVISOR_TOKEN: "test-token",
      },
      request,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:7091/readiness",
      expect.objectContaining({
        headers: { authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
  });
  it.each([
    () => Response.json({ ok: false }, { status: 503 }),
    () => Response.json({ ok: true }),
    () => Response.json({ error: "unauthorized" }, { status: 401 }),
    () => {
      throw new Error("unreachable");
    },
  ])(
    "refuses Docker when supervisor or image readiness cannot be established",
    async (response) => {
      const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(
        checkNativeDockerSupervisor(
          {
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "test-token",
          },
          request,
        ),
      ).rejects.toThrow("Docker sandbox is unavailable");
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it("fails Docker preflight before opening the host bridge or launching services", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: false }, { status: 503 })),
    );
    try {
      await expect(
        startNativeStack(
          "/project",
          {
            ...env,
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
          },
          true,
          true,
        ),
      ).rejects.toThrow("Docker sandbox is unavailable");
      expect(startHostComputerServer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads only the host default preference and closes its database connections", async () => {
    database.findUnique.mockResolvedValueOnce({ computerHost: "this-mac" });
    await expect(checkNativeHostDefault(env)).resolves.toBeUndefined();
    expect(database.findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { computerHost: true },
    });
    expect(database.disconnect).toHaveBeenCalledOnce();
    expect(database.end).toHaveBeenCalledOnce();
  });
  it.each([null, "docker"])(
    "refuses to move existing host defaults when preference is %s",
    async (computerHost) => {
      database.findUnique.mockResolvedValueOnce({ computerHost });
      await expect(checkNativeHostDefault(env)).rejects.toThrow(
        "explicitly set the deployment computer preference to this-mac",
      );
      expect(database.disconnect).toHaveBeenCalledOnce();
      expect(database.end).toHaveBeenCalledOnce();
    },
  );
  it("rejects an unset default before opening host access", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    database.findUnique.mockResolvedValueOnce({ computerHost: null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true, image: "installed" })),
    );
    try {
      await expect(
        startNativeStack(
          "/project",
          {
            ...env,
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
          },
          true,
          true,
        ),
      ).rejects.toThrow("explicitly set the deployment computer preference");
      expect(startHostComputerServer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("native stack lifecycle", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const fakeChild = () => new EventEmitter() as ChildProcess;
  const fakeHost = () => ({
    port: 12345,
    setEnabled: vi.fn(),
    isEnabled: () => true,
    close: vi.fn(async () => {}),
  });
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawn).mockImplementation(fakeChild);
  });

  it("makes repeated stop and abort requests share one cleanup", async () => {
    const host = fakeHost();
    vi.mocked(startHostComputerServer).mockResolvedValueOnce(host);
    const controller = new AbortController();
    const stack = await startNativeStack(root, env, true, false, { signal: controller.signal });
    const stopped = stack.stop();
    expect(stack.stop()).toBe(stopped);
    controller.abort();
    await stopped;
    await expect(stack.exited).resolves.toBe(0);
    expect(host.close).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("cleans up the bridge when a synchronous spawn fails partway through startup", async () => {
    const host = fakeHost();
    vi.mocked(startHostComputerServer).mockResolvedValueOnce(host);
    vi.mocked(spawn)
      .mockImplementationOnce(fakeChild)
      .mockImplementationOnce(() => {
        throw new Error("cannot spawn");
      });
    await expect(startNativeStack(root, env, true)).rejects.toThrow("cannot spawn");
    expect(host.close).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("handles asynchronous spawn errors and unexpected child exits", async () => {
    for (const event of ["error", "exit"] as const) {
      const host = fakeHost();
      const children: ChildProcess[] = [];
      vi.mocked(startHostComputerServer).mockResolvedValueOnce(host);
      vi.mocked(spawn).mockImplementation(() => {
        const child = fakeChild();
        children.push(child);
        return child;
      });
      const stack = await startNativeStack(root, env, true);
      if (event === "error") children[0]!.emit("error", new Error("spawn failed"));
      else children[0]!.emit("exit", 0);
      await expect(stack.exited).resolves.toBe(1);
      expect(host.close).toHaveBeenCalledOnce();
    }
  });

  it("cancels a preflight without ever opening host access", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    try {
      const started = startNativeStack(
        root,
        {
          ...env,
          SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
          SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
        },
        true,
        true,
        { signal: controller.signal },
      );
      const rejected = expect(started).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await rejected;
      expect(startHostComputerServer).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes a bridge that finishes opening after startup was cancelled", async () => {
    const controller = new AbortController();
    const host = fakeHost();
    let opened!: (value: typeof host) => void;
    vi.mocked(startHostComputerServer).mockReturnValueOnce(
      new Promise((resolve) => {
        opened = resolve;
      }),
    );
    const started = startNativeStack(root, env, true, false, { signal: controller.signal });
    const rejected = expect(started).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    opened(host);
    await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce());
    expect(host.setEnabled).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("bounds a stuck bridge cleanup and reports failure", async () => {
    const host = fakeHost();
    host.close.mockImplementation(() => new Promise(() => {}));
    vi.mocked(startHostComputerServer).mockResolvedValueOnce(host);
    const stack = await startNativeStack(root, env, true);
    vi.useFakeTimers();
    try {
      const stopped = stack.stop();
      await vi.advanceTimersByTimeAsync(15_001);
      await stopped;
      await expect(stack.exited).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals an exited leader's group before closing the host bridge", async () => {
    const child = fakeChild();
    Object.assign(child, { pid: 1234567, exitCode: 0 });
    const host = fakeHost();
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-1234567);
      if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === "SIGTERM") groupAlive = false;
      return true;
    });
    host.close.mockImplementation(async () => {
      expect(groupAlive).toBe(false);
    });
    vi.mocked(startHostComputerServer).mockResolvedValueOnce(host);
    vi.mocked(spawn).mockImplementationOnce(() => child);
    try {
      const stack = await startNativeStack(root, env, true);
      await stack.stop();
      await expect(stack.exited).resolves.toBe(0);
      expect(kill).toHaveBeenCalledWith(-1234567, "SIGTERM");
      expect(host.close).toHaveBeenCalledOnce();
    } finally {
      kill.mockRestore();
    }
  });
});

describe.skipIf(process.platform === "win32")("owned native process groups", () => {
  it("accepts a transient permission error once the process group is gone", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      })
      .mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
    try {
      await expect(
        stopNativeProcessGroups([{ pid: 1234567 } as ChildProcess], 0),
      ).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
    }
  });

  it("reports a process group that remains unsignalable after the deadline", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    vi.useFakeTimers();
    try {
      const result = expect(
        stopNativeProcessGroups([{ pid: 1234567 } as ChildProcess], 0),
      ).rejects.toThrow("kill EPERM");
      await vi.advanceTimersByTimeAsync(1_025);
      await result;
      expect(kill).toHaveBeenCalledWith(-1234567, "SIGKILL");
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
    }
  });

  it.each([false, true])(
    "kills a stubborn descendant and permits immediate port reuse (leader exited: %s)",
    async (exitLeader) => {
      const { spawn: realSpawn } = await vi.importActual<{ spawn: typeof Spawn }>(
        "node:child_process",
      );
      const grandchildCode = `
      const server = require("node:net").createServer();
      process.on("SIGTERM", () => {});
      server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port, pid: process.pid }));
    `;
      const child = realSpawn(
        process.execPath,
        [
          "-e",
          `
      const grandchild = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      });
      process.on("SIGTERM", () => process.exit(0));
      grandchild.once("message", (ready) => process.send(ready, () => {
        if (${exitLeader}) process.exit(0);
      }));
    `,
        ],
        { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      const leaderExited = once(child, "exit");
      try {
        const [ready] = (await once(child, "message", { signal: AbortSignal.timeout(5_000) })) as [
          { port: number; pid: number },
        ];
        if (exitLeader) await leaderExited;
        await stopNativeProcessGroups([child], 100);
        await leaderExited;
        expect(() => process.kill(-child.pid!, 0)).toThrow();
        expect(() => process.kill(ready.pid, 0)).toThrow();
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(ready.port, "127.0.0.1", resolve);
        });
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await stopNativeProcessGroups([child], 100);
      } finally {
        // These are only fixture-owned groups; never touch unrelated application processes.
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        if (child.connected) child.disconnect();
      }
    },
  );
});
