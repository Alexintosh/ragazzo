import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localDockerEnvironment,
  localPortFree,
  localSupervisorAddress,
  runLocalStack,
} from "./local-stack.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  spawn: vi.fn(),
  createServer: vi.fn(),
  createRequire: vi.fn(),
  Docker: vi.fn(),
  ping: vi.fn(),
  inspect: vi.fn(),
  getImage: vi.fn(),
  check: vi.fn(),
  start: vi.fn(),
  stopGroups: vi.fn(),
  stopStack: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }),
  spawn: mocks.spawn,
}));
vi.mock("node:net", () => ({ createServer: mocks.createServer }));
vi.mock("node:module", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createRequire: mocks.createRequire,
}));
vi.mock("./native-stack.js", () => ({
  nativeStackSettings: (env: NodeJS.ProcessEnv) => ({
    apiPort: Number(env.API_PORT ?? 3100),
    webPort: Number(env.WEB_PORT ?? 5173),
    env,
  }),
  checkNativeDockerSupervisor: mocks.check,
  startNativeStack: mocks.start,
  stopNativeProcessGroups: mocks.stopGroups,
}));

const baseEnv = {
  SANDBOX_SUPERVISOR_TOKEN: "test-only-supervisor-token-of-at-least-32-characters",
  DOCKER_SOCKET: "/tmp/test-docker.sock",
};
let child: ChildProcess;
let migration: ChildProcess;
let occupiedPorts: Set<number>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  occupiedPorts = new Set();
  mocks.createServer.mockImplementation(() => {
    const server = new EventEmitter();
    Object.assign(server, {
      listen: (port: number, _host: string, ready: () => void) => {
        queueMicrotask(() =>
          occupiedPorts.has(port)
            ? server.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }))
            : ready(),
        );
      },
      close: (done: () => void) => done(),
    });
    return server;
  });
  child = new EventEmitter() as ChildProcess;
  migration = new EventEmitter() as ChildProcess;
  mocks.spawn.mockImplementation((command) => {
    if (command === "pnpm") {
      queueMicrotask(() => migration.emit("close", 0, null));
      return migration;
    }
    return child;
  });
  mocks.createRequire.mockReturnValue(() => mocks.Docker);
  mocks.Docker.mockImplementation(function DockerMock() {
    return { ping: mocks.ping, getImage: mocks.getImage };
  });
  mocks.getImage.mockReturnValue({ inspect: mocks.inspect });
  mocks.ping.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({});
  mocks.check.mockResolvedValue(undefined);
  mocks.stopGroups.mockResolvedValue(undefined);
  mocks.stopStack.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({
    url: "http://127.0.0.1:5173",
    exited: Promise.resolve(0),
    stop: mocks.stopStack,
  });
  mocks.exec.mockResolvedValue({ stdout: "unix:///tmp/context-docker.sock\n" });
});
afterEach(() => vi.restoreAllMocks());

const signal = () => new AbortController().signal;

