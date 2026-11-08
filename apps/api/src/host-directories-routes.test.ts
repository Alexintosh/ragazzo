import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
function fixture(authenticated = true, member = true) {
  const hostDirectories = vi.fn(async () => ({
    path: "/home/test",
    parent: null,
    directories: [],
    truncated: false,
  }));
  const deps = {
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: vi.fn(async () => [{ nativeSetupDisabledAt: null }]),
          spaceMember: {
            findUnique: vi.fn(async () =>
              member ? { organizationId: "org", space: { deletingAt: null } } : null,
            ),
          },
        }),
    },
    hostDirectories,
    env: { agentRuntime: "scripted" },
  } as unknown as RouterDeps;
  return {
    hostDirectories,
    client: createRouterClient(createRouter(deps), {
      context: { actor: authenticated ? actor : null } as never,
    }),
  };
}
describe("host directory routes", () => {
  it("requires authenticated active Space membership before contacting any host", async () => {
    for (const f of [fixture(false), fixture(true, false)]) {
      await expect(f.client.hosts.directories({ hostId: null })).rejects.toThrow();
      expect(f.hostDirectories).not.toHaveBeenCalled();
    }
  });
  it("derives authority from the authenticated actor", async () => {
    const f = fixture();
    await f.client.hosts.directories({ hostId: "registered", path: "/home/test" });
    expect(f.hostDirectories).toHaveBeenCalledWith(
      { hostId: "registered", path: "/home/test" },
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
    );
  });
  it("rejects endpoints, commands and injected owner fields before browsing", async () => {
    const f = fixture();
    await expect(
      f.client.hosts.directories({
        hostId: null,
        endpoint: "https://other.example.test",
        command: ["sh"],
        userId: "other",
      } as never),
    ).rejects.toThrow();
    expect(f.hostDirectories).not.toHaveBeenCalled();
  });
  it("keeps host paths, credentials and filesystem failures out of RPC errors", async () => {
    const f = fixture();
    f.hostDirectories.mockRejectedValueOnce(new Error("Bearer fake-token /private/file"));
    await expect(f.client.hosts.directories({ hostId: null })).rejects.toThrow(
      "Check the selected host and local consent",
    );
  });
});
