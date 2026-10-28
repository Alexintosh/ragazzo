import { mkdir, mkdtemp, opendir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDirectoriesTransport, listHostDirectories } from "./host-directories.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(opendir).mockClear();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixtureDirectory() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-folder-test-")));
  temporary.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  return { root, home };
}

describe("host directory browsing", () => {
  it("returns only directories, canonical paths and bounded parents without writing", async () => {
    const { home } = await fixtureDirectory();
    await mkdir(path.join(home, "project"));
    await writeFile(path.join(home, "private-file"), "not returned");
    expect(await listHostDirectories(undefined, home)).toEqual({
      path: home,
      parent: null,
      directories: [{ name: "project", path: path.join(home, "project") }],
      truncated: false,
    });
    expect(await listHostDirectories(path.join(home, "project"), home)).toEqual({
      path: path.join(home, "project"),
      parent: home,
      directories: [],
      truncated: false,
    });
  });
  it("rejects relative paths, files, traversal and symlink escapes", async () => {
    const { home, root } = await fixtureDirectory();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(home, "escape"));
    await writeFile(path.join(home, "file"), "private");
    expect((await listHostDirectories(undefined, home)).directories).toEqual([]);
    for (const target of [
      "relative",
      path.join(home, "..", "outside"),
      path.join(home, "escape"),
      path.join(home, "file"),
    ])
      await expect(listHostDirectories(target, home)).rejects.toThrow();
  });
  it("propagates denied-directory failures and does not return cancelled listings", async () => {
    const { home } = await fixtureDirectory();
    vi.mocked(opendir).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    await expect(listHostDirectories(undefined, home)).rejects.toThrow("denied");
    await expect(listHostDirectories(undefined, home, AbortSignal.abort())).rejects.toThrow();
  });
});

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
function transportFixture() {
  const host = { id: "host", endpoint: "https://host.example.test", ciphertext: "encrypted" };
  const prisma = {
    registeredHost: { findFirst: vi.fn(async () => host), count: vi.fn(async () => 1) },
  };
  const secrets = { load: vi.fn(async () => "fake-token") };
  const listing = { path: "/home/test", parent: null, directories: [], truncated: false };
  const fetcher = vi.fn(
    async () => new Response(`${JSON.stringify({ value: listing })}\n{"done":true}\n`),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    prisma,
    secrets,
    fetcher,
    request: createHostDirectoriesTransport({
      prisma: prisma as unknown as PrismaClient,
      secrets: secrets as unknown as SecretStore,
      hostComputerUrl: "https://local.example.test",
      hostComputerToken: "fake-local-token",
    }),
  };
}
describe("selected-host directory transport", () => {
  it("binds registration credentials to the authenticated actor and sends read-only intent", async () => {
    const f = transportFixture();
    await f.request({ hostId: "host", path: "/home/test" }, context);
    expect(f.prisma.registeredHost.findFirst).toHaveBeenCalledWith({
      where: { id: "host", spaceId: "space", userId: "owner", revokedAt: null },
    });
    const [url, options] = f.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://host.example.test/computer");
    expect(JSON.parse(options.body as string)).toEqual({
      method: "hostDirectories",
      botId: "setup",
      path: "/home/test",
    });
  });
  it("uses only the configured local bridge for a null host", async () => {
    const f = transportFixture();
    await f.request({ hostId: null }, context);
    const [url] = f.fetcher.mock.calls[0] as unknown as [URL];
    expect(url.href).toBe("https://local.example.test/computer");
    expect(f.prisma.registeredHost.findFirst).not.toHaveBeenCalled();
    expect(f.secrets.load).not.toHaveBeenCalled();
  });
  it("never falls back to local for foreign, unavailable or revoked host IDs", async () => {
    const f = transportFixture();
    f.prisma.registeredHost.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.request({ hostId: "foreign" }, context)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.secrets.load).not.toHaveBeenCalled();
  });
  it("suppresses in-flight directory results when the registration is revoked", async () => {
    const f = transportFixture();
    f.prisma.registeredHost.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(f.request({ hostId: "host" }, context)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
