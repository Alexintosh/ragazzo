import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { HostDirectoriesInput, HostDirectoriesView } from "@rakazo/contracts";
import { HostDirectoriesViewSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { registeredHostEndpoint } from "./registered-hosts.js";

/** Read-only host browsing shares the bridge's existing home-directory boundary. */
export async function listHostDirectories(
  requested?: string,
  home = homedir(),
  signal?: AbortSignal,
): Promise<HostDirectoriesView> {
  if (requested !== undefined && (!path.isAbsolute(requested) || requested.includes("\0")))
    throw new Error("Invalid host directory");
  signal?.throwIfAborted();
  const root = await realpath(home);
  const target = await realpath(requested ?? root);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Host directory is outside the browsing root");
  const before = await stat(target);
  if (!before.isDirectory()) throw new Error("Host directory unavailable");
  const directories: HostDirectoriesView["directories"] = [];
  let truncated = false;
  let scanned = 0;
  for await (const entry of await opendir(target)) {
    signal?.throwIfAborted();
    if (++scanned > 10_000) {
      truncated = true;
      break;
    }
    // Do not follow child symlinks, including links outside the browsing root.
    if (!entry.isDirectory()) continue;
    if (directories.length === 500) {
      truncated = true;
      break;
    }
    directories.push({ name: entry.name, path: path.join(target, entry.name) });
  }
  signal?.throwIfAborted();
  const after = await stat(target);
  if ((await realpath(target)) !== target || before.dev !== after.dev || before.ino !== after.ino)
    throw new Error("Host directory changed while browsing");
  directories.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: target,
    parent: target === root ? null : path.dirname(target),
    directories,
    truncated,
  };
}

export type HostDirectoryTransportOptions = {
  prisma: PrismaClient;
  secrets: SecretStore;
  hostComputerUrl?: string;
  hostComputerToken?: string;
};

/** Bind every host read to server-owned credentials and the active tenant registration. */
export async function selectedHostDirectoryTransport(
  options: HostDirectoryTransportOptions,
  hostId: string | null,
  context: AdapterContext,
) {
  if (!context.spaceId || !context.userId) throw new Error("Host directory unavailable");
  const where = hostId
    ? { id: hostId, spaceId: context.spaceId, userId: context.userId, revokedAt: null }
    : undefined;
  const host = where ? await options.prisma.registeredHost.findFirst({ where }) : undefined;
  if (where && !host) throw new Error("Host directory unavailable");
  const validate = async () => {
    if (where && !(await options.prisma.registeredHost.count({ where })))
      throw new Error("Host directory unavailable");
  };
  const transport = new HostComputerSandbox(async () => ({
    url: host ? registeredHostEndpoint(host.endpoint) : (options.hostComputerUrl ?? ""),
    token: host
      ? await options.secrets.load(host.ciphertext, host.id)
      : (options.hostComputerToken ?? ""),
    validate,
  }));
  return { transport, validate };
}

export function createHostDirectoriesTransport(options: HostDirectoryTransportOptions) {
  return async (
    input: HostDirectoriesInput,
    context: AdapterContext,
  ): Promise<HostDirectoriesView> => {
    const { transport, validate } = await selectedHostDirectoryTransport(
      options,
      input.hostId,
      context,
    );
    let result: HostDirectoriesView | undefined;
    for await (const value of transport.request<HostDirectoriesView>(
      { method: "hostDirectories", botId: "setup", ...(input.path ? { path: input.path } : {}) },
      { ...context, runId: undefined },
    ))
      result = HostDirectoriesViewSchema.parse(value);
    await validate();
    if (!result) throw new Error("Host directory unavailable");
    return result;
  };
}
