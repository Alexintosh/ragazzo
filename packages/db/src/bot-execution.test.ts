import type { Actor, SetBotExecutionInput } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBotExecution, validateBotExecution } from "./bot-execution.js";
import type { PrismaClient } from "./client.js";
import { computerHomeKey, computerScopeKey } from "./computers.js";
import { IsolationError } from "./scope.js";

vi.mock("./events.js", () => ({ appendEventInTransaction: vi.fn(async () => ({ seq: 4 })) }));
const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
const codex: SetBotExecutionInput = {
  botId: "bot",
  runtimeKind: "codex",
  executionTarget: "host",
  runtimePermission: "workspace",
  projectPath: "/projects/example",
};

function fixture(
  options: {
    active?: boolean;
    state?: string;
    foreign?: boolean;
    target?: string;
    maintenance?: string;
    scope?: string;
  } = {},
) {
  const current = {
    id: "team-computer",
    scope: options.scope ?? "team",
    kind: "docker",
    state: options.state ?? "stopped",
    maintenanceId: options.maintenance ?? null,
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
  };
  const bot = {
    id: "bot",
    name: "Helper",
    title: "",
    description: "",
    computerId: current.id,
    computer: current,
    computerSwitching: false,
    executionTarget: options.target ?? "default",
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { findFirst: vi.fn(async () => (options.foreign ? null : { id: "thread" })) },
    bot: { findFirst: vi.fn(async () => bot), update: vi.fn(async () => ({})) },
    run: { findFirst: vi.fn(async () => (options.active ? { id: "run" } : null)) },
    computerExecutionLease: { findFirst: vi.fn(async () => null) },
    computer: {
      findUniqueOrThrow: vi.fn(async () => current),
      upsert: vi.fn(async () => ({ id: "host-computer" })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, current };
}

afterEach(() => vi.unstubAllEnvs());

describe("bot execution settings", () => {
  it("leaves placement untouched while any active run exists, including queued and waiting runs", async () => {
    const { prisma, tx } = fixture({ active: true });
    await expect(setBotExecution(prisma, actor, codex)).rejects.toThrow("Stop the bot");
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: expect.arrayContaining([
              "queued",
              "leased",
              "running",
              "waiting_input",
              "waiting_takeover",
            ]),
          },
        }),
      }),
    );
    expect(tx.computer.upsert).not.toHaveBeenCalled();
    expect(tx.bot.update).not.toHaveBeenCalled();
  });

  it("requires an explicit stop before leaving a running dedicated computer", async () => {
    const { prisma, tx } = fixture({ state: "running", scope: "dedicated" });
    await expect(setBotExecution(prisma, actor, codex)).rejects.toThrow("Stop the computer");
    expect(tx.computer.upsert).not.toHaveBeenCalled();
    expect(tx.bot.update).not.toHaveBeenCalled();
  });

  it("selects a separate pinned host computer while its shared peer remains running", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "0");
    const { prisma, tx, current } = fixture({ state: "running" });
    await expect(setBotExecution(prisma, actor, codex)).resolves.toEqual({
      threadId: "thread",
      seq: 4,
    });
    expect(tx.computer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scopeKey: "bot:bot:host" },
        create: expect.objectContaining({
          scope: "dedicated",
          kind: "desktop",
          executionTarget: "host",
          homeKey: "bot-host",
        }),
        update: {},
      }),
    );
    expect(tx.bot.update).toHaveBeenCalledWith({
      where: { id: "bot" },
      data: {
        runtimeKind: "codex",
        executionTarget: "host",
        registeredHostId: null,
        runtimePermission: "workspace",
        projectPath: codex.projectPath,
        runtimeGeneration: { increment: 1 },
        computerId: "host-computer",
      },
    });
    expect(current.kind).toBe("docker");
  });

  it("refuses another tenant's bot before any placement mutation", async () => {
    const { prisma, tx } = fixture({ foreign: true });
    await expect(setBotExecution(prisma, actor, codex)).rejects.toBeInstanceOf(IsolationError);
    expect(tx.computer.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { ...codex, executionTarget: "docker" },
    { ...codex, executionTarget: "default" },
    { ...codex, projectPath: "relative/path" },
    { ...codex, projectPath: null },
    { ...codex, projectPath: "/project\0bad" },
    { ...codex, runtimeKind: "pi", projectPath: null, runtimePermission: "full" },
    { ...codex, runtimeKind: "pi" },
  ] as SetBotExecutionInput[])("rejects unsupported combinations %j", (input) => {
    expect(() => validateBotExecution(input)).toThrow();
  });

  it("allows implemented native permissions and keeps Pi defaults", () => {
    expect(() => validateBotExecution(codex)).not.toThrow();
    expect(() => validateBotExecution({ ...codex, runtimePermission: "full" })).not.toThrow();
    expect(() =>
      validateBotExecution({
        ...codex,
        runtimeKind: "pi",
        projectPath: null,
        executionTarget: "default",
      }),
    ).not.toThrow();
  });

  it("keeps legacy keys stable and target disks distinct", () => {
    const input = { mode: "dedicated" as const, botId: "bot", userId: "user", spaceId: "space" };
    expect(computerScopeKey(input)).toBe("bot:bot");
    expect(computerHomeKey(input)).toBe("bot");
    const keys = ["default", "docker", "host"].map((executionTarget) =>
      computerHomeKey({
        ...input,
        executionTarget: executionTarget as "default" | "docker" | "host",
      }),
    );
    expect(new Set(keys).size).toBe(3);
  });
});

it.each(["claude", "acp"] as const)("requires explicit full host access for %s", (runtimeKind) => {
  expect(() =>
    validateBotExecution({ ...codex, runtimeKind, runtimePermission: "full" }),
  ).not.toThrow();
  expect(() => validateBotExecution({ ...codex, runtimeKind })).toThrow(
    "explicit full host access",
  );
  expect(() =>
    validateBotExecution({
      ...codex,
      runtimeKind,
      executionTarget: "docker",
      runtimePermission: "full",
    }),
  ).toThrow();
});