describe("local supervisor address", () => {
  it("normalizes loopback HTTP addresses and defaults to the supervisor port", () => {
    expect(localSupervisorAddress({})).toEqual({ port: 7091, url: "http://127.0.0.1:7091" });
    expect(localSupervisorAddress({ SANDBOX_SUPERVISOR_URL: "http://localhost:7092/" })).toEqual({
      port: 7092,
      url: "http://127.0.0.1:7092",
    });
  });
  it.each([
    "https://127.0.0.1:7091",
    "http://example.test:7091",
    "http://0.0.0.0:7091",
    "http://user:password@127.0.0.1:7091",
    "http://127.0.0.1:7091/path",
    "http://127.0.0.1:7091/?query=1",
    "http://127.0.0.1:7091/#fragment",
    "http://127.0.0.1",
    "http://127.0.0.1:1023",
    "http://127.0.0.1:65536",
  ])("rejects unsafe or invalid managed supervisor address %s", (url) => {
    expect(() => localSupervisorAddress({ SANDBOX_SUPERVISOR_URL: url })).toThrow();
  });
  it.each([1024, 65535])("accepts boundary port %s", (port) => {
    expect(
      localSupervisorAddress({ SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${port}` }).port,
    ).toBe(port);
  });
  it("checks port availability on loopback and distinguishes other socket failures", async () => {
    expect(await localPortFree(3100)).toBe(true);
    occupiedPorts.add(3100);
    expect(await localPortFree(3100)).toBe(false);
    mocks.createServer.mockImplementationOnce(() => {
      const server = new EventEmitter();
      Object.assign(server, {
        listen: () =>
          queueMicrotask(() =>
            server.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })),
          ),
      });
      return server;
    });
    await expect(localPortFree(3100)).rejects.toThrow("denied");
  });
});

describe("local Docker selection", () => {
  it("honors an explicit absolute socket and removes a competing context", async () => {
    const env = { ...baseEnv, DOCKER_CONTEXT: "other", DOCKER_HOST: "tcp://example.test:2375" };
    expect(await localDockerEnvironment(env, signal())).toEqual({
      ...baseEnv,
      DOCKER_HOST: "unix:///tmp/test-docker.sock",
    });
    expect(env.DOCKER_CONTEXT).toBe("other");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("uses DOCKER_HOST without querying a context", async () => {
    expect(
      await localDockerEnvironment({ DOCKER_HOST: "unix:///tmp/host.sock" }, signal()),
    ).toEqual({ DOCKER_SOCKET: "/tmp/host.sock", DOCKER_HOST: "unix:///tmp/host.sock" });
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("queries the selected Docker context with its environment, then pins the resolved socket", async () => {
    const env = { DOCKER_CONTEXT: "selected", PATH: "/test/bin" };
    const abortSignal = signal();
    expect(await localDockerEnvironment(env, abortSignal)).toEqual({
      PATH: "/test/bin",
      DOCKER_SOCKET: "/tmp/context-docker.sock",
      DOCKER_HOST: "unix:///tmp/context-docker.sock",
    });
    expect(mocks.exec).toHaveBeenCalledWith(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { env, signal: abortSignal, timeout: 5000 },
    );
  });
  it("lets the selected context override a stale DOCKER_HOST", async () => {
    const env = { DOCKER_CONTEXT: "selected", DOCKER_HOST: "unix:///tmp/stale.sock" };
    expect(await localDockerEnvironment(env, signal())).toEqual({
      DOCKER_SOCKET: "/tmp/context-docker.sock",
      DOCKER_HOST: "unix:///tmp/context-docker.sock",
    });
    expect(mocks.exec).toHaveBeenCalledOnce();
    expect(mocks.exec.mock.calls[0]![2].env).toEqual(env);
  });
  it.each([{ DOCKER_HOST: "tcp://example.test:2375" }, { DOCKER_SOCKET: "relative.sock" }])(
    "rejects nonlocal Docker configuration %j",
    async (env) => {
      await expect(localDockerEnvironment(env, signal())).rejects.toThrow();
    },
  );
  it("does no Docker discovery after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(localDockerEnvironment({}, controller.signal)).rejects.toThrow();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});

describe("local launcher ownership", () => {
  it("waits for the canonical migration runner before starting any local services", async () => {
    mocks.spawn.mockImplementationOnce(() => migration);
    const running = runLocalStack(
      "/project",
      { ...baseEnv, DATABASE_MIGRATION_URL: "postgresql://owner@localhost/test" },
      true,
      signal(),
    );
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(mocks.spawn).toHaveBeenCalledWith("pnpm", ["db:migrate"], {
      cwd: "/project",
      env: expect.objectContaining({
        DATABASE_MIGRATION_URL: "postgresql://owner@localhost/test",
        SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
      }),
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    expect(mocks.Docker).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    migration.emit("close", 0, null);
    expect(await running).toBe(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.stopGroups).toHaveBeenCalledWith([migration]);
  });
  it.each(["failure", "signal", "spawn error"])(
    "starts no services and cleans up the migration process on %s",
    async (outcome) => {
      mocks.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          if (outcome === "spawn error") migration.emit("error", new Error("not found"));
          else
            migration.emit(
              "close",
              outcome === "failure" ? 1 : null,
              outcome === "signal" ? "SIGTERM" : null,
            );
        });
        return migration;
      });
      expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.Docker).not.toHaveBeenCalled();
      expect(mocks.check).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.stopGroups).toHaveBeenCalledExactlyOnceWith([migration]);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining(
          outcome === "spawn error" ? "Could not run" : "Database migration failed",
        ),
      );
    },
  );
  it("cancels migration and stops its descendants before any service starts", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce(() => migration);
    const running = runLocalStack("/project", baseEnv, true, controller.signal);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    controller.abort();
    expect(await running).toBe(0);
    expect(mocks.stopGroups).toHaveBeenCalledExactlyOnceWith([migration]);
    expect(mocks.Docker).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("reports migration cleanup failure even when startup was cancelled", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce(() => migration);
    mocks.stopGroups.mockRejectedValueOnce(new Error("process group still running"));
    const running = runLocalStack("/project", baseEnv, true, controller.signal);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    controller.abort();
    expect(await running).toBe(1);
    expect(mocks.stopGroups).toHaveBeenCalledExactlyOnceWith([migration]);
    expect(mocks.Docker).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      "Database migration shutdown failed: process group still running\n",
    );
  });
  it("reuses an authenticated existing supervisor and leaves it running", async () => {
    occupiedPorts.add(7091);
    expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(0);
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({ SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091" }),
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.Docker).not.toHaveBeenCalled();
    expect(mocks.stopGroups).toHaveBeenCalledExactlyOnceWith([migration]);
    expect(mocks.stopStack).toHaveBeenCalledWith(0);
  });
  it("refuses a busy supervisor that fails authenticated readiness", async () => {
    occupiedPorts.add(7091);
    mocks.check.mockRejectedValue(new Error("unauthorized"));
    expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.stopGroups).toHaveBeenCalledExactlyOnceWith([migration]);
  });
  it("checks the installed image before starting an owned supervisor on the selected socket", async () => {
    expect(
      await runLocalStack("/project", { ...baseEnv, DOCKER_CONTEXT: "other" }, true, signal()),
    ).toBe(0);
    expect(mocks.Docker).toHaveBeenCalledWith({ socketPath: baseEnv.DOCKER_SOCKET, timeout: 5000 });
    expect(mocks.getImage).toHaveBeenCalledWith("rakazo/computer:local");
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "/project/infra/sandboxes/supervisor/src/index.ts"],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({
          DOCKER_HOST: "unix:///tmp/test-docker.sock",
          SUPERVISOR_HOST: "127.0.0.1",
          SUPERVISOR_PORT: "7091",
          SANDBOX_AUTO_BUILD_IMAGE: "false",
        }),
      }),
    );
    expect(mocks.spawn.mock.calls[1]![2].env).not.toHaveProperty("DOCKER_CONTEXT");
    expect(mocks.start).toHaveBeenCalledWith("/project", expect.any(Object), true, true, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.stopGroups).toHaveBeenCalledWith([child]);
  });
  it.each(["ping", "inspect"] as const)(
    "does not launch anything when Docker %s fails",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("unavailable"));
      expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
  it("cleans up an owned supervisor when native startup fails", async () => {
    mocks.start.mockRejectedValueOnce(new Error("startup failed"));
    expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
    expect(mocks.stopGroups).toHaveBeenCalledWith([child]);
  });
  it("cleans up an owned supervisor on cancellation during startup", async () => {
    const controller = new AbortController();
    mocks.start.mockImplementationOnce(async (_root, _env, _allowHost, _withDocker, options) => {
      controller.abort();
      options.signal.throwIfAborted();
    });
    expect(await runLocalStack("/project", baseEnv, true, controller.signal)).toBe(0);
    expect(mocks.stopGroups).toHaveBeenCalledWith([child]);
  });
  it("propagates supervisor failure through the native stack cancellation signal", async () => {
    mocks.start.mockImplementationOnce(async (_root, _env, _allowHost, _withDocker, options) => {
      child.emit("exit", 1);
      expect(options.signal.aborted).toBe(true);
      options.signal.throwIfAborted();
    });
    expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
    expect(mocks.stopGroups).toHaveBeenCalledWith([child]);
  });
  it("reports failure when the running supervisor exits even if native cancellation exits cleanly", async () => {
    let finishStack!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finishStack = resolve;
    });
    mocks.start.mockResolvedValueOnce({
      url: "http://127.0.0.1:5173",
      exited,
      stop: mocks.stopStack,
    });
    const running = runLocalStack("/project", baseEnv, true, signal());
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    child.emit("exit", 1);
    finishStack(0);
    expect(await running).toBe(1);
    expect(mocks.stopStack).toHaveBeenCalledWith(1);
    expect(mocks.stopGroups).toHaveBeenCalledWith([child]);
  });
  it.each([3100, 5173])(
    "refuses occupied application port %s before Docker or service startup",
    async (port) => {
      occupiedPorts.add(port);
      expect(await runLocalStack("/project", baseEnv, true, signal())).toBe(1);
      expect(mocks.Docker).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
  it("rejects supervisor/application port collisions", async () => {
    expect(
      await runLocalStack(
        "/project",
        { ...baseEnv, SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:3100" },
        true,
        signal(),
      ),
    ).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
