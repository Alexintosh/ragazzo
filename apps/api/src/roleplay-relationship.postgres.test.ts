import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import {
  asSystem,
  clearThread,
  createDb,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRoleplayRelationship, updateRoleplayRelationship } from "./roleplay-relationship.js";
import type { RouterDeps } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

postgres("relationship debug scoped persistence (PostgreSQL)", () => {
  const address = `roleplay-debug-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let actor: Actor;
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    const identity = await runAsSystem("relationship debug fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    if (!identity.created)
      throw new Error("Relationship fixture must own a newly created identity");
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "fixture@example.test",
      isDeploymentOwner: false,
    };
  });
  afterAll(async () => {
    if (actor) {
      const system = asSystem(db.prisma, "relationship debug fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: actor.spaceId } });
      await system.user.deleteMany({ where: { id: actor.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("saves encrypted scores across a client restart, rejects stale resets, and preserves messages", async () => {
    await runAsTenant(actor, async () => {
      const character = parseRoleplayCharacterJson(
        '{"name":"Mira","first_mes":"Welcome."}',
      ).character;
      const bot = await createRepos(db.prisma).createBot(actor, {
        name: "Mira",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        botKind: "roleplay",
        roleplayCharacter: character,
      });
      await db.prisma.user.update({ where: { id: actor.userId }, data: { roleplayEnabled: true } });
      let deps = { prisma: db.prisma } as Pick<RouterDeps, "prisma">;
      const before = await loadRoleplayRelationship(deps, actor, bot.id);
      const messages = await db.prisma.message.findMany({ where: { threadId: bot.threadId } });
      const input = {
        botId: bot.id,
        relationship: { warmth: 80, intimacy: 30, love: 15 },
        historyGeneration: before.historyGeneration,
        expectedRevision: before.revision,
      };
      const after = await updateRoleplayRelationship(deps, actor, input);
      expect(after.relationship).toEqual(input.relationship);
      // Discard the writing client, pool and in-memory content keys. A new process
      // must recover the saved scores from the database and persisted space key.
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(databaseUrl!, { encryptContent: true });
      deps = { ...deps, prisma: db.prisma };
      expect(await loadRoleplayRelationship(deps, actor, bot.id)).toEqual(after);
      const raw = await db.prisma.$queryRaw<
        Array<{ roleplayState: unknown }>
      >`SELECT "roleplayState" FROM threads WHERE id=${bot.threadId}`;
      expect(JSON.stringify(raw)).toContain("$sealed");
      expect(JSON.stringify(raw)).not.toContain("warmth");
      expect(await db.prisma.message.findMany({ where: { threadId: bot.threadId } })).toEqual(
        messages,
      );
      await expect(updateRoleplayRelationship(deps, actor, input)).rejects.toThrow(
        "conversation changed",
      );
      await expect(
        runAsTenant({ ...actor, userId: "another-owner" }, () =>
          loadRoleplayRelationship(deps, { ...actor, userId: "another-owner" }, bot.id),
        ),
      ).rejects.toThrow();
      await clearThread(db.prisma, {
        spaceId: actor.spaceId,
        threadId: bot.threadId,
        botId: bot.id,
      });
      const reset = await loadRoleplayRelationship(deps, actor, bot.id);
      expect(reset.relationship).toEqual({ warmth: 10, intimacy: 0, love: 0 });
      await expect(
        updateRoleplayRelationship(deps, actor, { ...input, expectedRevision: after.revision }),
      ).rejects.toThrow("conversation changed");
    });
  });
});
