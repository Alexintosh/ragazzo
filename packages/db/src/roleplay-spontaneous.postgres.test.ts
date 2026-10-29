import { randomUUID } from "node:crypto";
import type { RoleplayCharacter } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { createThreadMessage, createThreadMessageInTransaction } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { roleplaySpontaneousSnapshot } from "./roleplay-spontaneous.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const character: RoleplayCharacter = {
  name: "Aria",
  description: "Explorer",
  personality: "Curious",
  scenario: "",
  firstMessage: "Hello",
  exampleDialogue: "",
  alternateGreetings: [],
  systemPrompt: "",
  postHistoryInstructions: "",
  lorebook: null,
  conversationStyle: "chat",
  spontaneous: { enabled: true, frequency: "balanced", allowLateNight: false },
};

/** One isolated fixture and one race; no models, sandboxes, global rewrites, or encryption migration. */
describePostgres("spontaneous finalization fence (PostgreSQL)", () => {
  const address = `roleplay-spontaneous-${randomUUID()}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    system = asSystem(prisma);
    const provisioned = await runAsSystem("spontaneous test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    if (!provisioned.created)
      throw new Error("Spontaneous fixture must own a newly created identity");
    identity = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
      threadId: provisioned.threadId,
    };
    const offset = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
    const timezone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    await system.user.update({ where: { id: identity.userId }, data: { timezone } });
    const bot = await runAsTenant(identity, () =>
      createRepos(prisma).createBot(
        { ...identity, email: "fixture@example.test", isDeploymentOwner: false },
        {
          name: "Aria",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          botKind: "roleplay",
          roleplayCharacter: character,
        },
      ),
    );
    identity = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      botId: bot.id,
      threadId: bot.threadId,
    };
    const source = await createThreadMessage(system, {
      threadId: identity.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "We can talk later." }],
    });
    const old = new Date(Date.now() - 48 * 3_600_000);
    await system.message.updateMany({
      where: { threadId: identity.threadId, seq: { lte: source.seq } },
      data: { createdAt: old },
    });
  });
  afterAll(async () => {
    try {
      if (identity) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await prisma?.$disconnect();
      await db?.pool.end();
    }
  });
  it("suppresses a generated reply when a real input commits ahead of the finalization thread lock", async () => {
    await runAsTenant(identity, async () => {
      const snapshot = await roleplaySpontaneousSnapshot(prisma, identity);
      expect(snapshot).not.toBeNull();
      const task = await prisma.task.create({
        data: { ...identity, prompt: JSON.stringify(snapshot!.guard), status: "running" },
      });
      const run = await prisma.run.create({
        data: {
          ...identity,
          taskId: task.id,
          sourceMessageId: snapshot!.guard.sourceMessageId,
          trigger: "roleplay_spontaneous",
          status: "running",
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, status: "running", fence: 1 },
      });
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const incoming = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${identity.threadId} FOR UPDATE`;
        await createThreadMessageInTransaction(tx, {
          threadId: identity.threadId,
          role: "user",
          blocks: [{ kind: "text", text: "I'm here now." }],
        });
        locked();
        await held;
      });
      await acquired;
      const finalizing = finalizeRun(prisma, {
        ...identity,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        spontaneousGuard: snapshot!.guard,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Stale proactive reply" }],
        additionalMessages: [[{ kind: "text", text: "Also stale" }]],
        roleplayState: { stale: true },
      });
      release();
      await incoming;
      expect(await finalizing).toEqual({ continuationRunId: null, suppressed: true });
      expect(await prisma.message.count({ where: { runId: run.id } })).toBe(0);
      expect(
        await prisma.event.count({ where: { runId: run.id, type: "thread.message.created" } }),
      ).toBe(0);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: identity.threadId } })).roleplayState,
      ).not.toEqual({ stale: true });
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "completed",
      );
    });
  });
});
