import {
  FARMING_CONTROL_SAFE_TOOLS,
  FARMING_CONTROL_SPECIALISTS,
  farmingControlBotId,
  farmingControlGroupId,
  farmingControlInstructions,
} from "@rakazo/adapters";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureFarmingControlTeam } from "./farming-control-team.js";

const state = vi.hoisted(() => ({
  bots: new Map<string, Record<string, unknown>>(),
  groups: new Map<string, Record<string, unknown>>(),
  createBot: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createRepos: () => ({ createBot: state.createBot }),
  createGroupRepos: () => ({ createGroup: state.createGroup, updateGroup: state.updateGroup }),
}));
const actor = {
  userId: "owner",
  spaceId: "personal",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.bots.clear();
  state.groups.clear();
  state.createBot.mockImplementation(async (who, input) => {
    const row = { ...input, userId: who.userId, spaceId: who.spaceId, archivedAt: null };
    if (!state.bots.has(input.id)) state.bots.set(input.id, row);
    return state.bots.get(input.id);
  });
  state.updateGroup.mockImplementation(async (_who, input) => {
    const row = state.groups.get(input.groupId)!;
    expect(row.botIds).toEqual(input.expectedBotIds);
    row.botIds = input.botIds;
    return { group: row, cancelledRunIds: [], computers: [] };
  });
  state.createGroup.mockImplementation(async (who, input) => {
    const existing = state.groups.get(input.id);
    if (existing && JSON.stringify(existing.botIds) !== JSON.stringify(input.botIds))
      throw new Error("configured group has changed");
    if (!existing)
      state.groups.set(input.id, { ...input, userId: who.userId, spaceId: who.spaceId });
    return state.groups.get(input.id);
  });
});

