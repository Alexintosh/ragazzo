import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeSetupTransport,
  nativeSetupScopeKey,
  revokeNativeSetupScopes,
} from "./native-setup-transport.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
function fixture() {
  const host = {
    id: "host",
    spaceId: "space",
    userId: "owner",
    endpoint: "https://host.example.test",
    ciphertext: "encrypted",
  };
  const prisma = {
    registeredHost: {
      findFirst: vi.fn(async () => host),
      findMany: vi.fn(async () => [host]),
      count: vi.fn(async () => 1),
    },
  };
  const secrets = { load: vi.fn(async () => "fake-token") };
  const fetcher = vi.fn(
    async () =>
      new Response(
        '{"value":{"kind":"codex","available":false,"authenticated":false,"managed":false,"installSupported":true,"loginSupported":true}}\n{"done":true}\n',
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    prisma,
    secrets,
    fetcher,
    request: createNativeSetupTransport({
      prisma: prisma as unknown as PrismaClient,
      secrets: secrets as unknown as SecretStore,
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("owner-bound host setup transport", () => {
  it("resolves only a non-revoked registration owned by the actor", async () => {
    const f = fixture();
    await f.request({ hostId: "host", kind: "codex", action: "install" }, context);
    expect(f.prisma.registeredHost.findFirst).toHaveBeenCalledWith({
      where: { id: "host", spaceId: "space", userId: "owner", revokedAt: null },
    });
    const body = JSON.parse(
      (f.fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({
      method: "nativeSetup",
      registrationId: "host",
      kind: "codex",
      action: "install",
    });
    expect(body.scopeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(body).not.toHaveProperty("approved");
  });
  it("does not fall back to a local host for a foreign or revoked registration", async () => {
    const f = fixture();
    f.prisma.registeredHost.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      f.request({ hostId: "foreign", kind: "codex", action: "status" }, context),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.secrets.load).not.toHaveBeenCalled();
  });
  it("suppresses challenge responses after registration revocation", async () => {
    const f = fixture();
    f.prisma.registeredHost.count.mockResolvedValueOnce(0);
    await expect(
      f.request({ hostId: "host", kind: "codex", action: "status" }, context),
    ).rejects.toThrow();
  });
  it("resolves exact deletion owners and confirms registered and local bridge scope cleanup", async () => {
    const f = fixture();
    f.fetcher.mockImplementation(
      async () => new Response('{"value":{"revoked":true}}\n{"done":true}\n'),
    );
    await revokeNativeSetupScopes(
      {
        prisma: f.prisma as unknown as PrismaClient,
        secrets: f.secrets as unknown as SecretStore,
        hostComputerUrl: "https://local.example.test",
        hostComputerToken: "fake-local-token",
      },
      [{ spaceId: "space", userId: "owner" }],
    );
    expect(f.prisma.registeredHost.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { OR: [{ spaceId: "space", userId: "owner" }] },
          { OR: [{ revokedAt: null }, { revocationPending: true }] },
        ],
      },
    });
    const requests = f.fetcher.mock.calls.map((call) =>
      JSON.parse((call as unknown as [URL, RequestInit])[1].body as string),
    );
    expect(requests).toEqual([
      {
        method: "nativeSetupScopeRevoke",
        botId: "setup",
        scopeKey: nativeSetupScopeKey("space", "owner", "host"),
      },
      {
        method: "nativeSetupScopeRevoke",
        botId: "setup",
        scopeKey: nativeSetupScopeKey("space", "owner", null),
      },
    ]);
  });
  it("skips absent local bridges, never broadens empty owners and rejects missing cleanup confirmation", async () => {
    const f = fixture();
    const options = {
      prisma: f.prisma as unknown as PrismaClient,
      secrets: f.secrets as unknown as SecretStore,
    };
    await revokeNativeSetupScopes(options, []);
    expect(f.prisma.registeredHost.findMany).not.toHaveBeenCalled();
    await expect(
      revokeNativeSetupScopes(options, [{ spaceId: "", userId: "owner" }]),
    ).rejects.toThrow("explicit owners");
    await expect(
      revokeNativeSetupScopes(options, [{ spaceId: "space", userId: "owner" }]),
    ).rejects.toThrow("cleanup uncertain");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.prisma.registeredHost.findMany.mockResolvedValueOnce([]);
    await revokeNativeSetupScopes(options, [{ spaceId: "space", userId: "owner" }]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
