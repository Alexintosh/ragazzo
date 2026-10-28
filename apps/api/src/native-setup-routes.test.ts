import { createRouterClient } from "@orpc/server";
import type { Actor, NativeSetupView } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
function fixture(authenticated = true) {
  const setupOwners = { upsert: vi.fn(async () => ({})) };
  const nativeSetup = vi.fn(
    async (): Promise<NativeSetupView> => ({
      kind: "codex",
      available: false,
      authenticated: false,
      managed: false,
      installSupported: true,
      loginSupported: true,
    }),
  );
  const deps = {
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          nativeSetupOwner: setupOwners,
          $queryRaw: vi.fn(async () => [{ nativeSetupDisabledAt: null }]),
          spaceMember: {
            findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
          },
        }),
    },
    nativeSetup,
    env: { agentRuntime: "scripted" },
  } as unknown as RouterDeps;
  return {
    setupOwners,
    nativeSetup,
    client: createRouterClient(createRouter(deps), {
      context: { actor: authenticated ? actor : null } as never,
    }),
  };
}
describe("runtime setup routes", () => {
  it("requires authentication before touching the host", async () => {
    const f = fixture(false);
    await expect(
      f.client.nativeSetup.request({ hostId: null, kind: "codex", action: "status" }),
    ).rejects.toThrow();
    expect(f.nativeSetup).not.toHaveBeenCalled();
  });
  it("derives owner and space from the authenticated actor", async () => {
    const f = fixture();
    await f.client.nativeSetup.request({ hostId: "registered", kind: "codex", action: "install" });
    expect(f.nativeSetup).toHaveBeenCalledWith(
      { hostId: "registered", kind: "codex", action: "install" },
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
    );
    expect(f.setupOwners.upsert).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space", userId: "owner" } },
      create: { spaceId: "space", userId: "owner" },
      update: {},
    });
    expect(f.setupOwners.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      f.nativeSetup.mock.invocationCallOrder[0]!,
    );
  });
  it("rejects command, destination and approval injection before execution", async () => {
    const f = fixture();
    await expect(
      f.client.nativeSetup.request({
        hostId: null,
        kind: "codex",
        action: "install",
        approved: true,
        command: ["sh"],
        destination: "/outside",
      } as never),
    ).rejects.toThrow();
    expect(f.nativeSetup).not.toHaveBeenCalled();
  });
  it("keeps process errors, authentication output and bearer data out of RPC errors", async () => {
    const f = fixture();
    f.nativeSetup.mockRejectedValueOnce(new Error("Bearer fake-provider-secret ABCD-EFGH"));
    await expect(
      f.client.nativeSetup.request({ hostId: null, kind: "codex", action: "login" }),
    ).rejects.toThrow("Check the selected host and local consent");
  });
});