function database() {
  const skills = new Map<string, unknown>();
  const prisma = {
    bot: {
      findUnique: vi.fn(async ({ where }) => state.bots.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = state.bots.get(where.id);
        if (!row || row.instructions !== where.instructions) return { count: 0 };
        if (
          where.disabledBuiltinTools &&
          JSON.stringify(row.disabledBuiltinTools) !==
            JSON.stringify(where.disabledBuiltinTools.equals)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    chatGroup: {
      findUnique: vi.fn(async ({ where }) => {
        const row = state.groups.get(where.id);
        return row
          ? { ...row, members: (row.botIds as string[]).map((botId) => ({ botId })) }
          : null;
      }),
    },
    agentSkill: {
      upsert: vi.fn(async ({ where, create }) => {
        if (!skills.has(where.id)) skills.set(where.id, create);
        return skills.get(where.id);
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, skills };
}

it("provisions six normal persistent profiles, six skills, and one ordered group across repeated sessions", async () => {
  const { prisma, skills } = database();
  const first = await ensureFarmingControlTeam(prisma, actor);
  const second = await ensureFarmingControlTeam(prisma, actor);
  expect(second).toEqual(first);
  expect(state.bots.size).toBe(6);
  expect(skills.size).toBe(6);
  expect(state.groups.size).toBe(1);
  for (const skill of skills.values()) {
    const parsed = parseSkillMd((skill as { content: string }).content);
    expect(parsed).not.toHaveProperty("error");
    expect(parsed).toHaveProperty("body");
  }
  expect(state.createBot).toHaveBeenCalledTimes(6);
  expect(first.groupId).toBe(farmingControlGroupId(actor.spaceId));
  expect(first.coordinatorId).toBe(farmingControlBotId(actor.spaceId, "coordinator"));
  expect(first.bots.map((bot) => bot.role)).toEqual(
    FARMING_CONTROL_SPECIALISTS.map((item) => item.role),
  );
  for (const [, input] of state.createBot.mock.calls) {
    expect(input.fleetManagement).toBe(false);
    expect(input.disabledBuiltinTools).toContain("shell");
    expect(input.disabledBuiltinTools).toContain("secret_request");
  }
});

it("resumes after a partial first-session failure without adding duplicate profiles", async () => {
  const { prisma, skills } = database();
  const original = state.createBot.getMockImplementation()!;
  state.createBot
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("temporary storage failure"));
  await expect(ensureFarmingControlTeam(prisma, actor)).rejects.toThrow(
    "temporary storage failure",
  );
  expect(state.bots.size).toBe(1);
  await ensureFarmingControlTeam(prisma, actor);
  expect(state.bots.size).toBe(6);
  expect(skills.size).toBe(6);
  expect(state.groups.size).toBe(1);
});

it("converges concurrent first sessions on the same team identities", async () => {
  const { prisma, skills } = database();
  const results = await Promise.all([
    ensureFarmingControlTeam(prisma, actor),
    ensureFarmingControlTeam(prisma, actor),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(state.bots.size).toBe(6);
  expect(skills.size).toBe(6);
  expect(state.groups.size).toBe(1);
  expect(state.groups.get(farmingControlGroupId(actor.spaceId))!.botIds).toEqual(
    FARMING_CONTROL_SPECIALISTS.map((specialist) =>
      farmingControlBotId(actor.spaceId, specialist.role),
    ),
  );
});

it("preserves profile edits and rejects archived or foreign reserved identities", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  const id = farmingControlBotId(actor.spaceId, "tax");
  const tax = state.bots.get(id)!;
  tax.instructions = "Operator customization";
  tax.name = "Renamed tax specialist";
  const updated = await ensureFarmingControlTeam(prisma, actor);
  expect(updated.bots.find((bot) => bot.role === "tax")?.name).toBe("Renamed tax specialist");
  expect(tax.instructions).toBe("Operator customization");
  tax.archivedAt = new Date();
  await expect(ensureFarmingControlTeam(prisma, actor)).rejects.toThrow("unavailable");
  tax.archivedAt = null;
  tax.userId = "another-owner";
  await expect(ensureFarmingControlTeam(prisma, actor)).rejects.toThrow("unavailable");
  expect(state.bots.size).toBe(6);
});

it("upgrades only the exact generated five-member team and generated instructions", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  const group = state.groups.get(farmingControlGroupId(actor.spaceId))!;
  const oldIds = (group.botIds as string[]).filter(
    (id) => id !== farmingControlBotId(actor.spaceId, "opportunities"),
  );
  group.botIds = oldIds;
  state.bots.delete(farmingControlBotId(actor.spaceId, "opportunities"));
  const coordinator = state.bots.get(farmingControlBotId(actor.spaceId, "coordinator"))!;
  coordinator.instructions = farmingControlInstructions(
    "coordinator",
    actor.spaceId,
    "current",
    "legacy",
  );
  await ensureFarmingControlTeam(prisma, actor);
  expect(state.updateGroup).toHaveBeenCalledWith(actor, {
    groupId: group.id,
    botIds: FARMING_CONTROL_SPECIALISTS.map((s) => farmingControlBotId(actor.spaceId, s.role)),
    expectedBotIds: oldIds,
  });
  expect(coordinator.instructions).toBe(farmingControlInstructions("coordinator", actor.spaceId));
  await ensureFarmingControlTeam(prisma, actor);
  expect(state.updateGroup).toHaveBeenCalledOnce();
});

it("does not overwrite customized group membership during an upgrade", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  state.groups.get(farmingControlGroupId(actor.spaceId))!.botIds = [
    "custom-member",
    "another-member",
  ];
  await expect(ensureFarmingControlTeam(prisma, actor)).rejects.toThrow(
    "configured group has changed",
  );
  expect(state.updateGroup).not.toHaveBeenCalled();
});

for (const precision of ["current", "legacy", "pre-risk"] as const) {
  for (const team of ["current", "legacy"] as const) {
    it(`upgrades generated Coordinator instructions and native messaging restrictions (${precision}, ${team})`, async () => {
      const { prisma } = database();
      await ensureFarmingControlTeam(prisma, actor);
      const coordinator = state.bots.get(farmingControlBotId(actor.spaceId, "coordinator"))!;
      coordinator.instructions = farmingControlInstructions(
        "coordinator",
        actor.spaceId,
        precision,
        team,
        "legacy",
      );
      coordinator.disabledBuiltinTools = BUILTIN_TOOL_NAMES.filter(
        (name) => !FARMING_CONTROL_SAFE_TOOLS.has(name),
      );
      expect(coordinator.disabledBuiltinTools).toContain("message_bot");
      await ensureFarmingControlTeam(prisma, actor);
      expect(coordinator.instructions).toBe(
        farmingControlInstructions("coordinator", actor.spaceId),
      );
      expect(coordinator.disabledBuiltinTools).not.toContain("message_bot");
      expect(coordinator.disabledBuiltinTools).toContain("shell");
      expect(coordinator.disabledBuiltinTools).toContain("secret_request");
      for (const role of ["opportunities", "risk", "operations", "tax", "accounting"] as const) {
        expect(
          state.bots.get(farmingControlBotId(actor.spaceId, role))!.disabledBuiltinTools,
        ).toContain("message_bot");
      }
      vi.mocked(prisma.bot.updateMany).mockClear();
      await ensureFarmingControlTeam(prisma, actor);
      expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    });
  }
}

it("preserves customized Coordinator instructions and tool restrictions", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  const coordinator = state.bots.get(farmingControlBotId(actor.spaceId, "coordinator"))!;
  const generatedDisabled = BUILTIN_TOOL_NAMES.filter(
    (name) => !FARMING_CONTROL_SAFE_TOOLS.has(name),
  );
  coordinator.disabledBuiltinTools = [...generatedDisabled, "ask_user"];
  coordinator.instructions = farmingControlInstructions(
    "coordinator",
    actor.spaceId,
    "current",
    "current",
    "legacy",
  );
  await ensureFarmingControlTeam(prisma, actor);
  expect(coordinator.instructions).toBe(farmingControlInstructions("coordinator", actor.spaceId));
  expect(coordinator.disabledBuiltinTools).toEqual([...generatedDisabled, "ask_user"]);
  coordinator.instructions = "Custom instructions and no private consultation";
  coordinator.disabledBuiltinTools = generatedDisabled;
  await ensureFarmingControlTeam(prisma, actor);
  expect(coordinator.instructions).toBe("Custom instructions and no private consultation");
  expect(coordinator.disabledBuiltinTools).toEqual(generatedDisabled);
});

it("preserves a concurrent Coordinator tool-policy edit during generated-profile migration", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  const coordinator = state.bots.get(farmingControlBotId(actor.spaceId, "coordinator"))!;
  coordinator.instructions = farmingControlInstructions(
    "coordinator",
    actor.spaceId,
    "current",
    "current",
    "legacy",
  );
  coordinator.disabledBuiltinTools = BUILTIN_TOOL_NAMES.filter(
    (name) => !FARMING_CONTROL_SAFE_TOOLS.has(name),
  );
  // This fixture implements async repository methods rather than Prisma's lazy promises.
  const bot = prisma.bot as unknown as {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  // Prisma reads are snapshots; preserve that behavior while simulating an edit before CAS.
  bot.findUnique.mockImplementation(async ({ where }) => {
    const row = state.bots.get(where.id as string);
    return row
      ? ({ ...row, disabledBuiltinTools: [...(row.disabledBuiltinTools as string[])] } as never)
      : null;
  });
  const update = bot.updateMany.getMockImplementation() as (
    args: unknown,
  ) => Promise<{ count: number }>;
  bot.updateMany.mockImplementationOnce(async (args) => {
    const result = await update(args);
    coordinator.disabledBuiltinTools = [
      ...(coordinator.disabledBuiltinTools as string[]),
      "ask_user",
    ];
    return result;
  });
  await ensureFarmingControlTeam(prisma, actor);
  expect(coordinator.disabledBuiltinTools).toContain("ask_user");
  expect(coordinator.disabledBuiltinTools).toContain("message_bot");
});

it("recognizes the exact pre-risk committed profile while rejecting edits to it", async () => {
  const { prisma } = database();
  await ensureFarmingControlTeam(prisma, actor);
  const coordinator = state.bots.get(farmingControlBotId(actor.spaceId, "coordinator"))!;
  // Exact generated precision paragraph from dc212493, before the four-decimal Risk clause.
  const historical = farmingControlInstructions(
    "coordinator",
    actor.spaceId,
    "current",
    "legacy",
    "legacy",
  ).replace(
    "or on request; for Risk judgments use no more than four decimal places.",
    "or on request.",
  );
  expect(historical).toBe(
    farmingControlInstructions("coordinator", actor.spaceId, "pre-risk", "legacy", "legacy"),
  );
  coordinator.instructions = `${historical}\n\nOperator customization`;
  const legacyDisabled = BUILTIN_TOOL_NAMES.filter((name) => !FARMING_CONTROL_SAFE_TOOLS.has(name));
  coordinator.disabledBuiltinTools = legacyDisabled;
  await ensureFarmingControlTeam(prisma, actor);
  expect(coordinator.instructions).toBe(`${historical}\n\nOperator customization`);
  expect(coordinator.disabledBuiltinTools).toEqual(legacyDisabled);
  coordinator.instructions = historical;
  await ensureFarmingControlTeam(prisma, actor);
  expect(coordinator.instructions).toBe(farmingControlInstructions("coordinator", actor.spaceId));
  expect(coordinator.disabledBuiltinTools).not.toContain("message_bot");
});
