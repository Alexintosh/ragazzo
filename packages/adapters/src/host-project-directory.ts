import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { z } from "zod";
import type { HostDirectoryTransportOptions } from "./host-directories.js";
import { selectedHostDirectoryTransport } from "./host-directories.js";

/** Resolve user-entered aliases once; execution still requires this canonical path unchanged. */
export async function resolveHostProjectDirectory(
  requested: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!path.isAbsolute(requested) || requested.includes("\0"))
    throw new Error("Choose an absolute host project path");
  signal?.throwIfAborted();
  const canonical = await realpath(requested);
  const before = await stat(canonical);
  if (!before.isDirectory()) throw new Error("Choose an existing host project directory");
  const after = await stat(canonical);
  if (
    (await realpath(requested)) !== canonical ||
    (await realpath(canonical)) !== canonical ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw new Error("Host project directory changed while resolving");
  signal?.throwIfAborted();
  return canonical;
}

const ProjectDirectory = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
  })
  .strict();

export function createHostProjectDirectoryTransport(options: HostDirectoryTransportOptions) {
  return async (
    input: { hostId: string | null; path: string },
    context: AdapterContext,
  ): Promise<string> => {
    const { transport, validate } = await selectedHostDirectoryTransport(
      options,
      input.hostId,
      context,
    );
    let result: string | undefined;
    for await (const value of transport.request<{ path: string }>(
      { method: "hostProjectDirectory", botId: "setup", path: input.path },
      { ...context, runId: undefined },
    ))
      result = ProjectDirectory.parse(value).path;
    await validate();
    if (!result) throw new Error("Host project directory unavailable");
    return result;
  };
}
