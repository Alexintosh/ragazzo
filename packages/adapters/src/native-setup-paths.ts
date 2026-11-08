import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

/** All setup writes are descendants of the host operator's chosen root, without links. */
export async function setupDirectory(root: string, ...parts: string[]) {
  let target = path.resolve(root);
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await lstat(target)).isSymbolicLink()) throw new Error("Unsafe setup directory");
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")
      throw new Error("Unsafe setup directory");
    target = path.join(target, part);
    await mkdir(target, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe setup directory");
  }
  return target;
}
export async function readSetupFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 65536 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe setup file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function writeSetupFile(file: string, value: unknown) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
  } finally {
    await handle.close();
  }
}
export function managedNativeEnvironment(root: string, kind: "codex" | "claude") {
  const base = path.join(root, "native-tools", kind);
  return {
    HOME: path.join(base, "home"),
    CODEX_HOME: path.join(base, "home", ".codex"),
    CLAUDE_CONFIG_DIR: path.join(base, "home", ".claude"),
    XDG_CONFIG_HOME: path.join(base, "home", ".config"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    TMPDIR: path.join(base, "tmp"),
    TEMP: path.join(base, "tmp"),
    TMP: path.join(base, "tmp"),
    npm_config_cache: path.join(base, "cache"),
    npm_config_userconfig: path.join(base, "npmrc"),
    npm_config_globalconfig: path.join(base, "npmrc-global"),
    npm_config_registry: "https://registry.npmjs.org",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}
export function managedNativeExecutable(root: string, kind: "codex" | "claude") {
  const base = path.join(root, "native-tools", kind);
  // The ready marker is created only after the installer exits successfully.
  if (!privateManagedMarker(root, kind, "installed.json")) return undefined;
  const executable = path.join(base, "node_modules", ".bin", kind);
  try {
    const resolved = realpathSync(executable),
      prefix = `${realpathSync(base)}${path.sep}`;
    if (!resolved.startsWith(prefix)) return undefined;
    return executable;
  } catch {
    return undefined;
  }
}
export function privateManagedMarker(
  root: string,
  kind: "codex" | "claude",
  name: "installed.json" | "authenticated.json",
) {
  try {
    let directory = path.resolve(root);
    if (lstatSync(directory).isSymbolicLink()) return false;
    for (const part of ["native-tools", kind]) {
      directory = path.join(directory, part);
      const info = lstatSync(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        return false;
    }
    const info = lstatSync(path.join(directory, name));
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size <= 65536 &&
      (info.mode & 0o077) === 0 &&
      (!process.getuid || info.uid === process.getuid())
    );
  } catch {
    return false;
  }
}
