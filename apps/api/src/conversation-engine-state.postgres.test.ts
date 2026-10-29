import { randomUUID } from "node:crypto";
import type { ConversationEngine } from "@rakazo/adapter-kit";
import type { Actor, ConversationEngineInspection } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadConversationEngineState,
  updateConversationEngineState,
} from "./conversation-engine-state.js";
import type { RouterDeps } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const characterId = "22222222-2222-4222-8222-222222222222";
const inspection: ConversationEngineInspection = {
  profile: {
    location: null,
    occupation: null,
    currentSituation: null,
    desires: null,
    vulnerabilities: null,
    habits: null,
    personalValues: null,
    likes: [],
    dislikes: [],
    relationships: [],
    updatedAt: null,
  },
  affinity: null,
  latestEvent: null,
  emotionalNeed: null,
  asOf: "2026-01-01T00:00:00Z",
  changesAt: null,
  observedAt: "2026-01-01T00:00:00Z",
  debug: null,
};

describePostgres("conversation engine state authorization and admission (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const actors: Actor[] = [];
  const addresses: string[] = [];
  const owner = <T>(actor: Actor, work: () => Promise<T>) => runAsTenant(actor, work);
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    for (let i = 0; i < 2; i++) {
      const address = `engine-state-${randomUUID()}`;
      addresses.push(address);
      const identity = await runAsSystem("engine state test fixture", () =>
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
      const system = asSystem(prisma, "engine state test cleanup");
      for (const actor of actors) {
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
    const inspect = vi.fn(async () => inspection);
    const updateState = vi.fn(async () => {});
    const engine: ConversationEngine = {
      id: "eros",
      name: "Eros",
      characters: [{ id: characterId, name: "Aster" }],
      capabilities: { streaming: true, tools: false, cancel: false },
      provision: vi.fn(),
      stream: vi.fn(),
      inspect,
      updateState,
    };
    const deps = {
      prisma,
      conversationEngines: new Map([["eros", engine]]),
      env: { roleplayEnabled: true },
    } as unknown as RouterDeps;
    const input = {
      botId: bot.id,
      historyGeneration: 0,
      expectedRevision: "revision-1",
      axes: { trust: 0.2, intrigue: 0.3, intimacy: 0.1, tension: 0.4 },
      warmthGrade: 2,
      patienceGrade: 2,
    };
    const send = () =>
      owner(actor, () =>
        createThreadEvents(prisma).sendUserMessage({
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: bot.threadId,
          blocks: [{ kind: "text", text: "Synthetic turn" }],
          prompt: "Synthetic turn",
          trigger: "user",
          clientNonce: randomUUID(),
        }),
      );
    return { actor, bot, session, inspect, updateState, deps, input, send };
  }

  it("uses only persisted native identities and isolates private bots from other spaces and members", async () => {
    const f = await fixture();
    expect(
      (await owner(f.actor, () => loadConversationEngineState(f.deps, f.actor, f.bot.id))).status,
    ).toBe("ready");
    expect(f.inspect).toHaveBeenCalledWith(
      {
        userId: f.session.engineUserId,
        sessionId: f.session.engineSessionId,
        instanceId: f.session.engineInstanceId,
        characterId,
      },
      undefined,
    );
    for (const stranger of [actors[1]!, { ...actors[1]!, spaceId: f.actor.spaceId }]) {
      await expect(
        owner(stranger, () => loadConversationEngineState(f.deps, stranger, f.bot.id)),
      ).rejects.toThrow();
      await expect(
        owner(stranger, () => updateConversationEngineState(f.deps, stranger, f.input)),
      ).rejects.toThrow();
    }
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.updateState).not.toHaveBeenCalled();
  });

  it("rejects stale generations, active turns and live session leases before remote writes", async () => {
    const f = await fixture();
    await expect(
      owner(f.actor, () =>
        updateConversationEngineState(f.deps, f.actor, { ...f.input, historyGeneration: 1 }),
      ),
    ).rejects.toThrow("conversation changed");
    await owner(f.actor, () =>
      prisma.companionSession.update({
        where: { id: f.session.id },
        data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
      }),
    );
    await expect(
      owner(f.actor, () => updateConversationEngineState(f.deps, f.actor, f.input)),
    ).rejects.toThrow("current reply");
    await owner(f.actor, () =>
      prisma.companionSession.update({
        where: { id: f.session.id },
        data: { leaseExpiresAt: null },
      }),
    );
    await f.send();
    await expect(
      owner(f.actor, () => updateConversationEngineState(f.deps, f.actor, f.input)),
    ).rejects.toThrow("current reply");
    expect(f.updateState).not.toHaveBeenCalled();
  });

  it("blocks uncertain remote replay even when the session lease expired", async () => {
    const f = await fixture();
    await f.send();
    await owner(f.actor, async () => {
      const run = await prisma.run.findFirstOrThrow({ where: { botId: f.bot.id } });
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      await prisma.companionSession.update({
        where: { id: f.session.id },
        data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
      });
      await prisma.companionTurn.create({
        data: {
          runId: run.id,
          sessionId: f.session.id,
          spaceId: f.actor.spaceId,
          userId: f.actor.userId,
          clientMessageId: randomUUID(),
          status: "uncertain",
          input: "Synthetic turn",
        },
      });
    });
    await expect(
      owner(f.actor, () => updateConversationEngineState(f.deps, f.actor, f.input)),
    ).rejects.toThrow("current reply");
    expect(f.updateState).not.toHaveBeenCalled();
  });

  it("holds the send path's thread lock throughout exactly one remote CAS", async () => {
    const f = await fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.updateState.mockImplementationOnce(async () => {
      enter();
      await released;
    });
    const write = owner(f.actor, () => updateConversationEngineState(f.deps, f.actor, f.input));
    await entered;
    try {
      await expect(
        owner(f.actor, () =>
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${f.bot.threadId} FOR UPDATE NOWAIT`;
          }),
        ),
      ).rejects.toThrow();
    } finally {
      release();
    }
    expect((await write).status).toBe("ready");
    expect(f.updateState).toHaveBeenCalledTimes(1);
  });
});
