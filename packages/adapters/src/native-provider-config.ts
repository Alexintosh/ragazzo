import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AcpHostConfiguration } from "./acp-client.js";

const schema = z
  .object({
    acp: z
      .object({
        command: z.string().min(1).max(4096),
        args: z.array(z.string().max(8192)).max(128),
        identity: z.string().min(1).max(256),
      })
      .strict()
      .optional(),
  })
  .strict();
/** The only ACP command source is the host operator's private local configuration. */
export async function readNativeProviderConfiguration(
  root: string,
): Promise<{ acp?: AcpHostConfiguration }> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path.join(root, "native-providers.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 65536 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Native provider configuration must be a private host-owned file");
    return schema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}
