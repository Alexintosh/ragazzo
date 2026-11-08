import type { Actor } from "@rakazo/contracts";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBotExecution } from "./bot-execution.js";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { clearThread, finalizeRun } from "./events.js";
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
  it("atomically saves chat bursts and encrypted continuity once", () =>
    runAsTenant(identity, async () => {
      const bot = await createRepos(prisma).createBot(actor, {
        ...input,
        roleplayCharacter: { ...character, conversationStyle: "chat" },
      });
      const task = await prisma.task.create({
        data: {
          ...identity,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: "Continue",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          ...identity,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
          startedAt: new Date(),
          leaseOwner: "chat-fixture-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      const continuity = {
        scene: "The AMARANTH harbor",
        relationship: "New acquaintances",
        sharedDetails: ["They discussed a map"],
        openThreads: ["No trip agreed yet"],
        callbacks: [],
      };
      const state = {
        version: 1,
        threadId: bot.threadId,
        botId: bot.id,
        historyGeneration: 0,
        summary: "",
        summarizedUpToSeq: -1,
        turnCount: 1,
        lastRunId: run.id,
        activeLoreEntries: [],
        retainedInputs: [],
        continuity,
      };
      const finalization = {
        ...identity,
        threadId: bot.threadId,
        botId: bot.id,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        leaseOwner: "chat-fixture-worker",
        leaseFence: 1,
        outcome: "completed" as const,
        blocks: [{ kind: "text" as const, text: "I found the map." }],
        additionalMessages: [
          [{ kind: "text" as const, text: "Mostly intact." }],
          [{ kind: "text" as const, text: "Want to see?" }],
        ],
        roleplayState: state,
      };
      expect(await finalizeRun(prisma, finalization)).toEqual({ continuationRunId: null });
      expect(await finalizeRun(prisma, finalization)).toBe(false);
      const replies = await prisma.message.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
      });
      expect(replies.map(({ blocks }) => blocks)).toEqual([
        finalization.blocks,
        ...finalization.additionalMessages,
      ]);
      expect(new Set(replies.map(({ seq }) => seq)).size).toBe(3);
      expect(
        await prisma.event.count({ where: { runId: run.id, type: "thread.message.created" } }),
      ).toBe(3);
      expect(await prisma.event.count({ where: { runId: run.id, type: "run.completed" } })).toBe(1);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toEqual(state);
      const raw = await prisma.$queryRaw<
        Array<{ state: unknown }>
      >`SELECT "roleplayState" AS state FROM threads WHERE id=${bot.threadId}`;
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
    }));
  it.each([
    { stale: false, repeat: false, requested: false },
    { stale: true, repeat: false, requested: false },
    { stale: false, repeat: true, requested: true },
    { stale: false, repeat: true, requested: false },
  ])(
    "finalizes an owned image atomically: stale=$stale repeat=$repeat requested=$requested",
    ({ stale, repeat, requested }) =>
      runAsTenant(identity, async () => {
        await prisma.user.update({
          where: { id: identity.userId },
          data: { roleplayEnabled: true },
        });
        const bot = await createRepos(prisma).createBot(actor, input);
        const image = await prisma.artifact.create({
          data: {
            ...identity,
            botId: bot.id,
            name: "forest.png",
            mimeType: "image/png",
            size: 8,
            hash: "fixture",
            storageKey: "fixture-image",
          },
        });
        const media = {
          enabled: true,
          allowSpontaneous: false,
          normalIntervalTurns: 4,
          storyIntervalTurns: 1,
          album: [{ id: "forest", artifactId: image.id, description: "A forest", enabled: true }],
        };
        await prisma.bot.update({
          where: { id: bot.id },
          data: { roleplayCharacter: { ...character, media } },
        });
        const task = await prisma.task.create({
          data: {
            ...identity,
            botId: bot.id,
            threadId: bot.threadId,
            prompt: "Continue",
            status: "running",
          },
        });
        const run = await prisma.run.create({
          data: {
            ...identity,
            botId: bot.id,
            threadId: bot.threadId,
            taskId: task.id,
            status: "running",
            trigger: "user",
            startedAt: new Date(),
            leaseOwner: "image-fixture-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        const attempt = await prisma.attempt.create({
          data: { runId: run.id, fence: 1, status: "running" },
        });
        if (stale)
          await prisma.bot.update({
            where: { id: bot.id },
            data: {
              roleplayCharacter: { ...character, media: { ...media, enabled: false } },
            },
          });
        const saved = {
          media: {
            storyMode: true,
            scene: "Forest",
            revision: 1,
            turn: 1,
            lastImageTurn: 1,
            sentImageIds: ["forest"],
          },
        };
        const previous = repeat
          ? { media: { ...saved.media, revision: 0, turn: 0, lastImageTurn: 0 } }
          : null;
        if (previous)
          await prisma.thread.update({
            where: { id: bot.threadId },
            data: { roleplayState: previous },
          });
        const suppressed = stale || (repeat && !requested);
        const result = await finalizeRun(prisma, {
          ...identity,
          botId: bot.id,
          threadId: bot.threadId,
          runId: run.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: "image-fixture-worker",
          leaseFence: 1,
          outcome: "completed",
          blocks: [
            { kind: "text", text: "Here is the forest" },
            {
              kind: "image",
              artifactId: image.id,
              mimeType: "image/png",
              name: "forest.png",
              description: "A forest",
            },
          ],
          roleplayState: saved,
          roleplayMediaGuard: {
            revision: 0,
            historyGeneration: 0,
            characterMedia: JSON.stringify(media),
            imageRequested: requested,
          },
        });
        expect(result).toEqual({
          continuationRunId: null,
          ...(suppressed ? { suppressed: true } : {}),
        });
        const messages = await prisma.message.findMany({ where: { runId: run.id } });
        expect(messages).toHaveLength(suppressed ? 0 : 1);
        expect(
          (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
        ).toEqual(suppressed ? previous : saved);
      }),
  );
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
