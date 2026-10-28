import type { Actor, SetBotExecutionInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveNativeProjectConfig } from "./native-project-config.js";
import type { RouterDeps } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
const input: SetBotExecutionInput = {
  botId: "bot",
  runtimeKind: "codex",
  runtimePermission: "workspace",
  executionTarget: "host",
  projectPath: "/alias/project",
};
function fixture(member = true) {
  const hostProjectDirectory = vi.fn(async () => "/canonical/project");
  const deps = {
    hostProjectDirectory,
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
  } as unknown as RouterDeps;
  return { deps, hostProjectDirectory };
}
describe("native project save boundary", () => {
  it("returns only the selected host's canonical path for persistence", async () => {
    const f = fixture();
    expect(
      await resolveNativeProjectConfig(f.deps, actor, { ...input, registeredHostId: "remote" }),
    ).toEqual({ ...input, registeredHostId: "remote", projectPath: "/canonical/project" });
    expect(input.projectPath).toBe("/alias/project");
    expect(f.hostProjectDirectory).toHaveBeenCalledWith(
      { hostId: "remote", path: "/alias/project" },
      expect.objectContaining({ userId: "owner", spaceId: "space", botId: "bot" }),
    );
  });
  it("checks active membership before contacting a host", async () => {
    const f = fixture(false);
    await expect(resolveNativeProjectConfig(f.deps, actor, input)).rejects.toThrow(
      "Could not open the project folder",
    );
    expect(f.hostProjectDirectory).not.toHaveBeenCalled();
  });
  it("returns a readable path-free error for missing folders, revoked consent and old hosts", async () => {
    const f = fixture();
    f.hostProjectDirectory.mockRejectedValueOnce(new Error("ENOENT /private/secret fake-token"));
    await expect(resolveNativeProjectConfig(f.deps, actor, input)).rejects.toThrow(
      "Choose an existing folder on the selected host",
    );
    delete f.deps.hostProjectDirectory;
    await expect(resolveNativeProjectConfig(f.deps, actor, input)).rejects.toThrow(
      "Could not open the project folder",
    );
  });
  it("never contacts the host for Pi or unsupported permission combinations", async () => {
    const f = fixture();
    const pi = { ...input, runtimeKind: "pi" as const, projectPath: null };
    expect(await resolveNativeProjectConfig(f.deps, actor, pi)).toEqual(pi);
    await expect(
      resolveNativeProjectConfig(f.deps, actor, { ...input, runtimeKind: "claude" }),
    ).rejects.toThrow("explicit full host access");
    expect(f.hostProjectDirectory).not.toHaveBeenCalled();
  });
});
