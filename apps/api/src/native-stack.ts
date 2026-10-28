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

export async function startNativeStack(
  root: string,
  env: NodeJS.ProcessEnv,
  allowHost: boolean,
  withDocker = false,
) {
  const settings = nativeStackSettings(env, root, allowHost, withDocker);
  const apiEntry = path.join(root, "apps/api/dist/index.js");
  const workerEntry = path.join(root, "apps/worker/dist/index.js");
  const webRoot = path.join(root, "apps/web");
  if (![apiEntry, workerEntry, path.join(webRoot, "dist/index.html")].every(existsSync))
    throw new Error("Build API, worker and web before starting the native stack.");
  if (withDocker) {
    await checkNativeDockerSupervisor(settings.env);
    await checkNativeHostDefault(settings.env);
  }
  const requireWeb = createRequire(path.join(webRoot, "package.json"));
  const viteEntry = path.resolve(
    path.dirname(requireWeb.resolve("vite/package.json")),
    "bin/vite.js",
  );
  const token = randomBytes(32).toString("hex");
  const host = await startHostComputerServer({
    root: settings.dataDir,
    token,
    hostname: "127.0.0.1",
    port: 0,
  });
  host.setEnabled(true);
  const children: ChildProcess[] = [];
  let stopping: Promise<void> | undefined;
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const childEnv = {
    ...settings.env,
    DATA_DIR: settings.dataDir,
    SANDBOX_HOST_URL: `http://127.0.0.1:${host.port}`,
    SANDBOX_HOST_TOKEN: token,
  };
  const stop = (exitCode = 0): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      let failed = false;
      try {
        await host.close();
      } catch {
        failed = true;
      }
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
          const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          const signal = (name: NodeJS.Signals) => {
            try {
              process.kill(-child.pid!, name);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed = true;
            }
          };
          signal("SIGTERM");
          const kill = setTimeout(() => signal("SIGKILL"), 15_000);
          try {
            await closed;
          } finally {
            clearTimeout(kill);
          }
        }),
      );
      resolveExit!(failed ? 1 : exitCode);
    })();
    return stopping;
  };
  try {
    for (const [entry, args, cwd] of [
      [apiEntry, [], root],
      [workerEntry, [], root],
      [
        viteEntry,
        ["preview", "--host", "127.0.0.1", "--port", String(settings.webPort), "--strictPort"],
        webRoot,
      ],
    ] as const) {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd,
        env: childEnv,
        stdio: "inherit",
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
  } catch (error) {
    await stop(1);
    throw error;
  }
  return { url: settings.env.WEB_ORIGIN, stop, exited };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadRootEnv();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const stack = await startNativeStack(
      root,
      process.env,
      process.argv.includes("--allow-host"),
      process.argv.includes("--with-docker"),
    );
    process.once("SIGINT", () => {
      void stack.stop();
    });
    process.once("SIGTERM", () => {
      void stack.stop();
    });
    process.stdout.write(`Rakazo native stack: ${stack.url}\n`);
    process.exitCode = await stack.exited;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Native stack failed"}\n`);
    process.exitCode = 1;
  }
}
