import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBotExecution } from "./bot-execution.js";
import { setBotRuntimeModel } from "./bot-runtime-model.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("native bot model persistence (PostgreSQL)", () => {
  const address = `+1558${String(Date.now()).slice(-7)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: { userId: string; spaceId: string };
  let actor: Actor;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("model selection test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    actor = { ...identity, email: "models@example.test", isDeploymentOwner: false };
  });
  afterAll(async () => {
    if (prisma && identity) {
      const system = asSystem(prisma, "model selection test cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await close?.();
  });

  async function createNativeBot() {
    const repos = createRepos(prisma);
    const created = await repos.createBot(actor, {
      name: "Model selection test",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      runtimeKind: "codex",
      executionTarget: "host",
      runtimePermission: "workspace",
      projectPath: "/projects/example",
    });
    const bot = await repos.getBot(actor, created.id);
    return {
      repos,
      bot,
      expected: {
        runtimeKind: bot.runtimeKind,
        runtimeGeneration: bot.runtimeGeneration,
        registeredHostId: bot.registeredHostId,
        projectPath: bot.projectPath,
      },
    };
  }

  it("round-trips a model/effort override and clears both without changing placement", async () => {
    await runAsTenant(identity, async () => {
      const { repos, bot, expected } = await createNativeBot();
      const event = await setBotRuntimeModel(
        prisma,
        actor,
        { botId: bot.id, modelId: "test-model", thinkingLevel: "high" },
        expected,
      );
      expect(event.threadId).toBe(bot.thread!.id);
      expect(await repos.getBot(actor, bot.id)).toMatchObject({
        modelProvider: "codex-native",
        modelId: "test-model",
        thinkingLevel: "high",
        computerId: bot.computerId,
        projectPath: bot.projectPath,
        runtimeKind: "codex",
      });
      await setBotRuntimeModel(
        prisma,
        actor,
        { botId: bot.id, modelId: null, thinkingLevel: null },
        expected,
      );
      expect(await repos.getBot(actor, bot.id)).toMatchObject({
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
    });
  });

  it("refuses model changes while a queued run exists and leaves the run untouched", async () => {
    await runAsTenant(identity, async () => {
      const { repos, bot, expected } = await createNativeBot();
      const task = await prisma.task.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: bot.id,
          threadId: bot.thread!.id,
          prompt: "model selection fixture",
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          taskId: task.id,
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: bot.id,
          threadId: bot.thread!.id,
          status: "queued",
          trigger: "user",
        },
      });
      await expect(
        setBotRuntimeModel(
          prisma,
          actor,
          { botId: bot.id, modelId: "test-model", thinkingLevel: "high" },
          expected,
        ),
      ).rejects.toThrow("Stop the bot");
      expect(await repos.getBot(actor, bot.id)).toMatchObject({
        modelId: null,
        thinkingLevel: null,
      });
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    });
  });

  it("keeps a Pi child free of its native parent's model and effort", async () => {
    await runAsTenant(identity, async () => {
      const { repos, bot, expected } = await createNativeBot();
      await setBotRuntimeModel(
        prisma,
        actor,
        { botId: bot.id, modelId: "test-model", thinkingLevel: "ultra" },
        expected,
      );
      const child = await repos.createBot(actor, {
        name: "Pi child",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
        parentBotId: bot.id,
      });
      expect(await repos.getBot(actor, child.id)).toMatchObject({
        runtimeKind: "pi",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
      expect(await repos.getBot(actor, bot.id)).toMatchObject({
        runtimeKind: "codex",
        modelProvider: "codex-native",
        modelId: "test-model",
        thinkingLevel: "ultra",
      });
    });
  });

  it("rejects a catalog selection after a project switch and clears native preferences on switching to Pi", async () => {
    await runAsTenant(identity, async () => {
      const { repos, bot, expected } = await createNativeBot();
      await setBotRuntimeModel(
        prisma,
        actor,
        { botId: bot.id, modelId: "test-model", thinkingLevel: "high" },
        expected,
      );
      await setBotExecution(prisma, actor, {
        botId: bot.id,
        runtimeKind: "codex",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: "/projects/changed",
      });
      await expect(
        setBotRuntimeModel(
          prisma,
          actor,
          { botId: bot.id, modelId: "other-model", thinkingLevel: "low" },
          expected,
        ),
      ).rejects.toThrow("Execution settings changed");
      expect((await repos.getBot(actor, bot.id)).modelId).toBe("test-model");
      await setBotExecution(prisma, actor, {
        botId: bot.id,
        runtimeKind: "pi",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: null,
      });
      expect(await repos.getBot(actor, bot.id)).toMatchObject({
        runtimeKind: "pi",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      });
    });
  });
});
