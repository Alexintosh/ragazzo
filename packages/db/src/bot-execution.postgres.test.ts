import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBotExecution } from "./bot-execution.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot execution placement (PostgreSQL)", () => {
  const stamp = String(Date.now()).slice(-7);
  const address = `+1557${stamp}`;
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
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    actor = { ...identity, email: "execution@example.test", isDeploymentOwner: false };
  });
  afterAll(async () => {
    if (prisma && identity) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await close?.();
  });

  it("keeps a mixed team on separate computers and retains both workspaces across settings changes", async () => {
    await runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const input = {
        name: "Helper",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      };
      const first = await repos.createBot(actor, input);
      const second = await repos.createBot(actor, input);
      const original = await repos.getBot(actor, first.id);
      expect(first.runtimeKind).toBe("pi");
      expect(first.executionTarget).toBe("default");
      const settings = {
        botId: second.id,
        runtimeKind: "codex" as const,
        executionTarget: "host" as const,
        runtimePermission: "workspace" as const,
        projectPath: "/projects/example",
      };
      await setBotExecution(prisma, actor, settings);
      const native = await repos.getBot(actor, second.id);
      expect(native.computerId).not.toBe(original.computerId);
      expect(native.computer).toMatchObject({
        kind: "desktop",
        scope: "dedicated",
        executionTarget: "host",
      });
      expect((await repos.getBot(actor, first.id)).computerId).toBe(original.computerId);
      expect((await repos.listBots(actor)).find((bot) => bot.id === second.id)).toMatchObject({
        runtimeKind: "codex",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: settings.projectPath,
      });
      const task = await prisma.task.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: second.id,
          threadId: native.thread!.id,
          prompt: "work",
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: second.id,
          threadId: native.thread!.id,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
      await expect(
        setBotExecution(prisma, actor, { ...settings, runtimePermission: "full" }),
      ).rejects.toThrow("Stop the bot");
      expect((await repos.getBot(actor, second.id)).runtimePermission).toBe("workspace");
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      await setBotExecution(prisma, actor, {
        botId: second.id,
        runtimeKind: "pi",
        executionTarget: "default",
        runtimePermission: "workspace",
        projectPath: null,
      });
      expect((await repos.getBot(actor, second.id)).computerId).toBe(original.computerId);
      expect(
        await prisma.computer.findUnique({ where: { id: native.computerId! } }),
      ).not.toBeNull();
    });
  });
  it("shares explicit host and Docker team computers independently and can return to private", async () => {
    await runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const input = {
        name: "Placement",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      };
      const bots = await Promise.all([
        repos.createBot(actor, input),
        repos.createBot(actor, input),
        repos.createBot(actor, input),
      ]);
      const original = (await repos.getBot(actor, bots[2].id)).computerId;
      for (const bot of bots.slice(0, 2)) {
        await setBotExecution(prisma, actor, {
          botId: bot.id,
          runtimeKind: "pi",
          executionTarget: "host",
          runtimePermission: "workspace",
          projectPath: null,
        });
      }
      const privateHost = (await repos.getBot(actor, bots[0].id)).computerId;
      await repos.setBotComputer(actor, bots[0].id, "team");
      await repos.setBotComputer(actor, bots[1].id, "team");
      const first = await repos.getBot(actor, bots[0].id);
      const second = await repos.getBot(actor, bots[1].id);
      expect(first.computerId).toBe(second.computerId);
      expect(first.computerId).not.toBe(original);
      expect(first.computer).toMatchObject({
        scope: "team",
        kind: "desktop",
        executionTarget: "host",
      });
      await setBotExecution(prisma, actor, {
        botId: bots[1].id,
        runtimeKind: "pi",
        executionTarget: "docker",
        runtimePermission: "workspace",
        projectPath: null,
      });
      await repos.setBotComputer(actor, bots[1].id, "team");
      const docker = await repos.getBot(actor, bots[1].id);
      expect(docker.computerId).not.toBe(first.computerId);
      expect(docker.computerId).not.toBe(original);
      expect(docker.computer).toMatchObject({
        scope: "team",
        kind: "docker",
        executionTarget: "docker",
      });
      expect((await repos.getBot(actor, bots[0].id)).computerId).toBe(first.computerId);
      expect((await repos.getBot(actor, bots[2].id)).computerId).toBe(original);
      await repos.setBotComputer(actor, bots[0].id, "dedicated");
      expect((await repos.getBot(actor, bots[0].id)).computerId).toBe(privateHost);
    });
  });
  it("creates a native bot with its execution configuration and target atomically", async () => {
    await runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const input = {
        name: "Native",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
        runtimeKind: "codex" as const,
        executionTarget: "host" as const,
        runtimePermission: "workspace" as const,
        projectPath: "/projects/native",
        computerMode: "team" as const,
      };
      const created = await repos.createBot(actor, input);
      const bot = await repos.getBot(actor, created.id);
      expect(bot).toMatchObject({
        runtimeKind: "codex",
        executionTarget: "host",
        projectPath: input.projectPath,
      });
      expect(bot.computer).toMatchObject({
        scope: "team",
        executionTarget: "host",
        kind: "desktop",
      });
      const count = await prisma.bot.count({ where: { userId: actor.userId } });
      await expect(repos.createBot(actor, { ...input, executionTarget: "docker" })).rejects.toThrow(
        "Codex requires",
      );
      expect(await prisma.bot.count({ where: { userId: actor.userId } })).toBe(count);
    });
  });

  it("rejects a stale mode save after a target switch and preserves a newly queued run", async () => {
    await runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const created = await repos.createBot(actor, {
        name: "Race",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      const before = await repos.getBot(actor, created.id);
      await setBotExecution(prisma, actor, {
        botId: created.id,
        runtimeKind: "pi",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: null,
      });
      const current = await repos.getBot(actor, created.id);
      const task = await prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: created.id,
          threadId: current.thread!.id,
          prompt: "work",
          status: "queued",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: created.id,
          threadId: current.thread!.id,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
      await expect(
        repos.setBotComputer(actor, created.id, "team", before.computerId!),
      ).rejects.toThrow("settings changed");
      await expect(
        repos.setBotComputer(actor, created.id, "team", current.computerId!),
      ).rejects.toThrow("Stop the bot");
      expect((await repos.getBot(actor, created.id)).computerId).toBe(current.computerId);
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");
    });
  });
  it("invalidates native session identity when switching away and back without clearing history", async () => {
    await runAsTenant(identity, async () => {
      const repos = createRepos(prisma);
      const created = await repos.createBot(actor, {
        name: "Handover",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      const native = {
        botId: created.id,
        runtimeKind: "codex" as const,
        executionTarget: "host" as const,
        runtimePermission: "workspace" as const,
        projectPath: "/projects/handover",
      };
      await setBotExecution(prisma, actor, native);
      const first = await repos.getBot(actor, created.id);
      await setBotExecution(prisma, actor, native);
      expect((await repos.getBot(actor, created.id)).runtimeGeneration).toBe(
        first.runtimeGeneration,
      );
      await setBotExecution(prisma, actor, { ...native, runtimeKind: "pi", projectPath: null });
      await setBotExecution(prisma, actor, native);
      const returned = await repos.getBot(actor, created.id);
      expect(returned.runtimeGeneration).toBe(first.runtimeGeneration + 2);
      expect(returned.thread!.id).toBe(first.thread!.id);
      expect(returned.thread!.historyCompactionGeneration).toBe(
        first.thread!.historyCompactionGeneration,
      );
    });
  });
});
