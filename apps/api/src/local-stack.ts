import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  checkNativeDockerSupervisor,
  nativeStackSettings,
  startNativeStack,
  stopNativeProcessGroups,
} from "./native-stack.js";

const exec = promisify(execFile);

/** A managed supervisor is local only; remote deployments keep using native:start. */
export function localSupervisorAddress(env: NodeJS.ProcessEnv) {
  const url = new URL(env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "make start requires a loopback HTTP supervisor URL without a path. Use native:start for an external supervisor.",
    );
  const port = Number(url.port || 80);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("The local supervisor port must be from 1024 through 65535.");
  return { port, url: `http://127.0.0.1:${port}` };
}

export async function localPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Resolve the CLI's selected context rather than trusting a possibly stale default socket. */
export async function localDockerEnvironment(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  signal.throwIfAborted();
  let socket = env.DOCKER_SOCKET?.trim();
  if (!socket) {
    const endpoint =
      (!env.DOCKER_CONTEXT?.trim() && env.DOCKER_HOST?.trim()) ||
      (
        await exec("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
          env,
          signal,
          timeout: 5_000,
        })
      ).stdout.trim();
    if (!endpoint.startsWith("unix://"))
      throw new Error("The managed local supervisor requires a local Unix Docker socket.");
    socket = endpoint.slice("unix://".length);
  }
  if (!path.isAbsolute(socket)) throw new Error("DOCKER_SOCKET must be an absolute path.");
  const resolved: NodeJS.ProcessEnv = {
    ...env,
    DOCKER_SOCKET: socket,
    DOCKER_HOST: `unix://${socket}`,
  };
  // Docker context env can otherwise override the socket we just resolved.
  delete resolved.DOCKER_CONTEXT;
  return resolved;
}

export async function runLocalStack(
  root: string,
  env: NodeJS.ProcessEnv,
  allowHost: boolean,
  signal: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const address = localSupervisorAddress(env);
  const settings = nativeStackSettings(
    { ...env, SANDBOX_SUPERVISOR_URL: address.url },
    root,
    allowHost,
    true,
  );
  let supervisor: ChildProcess | undefined;
  let supervisorFailed = false;
  let stack: Awaited<ReturnType<typeof startNativeStack>> | undefined;
  let exitCode = 0;
  try {
    combined.throwIfAborted();
    for (const [name, port] of [
      ["API", settings.apiPort],
      ["Web", settings.webPort],
    ] as const) {
      if (!(await localPortFree(port)))
        throw new Error(
          `${name} port ${port} is already in use. Stop its existing launcher before starting another stack.`,
        );
    }
    if (address.port === settings.apiPort || address.port === settings.webPort)
      throw new Error("The supervisor, API and web ports must differ.");
    if (await localPortFree(address.port)) {
      const dockerEnv = await localDockerEnvironment(settings.env, combined);
      const requireSupervisor = createRequire(
        path.join(root, "infra/sandboxes/supervisor/package.json"),
      );
      const Docker = requireSupervisor("dockerode");
      const docker = new Docker({ socketPath: dockerEnv.DOCKER_SOCKET, timeout: 5_000 });
      const image = env.RAKAZO_COMPUTER_IMAGE?.trim() || "rakazo/computer:local";
      const tag = env.RAKAZO_COMPUTER_IMAGE_TAG?.trim();
      const fullImage =
        tag && !image.includes("@") && !image.slice(image.lastIndexOf("/") + 1).includes(":")
          ? `${image}:${tag}`
          : image;
      try {
        await docker.ping();
        await docker.getImage(fullImage).inspect();
      } catch {
        throw new Error(
          "Docker is unavailable or the configured computer image is missing. Start Docker and install the image explicitly; make start does not build or download it.",
        );
      }
      combined.throwIfAborted();
      supervisor = spawn(
        process.execPath,
        ["--import", "tsx", path.join(root, "infra/sandboxes/supervisor/src/index.ts")],
        {
          cwd: root,
          env: {
            ...dockerEnv,
            SUPERVISOR_HOST: "127.0.0.1",
            SUPERVISOR_PORT: String(address.port),
            SANDBOX_CONTROL_VIA_LOOPBACK: env.SANDBOX_CONTROL_VIA_LOOPBACK ?? "true",
            SANDBOX_AUTO_BUILD_IMAGE: "false",
          },
          // Keep terminal input with the launcher; Vite must not consume Ctrl+C in raw mode.
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
        },
      );
      const failed = () => {
        supervisorFailed = true;
        controller.abort();
      };
      supervisor.once("error", failed);
      supervisor.once("exit", failed);
      const deadline = Date.now() + 20_000;
      while (true) {
        combined.throwIfAborted();
        try {
          await checkNativeDockerSupervisor(settings.env);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
        }
        await delay(150, undefined, { signal: combined });
      }
    } else {
      await checkNativeDockerSupervisor(settings.env);
      process.stdout.write(
        "Using the existing supervisor; it will remain running when this stack stops.\n",
      );
    }
    combined.throwIfAborted();
    stack = await startNativeStack(root, settings.env, allowHost, true, { signal: combined });
    process.stdout.write(
      `Rakazo: ${stack.url}\nCtrl+C stops the services started by this command.\n`,
    );
    exitCode = await stack.exited;
    if (supervisorFailed) throw new Error("The local Docker supervisor stopped unexpectedly.");
  } catch (error) {
    if (!signal.aborted || supervisorFailed) {
      process.stderr.write(
        `${supervisorFailed ? "The local Docker supervisor stopped unexpectedly." : error instanceof Error ? error.message : "Local stack failed"}\n`,
      );
      exitCode = 1;
    }
  } finally {
    await stack?.stop(exitCode).catch(() => {
      exitCode = 1;
    });
    if (supervisor) {
      supervisor.removeAllListeners("exit");
      await stopNativeProcessGroups([supervisor]).catch((error) => {
        process.stderr.write(
          `Supervisor shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
        exitCode = 1;
      });
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  loadRootEnv();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    process.exit(
      await runLocalStack(
        root,
        process.env,
        process.argv.includes("--allow-host"),
        controller.signal,
      ),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Local stack failed"}\n`);
    process.exit(1);
  }
}
