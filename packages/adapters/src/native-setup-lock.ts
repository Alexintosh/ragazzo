import { randomUUID } from "node:crypto";
import { lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readSetupFile, setupDirectory, writeSetupFile } from "./native-setup-paths.js";

/** A crash leaves this fence in place. Only the manager that created it may release it. */
export async function acquireSetupProviderLock(
  root: string,
  kind: string,
  owner: { sessionId: string; registrationId: string | null; scopeKey: string },
) {
  if (kind !== "codex" && kind !== "claude") throw new Error("Invalid setup provider");
  const directory = path.join(await setupDirectory(root, "native-setup", "locks"), kind);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Runtime setup is already pending or cleanup uncertain");
    throw error;
  }
  const identity = await lstat(directory);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    (identity.mode & 0o077) !== 0 ||
    (process.getuid && identity.uid !== process.getuid())
  )
    throw new Error("Unsafe setup lock");
  const token = randomUUID();
  const file = path.join(directory, "owner.json");
  await writeSetupFile(file, { ...owner, token });
  return async () => {
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (current.mode & 0o077) !== 0 ||
      (process.getuid && current.uid !== process.getuid())
    )
      throw new Error("Runtime setup lock ownership changed");
    const currentOwner = await readSetupFile(file);
    if (currentOwner.sessionId !== owner.sessionId || currentOwner.token !== token)
      throw new Error("Runtime setup lock ownership changed");
    await unlink(file);
    await rmdir(directory);
  };
}
