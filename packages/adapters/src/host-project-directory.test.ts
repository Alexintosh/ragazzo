import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostComputerRequest } from "./host-computer-protocol.js";
import {
  createHostProjectDirectoryTransport,
  resolveHostProjectDirectory,
} from "./host-project-directory.js";
import { canonicalWriteScope } from "./native-write-scope.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixtureDirectory() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-project-test-")));
  temporary.push(root);
  const project = path.join(root, "project");
  const alias = path.join(root, "alias");
  await mkdir(project);
  await symlink(project, alias);
  return { root, project, alias };
}

describe("native project configuration paths", () => {
  it("accepts an existing directory alias while preserving the canonical runtime guard", async () => {
    const { project, alias } = await fixtureDirectory();
    expect(await resolveHostProjectDirectory(`${alias}/.`)).toBe(project);
    await expect(canonicalWriteScope(alias)).rejects.toThrow("canonical existing");
    expect(await canonicalWriteScope(await resolveHostProjectDirectory(alias))).toBe(project);
  });
  it("pins the selected directory when the user-entered alias later changes", async () => {
    const { root, project, alias } = await fixtureDirectory();
    const saved = await resolveHostProjectDirectory(alias);
    const other = path.join(root, "other");
    await mkdir(other);
    await rm(alias);
    await symlink(other, alias);
    expect(await canonicalWriteScope(saved)).toBe(project);
    expect(await resolveHostProjectDirectory(alias)).toBe(other);
    // Replacing the saved canonical path with a symlink also remains fail-closed at execution.
    await rm(project, { recursive: true });
    await symlink(other, project);
    await expect(canonicalWriteScope(saved)).rejects.toThrow("canonical existing");
  });
  it("rejects missing directories, files, relative paths and cancelled requests", async () => {
    const { root, project } = await fixtureDirectory();
    const file = path.join(root, "file");
    await writeFile(file, "fixture");
    for (const requested of [path.join(root, "missing"), file, "relative", `${project}\0bad`])
      await expect(resolveHostProjectDirectory(requested)).rejects.toThrow();
    await expect(resolveHostProjectDirectory(project, AbortSignal.abort())).rejects.toThrow();
  });
  it("strictly bounds the read-only host request and rejects execution fields", () => {
    const request = { method: "hostProjectDirectory", botId: "setup", path: "/project" };
    expect(hostComputerRequest.safeParse(request).success).toBe(true);
    for (const injected of [{ runId: "run" }, { command: ["sh"] }, { botId: "bot" }])
      expect(hostComputerRequest.safeParse({ ...request, ...injected }).success).toBe(false);
  });
});

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
function fixture() {
  const prisma = {
    registeredHost: {
      findFirst: vi.fn(async () => ({
        id: "remote",
        endpoint: "https://host.example.test",
        ciphertext: "encrypted",
      })),
      count: vi.fn(async () => 1),
    },
  };
  const secrets = { load: vi.fn(async () => "fake-token") };
  const fetcher = vi.fn(
    async () => new Response('{"value":{"path":"/remote/canonical/project"}}\n{"done":true}\n'),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    prisma,
    secrets,
    fetcher,
    resolve: createHostProjectDirectoryTransport({
      prisma: prisma as unknown as PrismaClient,
      secrets: secrets as unknown as SecretStore,
      hostComputerUrl: "https://local.example.test",
      hostComputerToken: "fake-local-token",
    }),
  };
}
describe("selected host project resolution", () => {
  it("uses the selected host's canonical result without resolving on the API filesystem", async () => {
    const f = fixture();
    expect(await f.resolve({ hostId: "remote", path: "/remote/alias" }, context)).toBe(
      "/remote/canonical/project",
    );
    expect(f.prisma.registeredHost.findFirst).toHaveBeenCalledWith({
      where: { id: "remote", spaceId: "space", userId: "owner", revokedAt: null },
    });
    const [url, options] = f.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://host.example.test/computer");
    expect(JSON.parse(options.body as string)).toEqual({
      method: "hostProjectDirectory",
      botId: "setup",
      path: "/remote/alias",
    });
  });
  it("uses the configured local bridge for local project aliases", async () => {
    const f = fixture();
    await f.resolve({ hostId: null, path: "/tmp/project" }, context);
    expect(f.prisma.registeredHost.findFirst).not.toHaveBeenCalled();
    expect((f.fetcher.mock.calls[0] as unknown as [URL])[0].href).toBe(
      "https://local.example.test/computer",
    );
  });
  it("never falls back to another host when registration is missing or revoked", async () => {
    const f = fixture();
    f.prisma.registeredHost.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.resolve({ hostId: "foreign", path: "/project" }, context)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.prisma.registeredHost.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(f.resolve({ hostId: "remote", path: "/project" }, context)).rejects.toThrow();
  });
  it("fails closed when an old host does not support project resolution", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(f.resolve({ hostId: null, path: "/project" }, context)).rejects.toThrow();
  });
});
