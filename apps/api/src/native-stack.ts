import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHostComputerServer } from "@rakazo/adapters";
import { resolveSupervisorToken } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, runAsSystem } from "@rakazo/db";

/** Local processes only; Docker is an optional, externally managed supervisor. */
export function nativeStackSettings(
  env: NodeJS.ProcessEnv,
  root: string,
  allowHost: boolean,
  withDocker = false,
) {
  if (!allowHost)
    throw new Error("Pass --allow-host locally to allow bots to run as your OS user.");
  if (process.platform === "win32")
    throw new Error("Native host execution requires macOS or Linux.");
  if (!env.DATABASE_URL) throw new Error("Set DATABASE_URL to an existing PostgreSQL database.");
  if (!env.ENCRYPTION_KEY || !env.BETTER_AUTH_SECRET || !env.SCREEN_PROXY_SECRET)
    throw new Error(
      "Set ENCRYPTION_KEY, BETTER_AUTH_SECRET and SCREEN_PROXY_SECRET before starting.",
    );
  if (withDocker) {
    if (!env.SANDBOX_SUPERVISOR_URL?.trim() || !env.SANDBOX_SUPERVISOR_TOKEN?.trim())
      throw new Error(
        "--with-docker requires SANDBOX_SUPERVISOR_URL and SANDBOX_SUPERVISOR_TOKEN for an existing supervisor.",
      );
    const url = new URL(env.SANDBOX_SUPERVISOR_URL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "SANDBOX_SUPERVISOR_URL must be an HTTP(S) URL without credentials, query or fragment.",
      );
    resolveSupervisorToken({ ...env, NODE_ENV: "production" });
  }
  const port = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1024 || value > 65535)
      throw new Error(`${name} must be a port from 1024 through 65535.`);
    return value;
  };
  const apiPort = port("API_PORT", 3100);
  const webPort = port("WEB_PORT", 5173);
  if (apiPort === webPort) throw new Error("API_PORT and WEB_PORT must differ.");
  const webUrl = `http://127.0.0.1:${webPort}`;
  return {
    apiPort,
    webPort,
    dataDir: path.resolve(root, env.DATA_DIR ?? "data"),
    env: {
      ...env,
      NODE_ENV: "production",
      SANDBOX_PROVIDER: withDocker ? "docker" : "desktop",
      WAKEUP_DRIVER: "graphile",
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      WEB_PORT: String(webPort),
      WEB_ORIGIN: webUrl,
      BETTER_AUTH_URL: webUrl,
      API_URL: `http://127.0.0.1:${apiPort}`,
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    },
  };
}

