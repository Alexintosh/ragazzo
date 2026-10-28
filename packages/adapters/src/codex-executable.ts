import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  managedNativeEnvironment,
  managedNativeExecutable,
  privateManagedMarker,
} from "./native-setup-paths.js";
import { hostCommandEnvironment } from "./sandbox-command-environment.js";

/** Finder does not inherit a login shell's PATH. Resolve known locations without executing a shell. */
export function resolveCodexExecutable(
  options: {
    name?: "codex" | "claude";
    managedRoot?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    execPath?: string;
    canExecute?: (candidate: string) => boolean;
  } = {},
) {
  const inherited = options.env ?? process.env;
  const name = options.name ?? "codex";
  const managed = options.managedRoot && managedNativeExecutable(options.managedRoot, name);
  const directories = [
    ...new Set([
      ...(inherited.PATH ?? "")
        .split(path.delimiter)
        .filter((directory) => path.isAbsolute(directory)),
      path.join(options.home ?? homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.dirname(options.execPath ?? process.execPath),
      "/usr/bin",
      "/bin",
    ]),
  ];
  const canExecute =
    options.canExecute ??
    ((candidate: string) => {
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const executable =
    managed && canExecute(managed)
      ? managed
      : directories.map((directory) => path.join(directory, name)).find(canExecute);
  if (!executable) throw new Error(`Native ${options.name ?? "codex"} CLI is unavailable`);
  return {
    executable,
    env: {
      ...hostCommandEnvironment({}, inherited),
      PATH: directories.join(path.delimiter),
      ...(options.managedRoot &&
      (managed || privateManagedMarker(options.managedRoot, name, "authenticated.json"))
        ? managedNativeEnvironment(options.managedRoot, name)
        : {}),
    },
  };
}
