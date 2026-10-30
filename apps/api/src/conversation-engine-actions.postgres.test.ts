import { randomUUID } from "node:crypto";
import type { ConversationEngine } from "@rakazo/adapter-kit";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type {
  Actor,
  ConversationEngineActionResult,
  RunConversationEngineAction,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  contentEncryptionStatus,
  createDb,
  createRepos,
  createThreadEvents,
  Prisma,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runConversationEngineAction } from "./conversation-engine-actions.js";
import { updateConversationEngineSettings } from "./conversation-engine-state.js";
import type { RouterDeps } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const characterId = "22222222-2222-4222-8222-222222222222";
const empty: ConversationEngineActionResult = { message: null, event: null };

describePostgres("conversation engine native actions (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const actors: Actor[] = [];
  const addresses: string[] = [];
  const owner = <T>(actor: Actor, work: () => Promise<T>) => runAsTenant(actor, work);
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    for (let index = 0; index < 2; index++) {
      const address = `engine-actions-${randomUUID()}`;
      addresses.push(address);
      const identity = await runAsSystem("engine action fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider: "sendblue", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      actors.push({
        userId: identity.userId,
        spaceId: identity.spaceId,
        email: "engine@example.invalid",
        isDeploymentOwner: false,
      });
    }
  });
  afterAll(async () => {
    if (prisma) {
      const system = asSystem(prisma, "engine action fixture cleanup");
      for (const actor of actors) {
        await system.companionAction.deleteMany({ where: { userId: actor.userId } });
        await system.companionTurn.deleteMany({ where: { userId: actor.userId } });
        await system.companionSession.deleteMany({ where: { userId: actor.userId } });
        await system.messagingIdentity.deleteMany({
          where: { provider: "sendblue", address: { in: addresses } },
        });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });
  async function fixture() {
    const actor = actors[0]!;
    const bot = await owner(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Aster",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        botKind: "roleplay",
        conversationEngine: "eros",
        erosCharacterId: characterId,
      }),
    );
    const session = await owner(actor, () =>
      prisma.companionSession.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: bot.threadId,
          historyGeneration: 0,
          engineUserId: randomUUID(),
          engineSessionId: randomUUID(),
          engineInstanceId: randomUUID(),
        },
      }),
    );
    const openSession = vi.fn(async (): Promise<ConversationEngineActionResult> => empty);
    const engine: ConversationEngine = {
      id: "eros",
      name: "Eros",
      characters: [{ id: characterId, name: "Aster" }],
      capabilities: { streaming: true, tools: false, cancel: false },
      provision: vi.fn(),
      stream: vi.fn(),
      openSession,
      drawEvent: vi.fn(),
      addItem: vi.fn(),
      deleteItem: vi.fn(),
    };
    const deps = {
      prisma,
      env: { roleplayEnabled: true },
      conversationEngines: new Map([["eros", engine]]),
      events: createThreadEvents(prisma),
    } as unknown as RouterDeps;
    const input: RunConversationEngineAction = {
      botId: bot.id,
      historyGeneration: 0,
      actionId: randomUUID(),
      action: { kind: "open", occasion: "just_opened" },
    };
    const run = (value = input) =>
      owner(actor, () => runConversationEngineAction(deps, actor, value));
    return { actor, bot, session, openSession, deps, input, run };
  }

  it("persists null outcomes and safe settings encrypted without repeating native calls", async () => {
    const f = await fixture();
    await owner(f.actor, () =>
      prisma.bot.update({
        where: { id: f.bot.id },
        data: {
          conversationEngineSettings: {
            promptTraits: [{ tag: "curious", text: "Private action trait" }],
          },
        },
      }),
    );
    expect(await f.run()).toEqual({ status: "completed", message: null });
    expect(await f.run()).toEqual({ status: "completed", message: null });
    expect(f.openSession).toHaveBeenCalledTimes(1);
    await owner(f.actor, async () => {
      const saved = await prisma.companionAction.findUniqueOrThrow({
        where: { id: f.input.actionId },
      });
      expect(saved).toMatchObject({
        status: "completed",
        response: { status: "completed", message: null },
        request: { settings: { promptTraits: [{ tag: "curious", text: "Private action trait" }] } },
      });
      const rows = await prisma.$queryRaw<
        Array<{ request: unknown; response: unknown }>
      >`SELECT request,response FROM companion_actions WHERE id=${f.input.actionId}`;
      expect(JSON.stringify(rows[0]!.request)).not.toContain("Private action trait");
      expect(JSON.stringify(rows[0]!.response)).not.toContain("completed");
      expect(await prisma.message.count({ where: { threadId: f.bot.threadId, role: "bot" } })).toBe(
        0,
      );
    });
  });

  it("imports the same native reply once across action retries and later native replay", async () => {
    const f = await fixture();
    const id = randomUUID();
    f.openSession.mockResolvedValue({
      message: {
        id,
        text: "Native greeting",
        sentAt: "2026-01-01T00:00:00Z",
        occasion: "just_opened",
      },
      event: null,
    });
    await f.run();
    await f.run();
    await f.run({ ...f.input, actionId: randomUUID() });
    expect(f.openSession).toHaveBeenCalledTimes(2);
    await owner(f.actor, async () => {
      expect(
        await prisma.message.findMany({ where: { threadId: f.bot.threadId, role: "bot" } }),
      ).toMatchObject([
        {
          clientNonce: `eros:${f.session.engineSessionId}:${id}`,
          blocks: [{ kind: "text", text: "Native greeting" }],
        },
      ]);
      expect(
        await prisma.event.count({
          where: { threadId: f.bot.threadId, type: "thread.message.created" },
        }),
      ).toBe(1);
      expect(
        (await prisma.companionSession.findUniqueOrThrow({ where: { id: f.session.id } }))
          .leaseRunId,
      ).toBeNull();
    });
  });

  it("keeps a network-ambiguous action uncertain and prevents its replay or replacement", async () => {
    const f = await fixture();
    f.openSession.mockRejectedValueOnce(new Error("Synthetic network failure"));
    expect(await f.run()).toEqual({ status: "uncertain", message: null });
    expect(await f.run()).toEqual({ status: "uncertain", message: null });
    await expect(f.run({ ...f.input, actionId: randomUUID() })).rejects.toThrow("settle");
    expect(f.openSession).toHaveBeenCalledTimes(1);
    await expect(
      owner(f.actor, () =>
        updateConversationEngineSettings(f.deps, f.actor, {
          botId: f.bot.id,
          historyGeneration: 0,
          expectedRevision: 0,
          settings: { tier: "advanced" },
        }),
      ),
    ).rejects.toThrow("current reply");
    await owner(f.actor, async () =>
      expect(
        (await prisma.companionAction.findUniqueOrThrow({ where: { id: f.input.actionId } }))
          .status,
      ).toBe("uncertain"),
    );
  });

  it("saves encrypted defaults before provisioning and serializes competing settings revisions", async () => {
    const f = await fixture();
    await owner(f.actor, () => prisma.companionSession.delete({ where: { id: f.session.id } }));
    const input = {
      botId: f.bot.id,
      historyGeneration: 0,
      expectedRevision: 0,
      settings: { promptTraits: [{ tag: "private", text: "Private saved default" }] },
    };
    expect(
      await owner(f.actor, () => updateConversationEngineSettings(f.deps, f.actor, input)),
    ).toEqual({ revision: 1, values: input.settings });
    await expect(
      owner(f.actor, () => updateConversationEngineSettings(f.deps, f.actor, input)),
    ).rejects.toThrow("Refresh before saving");
    const competing = await Promise.allSettled([
      owner(f.actor, () =>
        updateConversationEngineSettings(f.deps, f.actor, {
          ...input,
          expectedRevision: 1,
          settings: { tier: "first" },
        }),
      ),
      owner(f.actor, () =>
        updateConversationEngineSettings(f.deps, f.actor, {
          ...input,
          expectedRevision: 1,
          settings: { tier: "second" },
        }),
      ),
    ]);
    expect(competing.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await owner(f.actor, async () => {
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: f.bot.id } });
      expect(bot.conversationEngineSettingsRevision).toBe(2);
      expect(await prisma.companionSession.count({ where: { botId: f.bot.id } })).toBe(0);
      const rows = await prisma.$queryRaw<
        Array<{ settings: unknown }>
      >`SELECT "conversationEngineSettings" AS settings FROM bots WHERE id=${f.bot.id}`;
      expect(JSON.stringify(rows[0]!.settings)).not.toContain("tier");
    });
    expect(f.openSession).not.toHaveBeenCalled();
  });

  it("rejects other owners, changed payloads, stale generations, and active session leases", async () => {
    const f = await fixture();
    const stranger = actors[1]!;
    await expect(
      owner(stranger, () => runConversationEngineAction(f.deps, stranger, f.input)),
    ).rejects.toThrow();
    await f.run();
    await expect(
      f.run({ ...f.input, action: { kind: "open", occasion: "returning" } }),
    ).rejects.toThrow("settle");
    await expect(
      f.run({ ...f.input, actionId: randomUUID(), historyGeneration: 1 }),
    ).rejects.toThrow("settle");
    await owner(f.actor, () =>
      prisma.companionSession.update({
        where: { id: f.session.id },
        data: { leaseRunId: "active-worker", leaseExpiresAt: new Date(Date.now() + 60_000) },
      }),
    );
    await expect(f.run({ ...f.input, actionId: randomUUID() })).rejects.toThrow("settle");
    expect(f.openSession).toHaveBeenCalledTimes(1);
    await owner(stranger, async () =>
      expect(
        await prisma.companionAction.findUnique({ where: { id: f.input.actionId } }),
      ).toBeNull(),
    );
  });

  it("marks a definite native rejection failed and allows a distinct later action", async () => {
    const f = await fixture();
    f.openSession.mockRejectedValueOnce(new ConversationEngineError("invalid_request"));
    await expect(f.run()).rejects.toThrow();
    await owner(f.actor, async () =>
      expect(
        (await prisma.companionAction.findUniqueOrThrow({ where: { id: f.input.actionId } }))
          .status,
      ).toBe("failed"),
    );
    expect(await f.run({ ...f.input, actionId: randomUUID() })).toEqual({
      status: "completed",
      message: null,
    });
  });

  it("counts each plaintext engine field once and excludes sealed values and JSON or SQL nulls", async () => {
    const f = await fixture();
    await f.run();
    await owner(f.actor, async () => {
      await prisma.bot.update({
        where: { id: f.bot.id },
        data: { conversationEngineSettings: { tier: "advanced" } },
      });
      const run = await createThreadEvents(prisma).sendUserMessage({
        spaceId: f.actor.spaceId,
        userId: f.actor.userId,
        threadId: f.bot.threadId,
        botId: f.bot.id,
        blocks: [{ kind: "text", text: "Status fixture" }],
        prompt: "Status fixture",
        trigger: "user",
        clientNonce: randomUUID(),
      });
      const turn = await prisma.companionTurn.create({
        data: {
          runId: run.runId!,
          sessionId: f.session.id,
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          clientMessageId: randomUUID(),
          input: "Status fixture",
          request: { version: 1, settings: {} },
          response: "Reply",
          error: "Error",
        },
      });
      const before = await contentEncryptionStatus(prisma);
      const count = (status: typeof before, table: string) =>
        status.tables.find((row) => row.table === table)!;
      const fields = [
        ["bots", "conversationEngineSettings", f.bot.id, true],
        ["companion_turns", "input", turn.id, false],
        ["companion_turns", "request", turn.id, true],
        ["companion_turns", "response", turn.id, false],
        ["companion_turns", "error", turn.id, false],
        ["companion_actions", "request", f.input.actionId, true],
        ["companion_actions", "response", f.input.actionId, true],
      ] as const;
      for (const [table, column, id, json] of fields) {
        const target = Prisma.raw(`"${table}"`);
        const field = Prisma.raw(`"${column}"`);
        const [original] = await prisma.$queryRaw<Array<{ value: Prisma.JsonValue }>>(
          Prisma.sql`SELECT ${field} AS value FROM ${target} WHERE id=${id}`,
        );
        const plain = json ? Prisma.sql`'{"plain":"value"}'::jsonb` : Prisma.sql`'plain'`;
        await prisma.$executeRaw(Prisma.sql`UPDATE ${target} SET ${field}=${plain} WHERE id=${id}`);
        const mixed = await contentEncryptionStatus(prisma);
        expect(count(mixed, table)).toEqual({
          ...count(before, table),
          plaintext: count(before, table).plaintext + 1,
        });
        const restored = json
          ? Prisma.sql`${JSON.stringify(original!.value)}::jsonb`
          : Prisma.sql`${original!.value}`;
        await prisma.$executeRaw(
          Prisma.sql`UPDATE ${target} SET ${field}=${restored} WHERE id=${id}`,
        );
        expect(count(await contentEncryptionStatus(prisma), table)).toEqual(count(before, table));
      }
      await prisma.$executeRaw`UPDATE companion_turns SET request='{}'::jsonb,response='plain' WHERE id=${turn.id}`;
      await prisma.$executeRaw`UPDATE companion_actions SET request='{}'::jsonb,response='{}'::jsonb WHERE id=${f.input.actionId}`;
      const severalPlainFields = await contentEncryptionStatus(prisma);
      for (const table of ["companion_turns", "companion_actions"])
        expect(count(severalPlainFields, table).plaintext).toBe(count(before, table).plaintext + 1);
      await prisma.$executeRaw`UPDATE companion_turns SET request='null'::jsonb,response=NULL,error=NULL WHERE id=${turn.id}`;
      await prisma.$executeRaw`UPDATE companion_actions SET request='null'::jsonb,response=NULL WHERE id=${f.input.actionId}`;
      await prisma.$executeRaw`UPDATE bots SET "conversationEngineSettings"='null'::jsonb WHERE id=${f.bot.id}`;
      const nulls = await contentEncryptionStatus(prisma);
      expect(count(nulls, "companion_turns")).toEqual(count(before, "companion_turns"));
      for (const table of ["bots", "companion_actions"]) {
        expect(count(nulls, table)).toEqual({
          ...count(before, table),
          rows: count(before, table).rows - 1,
        });
      }
    });
  });
});
