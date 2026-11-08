import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
function fixture(options: { hostConfigured?: boolean; botExists?: boolean } = {}) {
  const findFirst = vi.fn(async () =>
    options.botExists === false ? null : { id: "bot", thread: { id: "thread" } },
  );
  const nativeRuntimeStatus = vi.fn(async () => ({ available: true, authenticated: true }));
  const transaction = vi.fn();
  const deps = {
    prisma: { bot: { findFirst }, $transaction: transaction } as unknown as PrismaClient,
    nativeRuntimeStatus,
    env: {
      agentRuntime: "scripted",
      sandboxProvider: "docker",
      nativeHostConfigured: options.hostConfigured ?? true,
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { client, nativeRuntimeStatus, findFirst, transaction };
}

describe("native execution routes", () => {
  it("checks bot ownership before probing the local host", async () => {
    const { client, nativeRuntimeStatus } = fixture({ botExists: false });
    await expect(client.bots.executionStatus({ botId: "foreign" })).rejects.toThrow();
    expect(nativeRuntimeStatus).not.toHaveBeenCalled();
  });

  it("probes only the actor's bot and thread without changing the host configuration", async () => {
    const { client, nativeRuntimeStatus, findFirst } = fixture();
    await expect(client.bots.executionStatus({ botId: "bot" })).resolves.toEqual({
      available: true,
      authenticated: true,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "bot", userId: "owner", spaceId: "space" }),
      }),
    );
    expect(nativeRuntimeStatus).toHaveBeenCalledWith(
      "bot",
      "thread",
      expect.objectContaining({ userId: "owner", spaceId: "space", botId: "bot" }),
    );
  });

  it("reports unavailable when the local bridge refuses a status probe", async () => {
    const { client, nativeRuntimeStatus } = fixture();
    nativeRuntimeStatus.mockRejectedValueOnce(new Error("local consent revoked"));
    await expect(client.bots.executionStatus({ botId: "bot" })).resolves.toEqual({
      available: false,
      authenticated: false,
      reason: "host-unavailable",
    });
  });

  it("does not offer host execution without a configured authenticated bridge", async () => {
    const { client, transaction, nativeRuntimeStatus } = fixture({ hostConfigured: false });
    await expect(client.bots.executionStatus({ botId: "bot" })).resolves.toEqual({
      available: false,
      authenticated: false,
      reason: "host-unavailable",
    });
    await expect(
      client.bots.setExecution({
        botId: "bot",
        runtimeKind: "codex",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: "/projects/example",
      }),
    ).rejects.toThrow("configured desktop bridge");
    expect(transaction).not.toHaveBeenCalled();
    expect(nativeRuntimeStatus).not.toHaveBeenCalled();
  });
});
