import {
  FARMING_CONTROL_SPECIALISTS,
  farmingControlBotId,
  farmingControlGroupId,
} from "@rakazo/adapters";
import { parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureFarmingControlTeam } from "./farming-control-team.js";

const state = vi.hoisted(() => ({
  bots: new Map<string, Record<string, unknown>>(),
  groups: new Map<string, Record<string, unknown>>(),
  createBot: vi.fn(),
  createGroup: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createRepos: () => ({ createBot: state.createBot }),
  createGroupRepos: () => ({ createGroup: state.createGroup }),
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
  state.createGroup.mockImplementation(async (who, input) => {
    if (!state.groups.has(input.id))
      state.groups.set(input.id, { ...input, userId: who.userId, spaceId: who.spaceId });
    return state.groups.get(input.id);
  });
});

function database() {
  const skills = new Map<string, unknown>();
  const prisma = {
    bot: { findUnique: vi.fn(async ({ where }) => state.bots.get(where.id) ?? null) },
    agentSkill: {
      upsert: vi.fn(async ({ where, create }) => {
        if (!skills.has(where.id)) skills.set(where.id, create);
        return skills.get(where.id);
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, skills };
}

it("provisions five normal persistent profiles, five skills, and one ordered group across repeated sessions", async () => {
  const { prisma, skills } = database();
  const first = await ensureFarmingControlTeam(prisma, actor);
  const second = await ensureFarmingControlTeam(prisma, actor);
  expect(second).toEqual(first);
  expect(state.bots.size).toBe(5);
  expect(skills.size).toBe(5);
  expect(state.groups.size).toBe(1);
  for (const skill of skills.values()) {
    const parsed = parseSkillMd((skill as { content: string }).content);
    expect(parsed).not.toHaveProperty("error");
    expect(parsed).toHaveProperty("body");
  }
  expect(state.createBot).toHaveBeenCalledTimes(5);
  expect(first.groupId).toBe(farmingControlGroupId(actor.spaceId));
  expect(first.coordinatorId).toBe(farmingControlBotId(actor.spaceId, "coordinator"));
  expect(first.bots.map((bot) => bot.role)).toEqual(
    FARMING_CONTROL_SPECIALISTS.map((item) => item.role),
  );
  for (const [, input] of state.createBot.mock.calls) {
    expect(input.fleetManagement).toBe(false);
    expect(input.disabledBuiltinTools).toContain("shell");
    expect(input.disabledBuiltinTools).toContain("secret_request");
    expect(input.instructions).toContain("read-only");
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
  expect(state.bots.size).toBe(5);
  expect(skills.size).toBe(5);
  expect(state.groups.size).toBe(1);
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
  expect(state.bots.size).toBe(5);
});
