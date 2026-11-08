import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalWriteScope,
  defaultNativeWriteScopeDirectory,
  NativeWriteScopes,
  scopesOverlap,
  validWriteSubdirectory,
} from "./native-write-scope.js";

describe("native write scope enforcement", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-scopes-")));
    await mkdir(path.join(root, "project", "left"), { recursive: true });
    await mkdir(path.join(root, "project", "right"), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  it("uses one per-user production location and refuses unsafe coordinator roots and self-modification", async () => {
    expect(path.basename(defaultNativeWriteScopeDirectory())).toBe(".rakazo-native-write-scopes");
    const directory = path.join(root, "private");
    await mkdir(directory, { mode: 0o700 });
    await symlink(directory, path.join(root, "alias"));
    await expect(
      new NativeWriteScopes(path.join(root, "alias", "locks")).acquire(
        "alias",
        "/project",
        () => false,
      ),
    ).rejects.toThrow("canonical private");
    await chmod(directory, 0o755);
    await expect(
      new NativeWriteScopes(directory).acquire("public", "/project", () => false),
    ).rejects.toThrow("canonical private");
    await chmod(directory, 0o700);
    await expect(
      new NativeWriteScopes(directory).acquire("self", root, () => false),
    ).rejects.toThrow("private native state");
  });
  it("allows strict existing children and rejects aliases and folder escapes", async () => {
    const project = path.join(root, "project");
    expect(await canonicalWriteScope(project, "left")).toBe(path.join(project, "left"));
    await symlink(path.join(project, "left"), path.join(project, "alias"));
    await symlink(root, path.join(project, "outside"));
    for (const subdirectory of ["alias", "outside", "../project", "left/../right", "missing"])
      await expect(canonicalWriteScope(project, subdirectory)).rejects.toThrow();
    for (const value of ["", "/tmp", ".", "..", "a//b", "a\\b", "a\0b"])
      expect(validWriteSubdirectory(value)).toBe(false);
    expect(scopesOverlap("/project/a", "/project/ab")).toBe(false);
    expect(scopesOverlap("/project/a", "/project/a/child")).toBe(true);
  });
  it("overlaps disjoint writers across broker instances and queues ancestors and full access", async () => {
    const first = new NativeWriteScopes(path.join(root, "locks"));
    const other = new NativeWriteScopes(path.join(root, "locks"));
    const left = await first.acquire("bot-a:computer-a:run-a", "/project/left", () => false);
    const right = await other.acquire("bot-a:computer-b:run-b", "/project/right", () => false);
    let entered = false;
    const waiting = other
      .acquire("bot-b:computer-c:run-c", "/project", () => false)
      .then((release) => {
        entered = true;
        return release;
      });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(entered).toBe(false);
    await left();
    await writeFile(path.join(root, "right-still-active"), "yes");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(entered).toBe(false);
    await right();
    await (await waiting)();
    const all = await first.acquire("full", null, () => false);
    let stopped = false;
    const blocked = other.acquire("child", "/project/left", () => stopped);
    stopped = true;
    await expect(blocked).rejects.toThrow("stopped");
    await all();
  });
  it("rejects existing hardlink aliases before a sandbox can write their shared inode", async () => {
    const project = path.join(root, "project");
    await writeFile(path.join(project, "right", "shared"), "initial");
    await link(path.join(project, "right", "shared"), path.join(project, "left", "alias"));
    await expect(canonicalWriteScope(project, "left")).rejects.toThrow("hardlinked");
    await expect(canonicalWriteScope(project, "right")).rejects.toThrow("hardlinked");
  });
  it("retains uncertain claims across restarts and does not release another owner's token", async () => {
    const directory = path.join(root, "locks");
    const original = new NativeWriteScopes(directory);
    const release = await original.acquire("old-process", "/project/left", () => false);
    const restarted = new NativeWriteScopes(directory);
    let stopped = false;
    const blocked = restarted.acquire("new-process", "/project/left", () => stopped);
    setTimeout(() => {
      stopped = true;
    }, 70);
    await expect(blocked).rejects.toThrow("stopped");
    await release();
    await (await restarted.acquire("new-process", "/project/left", () => false))();
  });
});
