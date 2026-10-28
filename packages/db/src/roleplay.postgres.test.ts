import type { Actor } from "@rakazo/contracts";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBotExecution } from "./bot-execution.js";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { clearThread } from "./events.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const character = parseRoleplayCharacterJson(
  JSON.stringify({
    name: "Mira",
    description: "The secret island of AMARANTH",
    first_mes: "{{char}} welcomes {{user}}.",
  }),
).character;

describePostgres("roleplay storage and isolation (PostgreSQL)", () => {
  const address = `+1558${String(Date.now()).slice(-7)}`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let identity: { userId: string; spaceId: string };
  let actor: Actor;
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    const provisioned = await runAsSystem("roleplay test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = { userId: provisioned.userId, spaceId: provisioned.spaceId };
    actor = { ...identity, email: "roleplay@example.test", isDeploymentOwner: false };
  });
  afterAll(async () => {
    if (identity) {
      const system = asSystem(prisma, "roleplay test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });
  const input = {
    name: "Mira",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
    botKind: "roleplay" as const,
    roleplayCharacter: character,
  };
  it("creates dedicated Docker stories with encrypted character/state and an inert greeting", () =>
    runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const bot = await repos.createBot(actor, input);
      const stored = await repos.getBot(actor, bot.id);
      expect(bot).toMatchObject({
        botKind: "roleplay",
        roleplayCharacter: character,
        runtimeKind: "pi",
        executionTarget: "docker",
        computerMode: "dedicated",
        fleetManagement: false,
      });
      expect(stored.computer).toMatchObject({
        kind: "docker",
        scope: "dedicated",
        executionTarget: "docker",
      });
      expect(await prisma.message.findMany({ where: { threadId: bot.threadId } })).toMatchObject([
        { role: "bot", blocks: [{ kind: "text", text: "Mira welcomes Player." }] },
      ]);
      expect(await prisma.run.count({ where: { botId: bot.id } })).toBe(0);
      expect(await prisma.memoryDocument.count({ where: { botId: bot.id } })).toBe(0);
      expect(await prisma.browserProfile.count({ where: { botId: bot.id } })).toBe(0);
      const state = { version: 1, summary: "We reached AMARANTH", botId: bot.id };
      await prisma.thread.update({ where: { id: bot.threadId }, data: { roleplayState: state } });
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toEqual(state);
      const raw = await prisma.$queryRaw<
        Array<{ character: unknown; state: unknown }>
      >`SELECT b."roleplayCharacter" AS character, t."roleplayState" AS state FROM bots b JOIN threads t ON t."botId"=b.id WHERE b.id=${bot.id}`;
      expect(JSON.stringify(raw)).not.toContain("AMARANTH");
      expect(JSON.stringify(raw)).toContain("$sealed");
      await clearThread(prisma, {
        spaceId: identity.spaceId,
        threadId: bot.threadId,
        botId: bot.id,
      });
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toBeNull();
      expect(await prisma.message.count({ where: { threadId: bot.threadId } })).toBe(1);
      expect(
        (await prisma.message.findFirstOrThrow({ where: { threadId: bot.threadId } })).blocks,
      ).toEqual([{ kind: "text", text: "Mira welcomes Player." }]);
    }));
  it("rejects runtime/host/sharing and immutable-kind bypasses", () =>
    runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const bot = await repos.createBot(actor, input);
      await expect(
        repos.createBot(actor, {
          ...input,
          runtimeKind: "codex",
          executionTarget: "host",
          projectPath: "/projects/example",
        }),
      ).rejects.toThrow("Roleplay bots require");
      await expect(
        setBotExecution(prisma, actor, {
          botId: bot.id,
          runtimeKind: "pi",
          executionTarget: "host",
          runtimePermission: "workspace",
          projectPath: null,
        }),
      ).rejects.toThrow("Roleplay bots require");
      await expect(repos.setBotComputer(actor, bot.id, "team")).rejects.toThrow("dedicated Docker");
      await expect(
        prisma.bot.update({ where: { id: bot.id }, data: { botKind: "agent" } }),
      ).rejects.toThrow("Bot kind cannot be changed");
      await expect(
        prisma.bot.update({ where: { id: bot.id }, data: { fleetManagement: true } }),
      ).rejects.toThrow();
      const clone = await repos.createBot(actor, {
        ...input,
        name: "Mira copy",
        roleplayCharacter: bot.roleplayCharacter,
      });
      expect(clone).toMatchObject({
        botKind: "roleplay",
        roleplayCharacter: character,
        executionTarget: "docker",
      });
      expect(clone.threadId).not.toBe(bot.threadId);
    }));
  it("rejects a stale encrypted character baseline without changing story state", () =>
    runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const bot = await repos.createBot(actor, input);
      const state = { version: 1, summary: "The voyage has begun", botId: bot.id };
      await prisma.thread.update({ where: { id: bot.threadId }, data: { roleplayState: state } });
      const messages = await prisma.message.findMany({ where: { threadId: bot.threadId } });
      const updatedCharacter = { ...character, scenario: "A distant harbor" };
      const options = {
        prisma,
        notify: async () => {},
        ...identity,
        threadId: bot.threadId,
        botId: bot.id,
        expectedRoleplayCharacter: character,
        data: { roleplayCharacter: updatedCharacter },
        emitBotUpdated: false,
      };
      await commitBotUpdate(options);
      const eventCount = await prisma.event.count({ where: { threadId: bot.threadId } });
      await expect(
        commitBotUpdate({
          ...options,
          data: { roleplayCharacter: { ...character, personality: "Stale edit" } },
        }),
      ).rejects.toThrow("Roleplay settings changed elsewhere");
      expect((await repos.getBot(actor, bot.id)).roleplayCharacter).toEqual(updatedCharacter);
      expect(await prisma.event.count({ where: { threadId: bot.threadId } })).toBe(eventCount);
      expect(await prisma.message.findMany({ where: { threadId: bot.threadId } })).toEqual(
        messages,
      );
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toEqual(state);
    }));
  it("replaces a character only after all active runs stop", () =>
    runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const bot = await repos.createBot(actor, input);
      const task = await prisma.task.create({
        data: {
          ...identity,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: "Continue",
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          ...identity,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
      const update = () =>
        commitBotUpdate({
          prisma,
          notify: async () => {},
          ...identity,
          threadId: bot.threadId,
          botId: bot.id,
          data: { roleplayCharacter: { ...character, personality: "Quiet" } },
          emitBotUpdated: false,
        });
      await expect(update()).rejects.toThrow("Stop the roleplay bot");
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      await update();
      expect((await repos.getBot(actor, bot.id)).roleplayCharacter).toMatchObject({
        personality: "Quiet",
      });
    }));
});