/** Inspect an existing supervisor without building images or provisioning computers. */
export async function checkNativeDockerSupervisor(
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
) {
  try {
    const response = await request(`${env.SANDBOX_SUPERVISOR_URL!.replace(/\/+$/, "")}/readiness`, {
      headers: { authorization: `Bearer ${env.SANDBOX_SUPERVISOR_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("not ready");
    }
    const ready = await response.json();
    if (ready?.ok !== true || typeof ready.image !== "string" || !ready.image.trim())
      throw new Error("invalid readiness response");
  } catch {
    throw new Error(
      "Docker sandbox is unavailable. Start an existing supervisor with its computer image already installed, and check SANDBOX_SUPERVISOR_URL and SANDBOX_SUPERVISOR_TOKEN. No image was installed by this launcher.",
    );
  }
}

/** Keep existing default-target host computers on their original execution boundary. */
export async function checkNativeHostDefault(env: NodeJS.ProcessEnv) {
  const { prisma, pool } = createDb(env.DATABASE_URL!, {
    poolMax: 1,
    applicationName: "native-docker-preflight",
    encryptContent: false,
  });
  try {
    const settings = await runAsSystem("native Docker default placement check", () =>
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { computerHost: true },
      }),
    );
    if (settings?.computerHost !== "this-mac")
      throw new Error(
        "Before using --with-docker, explicitly set the deployment computer preference to this-mac. This preserves existing default-target host computers; the launcher does not change this preference.",
      );
  } finally {
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  }
}

/** Stop only detached process groups created by this launcher, including surviving descendants. */
export async function stopNativeProcessGroups(
  children: readonly ChildProcess[],
  graceMs = 15_000,
): Promise<void> {
  const groups = new Set(children.flatMap((child) => (child.pid ? [child.pid] : [])));
  const signal = (pid: number, name: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  let failure: string | undefined;
  // Do not use ChildProcess.exitCode here: a wrapper may exit before its descendants.
  const remaining = () => {
    for (const pid of groups) {
      try {
        if (!signal(pid, 0)) groups.delete(pid);
      } catch (error) {
        failure = error instanceof Error ? error.message : "process group probe failed";
      }
    }
    return groups.size > 0;
  };
  const waitUntil = async (deadline: number) => {
    while (remaining() && performance.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
  };
  for (const pid of groups) {
    try {
      if (!signal(pid, "SIGTERM")) groups.delete(pid);
    } catch (error) {
      failure = error instanceof Error ? error.message : "process group signal failed";
    }
  }
  await waitUntil(performance.now() + graceMs);
  for (const pid of groups) {
    try {
      if (!signal(pid, "SIGKILL")) groups.delete(pid);
    } catch (error) {
      failure = error instanceof Error ? error.message : "process group signal failed";
    }
  }
  await waitUntil(performance.now() + 1_000);
  // A process group can become unsignalable while its last process exits (EPERM on macOS).
  // A later ESRCH proves cleanup completed; only surviving groups are a shutdown failure.
  if (groups.size)
    throw new Error(
      `Some native process groups could not be stopped.${failure ? ` ${failure}` : ""}`,
    );
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Native stack startup cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function boundedClose(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native host cleanup timed out")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startNativeStack(
  root: string,
  env: NodeJS.ProcessEnv,
  allowHost: boolean,
  withDocker = false,
  options: { signal?: AbortSignal } = {},
) {
  const settings = nativeStackSettings(env, root, allowHost, withDocker);
  const children: ChildProcess[] = [];
  let host: Awaited<ReturnType<typeof startHostComputerServer>> | undefined;
  let closingHost: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const closeHost = () => {
    if (!host) return Promise.resolve();
    closingHost ??= boundedClose(() => host!.close());
    return closingHost;
  };
  const stop = (exitCode = 0): Promise<void> => {
    if (stopping) return stopping;
    // Defer the body so synchronous spawn/error callbacks see stopping immediately.
    stopping = Promise.resolve().then(async () => {
      let failed = false;
      try {
        await stopNativeProcessGroups(children);
      } catch (error) {
        process.stderr.write(
          `Service shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
        failed = true;
      }
      // API and worker must still reach the host while they drain their work.
      try {
        await closeHost();
      } catch (error) {
        process.stderr.write(
          `Host shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
        failed = true;
      }
      options.signal?.removeEventListener("abort", onAbort);
      resolveExit(failed ? 1 : exitCode);
    });
    return stopping;
  };
  const onAbort = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const checkCancelled = () => options.signal?.throwIfAborted();
  try {
    checkCancelled();
    const apiEntry = path.join(root, "apps/api/dist/index.js");
    const workerEntry = path.join(root, "apps/worker/dist/index.js");
    const webRoot = path.join(root, "apps/web");
    if (![apiEntry, workerEntry, path.join(webRoot, "dist/index.html")].every(existsSync))
      throw new Error("Build API, worker and web before starting the native stack.");
    if (withDocker) {
      await abortable(checkNativeDockerSupervisor(settings.env), options.signal);
      checkCancelled();
      await abortable(checkNativeHostDefault(settings.env), options.signal);
      checkCancelled();
    }
    const requireWeb = createRequire(path.join(webRoot, "package.json"));
    const viteEntry = path.resolve(
      path.dirname(requireWeb.resolve("vite/package.json")),
      "bin/vite.js",
    );
    const token = randomBytes(32).toString("hex");
    const openingHost = startHostComputerServer({
      root: settings.dataDir,
      token,
      hostname: "127.0.0.1",
      port: 0,
    }).then(async (opened) => {
      host = opened;
      // Cancellation may win while the bridge is still opening.
      if (stopping || options.signal?.aborted) await closeHost();
      return opened;
    });
    await abortable(openingHost, options.signal);
    checkCancelled();
    host!.setEnabled(true);
    const childEnv = {
      ...settings.env,
      DATA_DIR: settings.dataDir,
      SANDBOX_HOST_URL: `http://127.0.0.1:${host!.port}`,
      SANDBOX_HOST_TOKEN: token,
    };
    for (const [entry, args, cwd] of [
      [apiEntry, [], root],
      [workerEntry, [], root],
      [
        viteEntry,
        ["preview", "--host", "127.0.0.1", "--port", String(settings.webPort), "--strictPort"],
        webRoot,
      ],
    ] as const) {
      checkCancelled();
      if (stopping) throw new Error("Native stack stopped during startup");
      const child = spawn(process.execPath, [entry, ...args], {
        cwd,
        env: childEnv,
        // Keep terminal input with the launcher; Vite must not consume Ctrl+C in raw mode.
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
      children.push(child);
      child.once("error", () => {
        void stop(1);
      });
      child.once("exit", (code) => {
        if (!stopping) void stop(code || 1);
      });
    }
    return { url: settings.env.WEB_ORIGIN, stop, exited };
  } catch (error) {
    await stop(options.signal?.aborted ? 0 : 1);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadRootEnv();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const stack = await startNativeStack(
      root,
      process.env,
      process.argv.includes("--allow-host"),
      process.argv.includes("--with-docker"),
      { signal: controller.signal },
    );
    process.stdout.write(`Rakazo native stack: ${stack.url}\n`);
    process.exitCode = await stack.exited;
  } catch (error) {
    if (!controller.signal.aborted)
      process.stderr.write(`${error instanceof Error ? error.message : "Native stack failed"}\n`);
    process.exitCode = controller.signal.aborted ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  // Cleanup has a deadline; lingering in-process handles must not keep ports occupied.
  process.exit(process.exitCode ?? 0);
}
