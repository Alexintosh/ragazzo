import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startHostComputerServer } from "@rakazo/adapters";

/** Credentials are local files; neither process arguments nor startup output contain them. */
export async function readOrCreateHostToken(file: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(randomBytes(32).toString("hex"));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
  } finally {
    await handle?.close();
  }
  const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await reader.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("Host token file must be private (mode 600)");
    const token = (await reader.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid host token file");
    return token;
  } finally {
    await reader.close();
  }
}

export async function runRegisteredHost(args: string[]) {
  if (!args.includes("--allow-host"))
    throw new Error("Pass --allow-host locally to enable host command access");
  function option(name: string, fallback: string) {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing ${name} value`);
    return value;
  }
  const root = resolve(option("--data-dir", join(homedir(), ".rakazo", "host")));
  const tokenFile = resolve(option("--token-file", join(root, "host-token")));
  const port = Number(option("--port", "7092"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid host port");
  const server = await startHostComputerServer({
    root,
    token: await readOrCreateHostToken(tokenFile),
    hostname: "127.0.0.1",
    port,
  });
  server.setEnabled(true);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRegisteredHost(process.argv.slice(2))
    .then((host) => {
      process.stdout.write(
        `Host bridge listening on loopback port ${host.port}. Host access is enabled until this process stops.\n`,
      );
      const stop = () => {
        void host.close().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch(() => {
      process.stderr.write(
        "Host bridge could not start. Check local consent, port and the private token file.\n",
      );
      process.exitCode = 1;
    });
}
