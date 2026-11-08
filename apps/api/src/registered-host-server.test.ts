import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOrCreateHostToken, runRegisteredHost } from "./registered-host-server.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("registered host local consent and credential file", () => {
  it("requires local consent before creating any host files or listener", async () => {
    await expect(runRegisteredHost([])).rejects.toThrow("--allow-host");
  });
  it("reuses a private token and rejects world-readable files and symlinks", async () => {
    root = await mkdtemp(join(tmpdir(), "host-token-"));
    const file = join(root, "credential");
    const token = await readOrCreateHostToken(file);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readOrCreateHostToken(file)).toBe(token);
    expect(await readFile(file, "utf8")).toBe(token);
    await chmod(file, 0o644);
    await expect(readOrCreateHostToken(file)).rejects.toThrow("private");
    await chmod(file, 0o600);
    const link = join(root, "linked");
    await symlink(file, link);
    await expect(readOrCreateHostToken(link)).rejects.toThrow();
  });
});
