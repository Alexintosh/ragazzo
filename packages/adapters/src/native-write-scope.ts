import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export function defaultNativeWriteScopeDirectory(): string {
  return path.join(homedir(), ".rakazo-native-write-scopes");
}

async function privateCoordinatorDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw new Error("Native write coordinator requires a canonical private directory");
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      info = await lstat(current);
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new Error("Native write coordinator requires a canonical private directory");
    if (
      current === directory &&
      ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)
    )
      throw new Error("Native write coordinator requires a canonical private directory");
  }
  if ((await realpath(directory)) !== directory)
    throw new Error("Native write coordinator requires a canonical private directory");
}

export function scopesOverlap(left: string | null, right: string | null): boolean {
  return (
    left === null ||
    right === null ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function validWriteSubdirectory(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export async function canonicalWriteScope(
  project: string,
  subdirectory?: string,
  verifyFiles = true,
): Promise<string> {
  if (
    !path.isAbsolute(project) ||
    (await realpath(project)) !== project ||
    !(await stat(project)).isDirectory()
  )
    throw new Error("Native work requires a canonical existing project directory");
  if (!subdirectory) return project;
  if (!validWriteSubdirectory(subdirectory))
    throw new Error("Choose an existing project subdirectory");
  const candidate = path.join(project, subdirectory);
  const canonical = await realpath(candidate);
  if (
    !canonical.startsWith(`${project}/`) ||
    canonical !== candidate ||
    !(await stat(canonical)).isDirectory()
  )
    throw new Error("Task write scope must be a canonical existing project subdirectory");
  if (!verifyFiles) return canonical;
  // Native path sandboxes cannot distinguish pre-existing hardlink aliases to
  // the same inode outside the scope. Refuse them before granting any writer.
  const pending = [canonical];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 200_000) throw new Error("Task write scope is too large to verify safely");
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isFile() && info.nlink > 1)
        throw new Error("Task write scope contains a hardlinked file");
      if (info.isDirectory()) pending.push(target);
    }
  }
  return canonical;
}

type Claim = { id: string; root: string | null; ownerRunId?: string };
// A private host-wide disk fence survives lost worker leases and bridge restarts.
// Uncertain ownership is deliberately retained until verified process cleanup.
export class NativeWriteScopes {
  constructor(private readonly directory = defaultNativeWriteScopeDirectory()) {}
  async acquire(
    id: string,
    root: string | null,
    stopped: () => boolean,
    ownerRunId?: string,
  ): Promise<() => Promise<void>> {
    await privateCoordinatorDirectory(this.directory);
    if (root !== null && scopesOverlap(root, this.directory))
      throw new Error("Task write scope overlaps private native state");
    const name = `${createHash("sha256").update(id).digest("hex")}.json`;
    const token = randomUUID();
    while (!stopped()) {
      const mutex = path.join(this.directory, "mutex");
      try {
        await mkdir(mutex, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      try {
        const claims = await Promise.all(
          (await readdir(this.directory))
            .filter((entry) => entry.endsWith(".json"))
            .map(async (entry) => {
              try {
                return JSON.parse(
                  await readFile(path.join(this.directory, entry), "utf8"),
                ) as Claim;
              } catch (error) {
                // Verified cleanup can release a claim while its filename is being listed.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
              }
            }),
        );
        if (
          !claims.some(
            (claim) =>
              claim &&
              !(ownerRunId && claim.ownerRunId === ownerRunId) &&
              scopesOverlap(claim.root, root),
          )
        ) {
          await writeFile(
            path.join(this.directory, name),
            JSON.stringify({ id, root, token, ownerRunId }),
            { flag: "wx", mode: 0o600 },
          );
          return async () => {
            const current = JSON.parse(await readFile(path.join(this.directory, name), "utf8"));
            if (current.token !== token) throw new Error("Native write scope ownership changed");
            await rm(path.join(this.directory, name));
          };
        }
      } finally {
        await rm(mutex, { recursive: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("Native task stopped while waiting for its write scope");
  }
}
