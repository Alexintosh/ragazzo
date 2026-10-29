import { randomUUID } from "node:crypto";
import { destroyBot } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createSpaceForMember,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deleteAccountContent,
  fenceAccountConversationEngineDeletion,
} from "./account-deletion.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { deleteSpaceWithContent } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("external conversation deletion preflight (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let companion: Awaited<ReturnType<ReturnType<typeof createRepos>["createBot"]>>;
  let ordinary: typeof companion;
  const address = `engine-deletion-${randomUUID()}`;
  const owner = <T>(work: () => Promise<T>) => runAsTenant(actor, work);
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    const identity = await runAsSystem("engine deletion fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const baseActor: Actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "deletion@example.invalid",
      isDeploymentOwner: false,
    };
    const target = await runAsSystem("engine deletion space fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: baseActor.spaceId,
        userId: baseActor.userId,
        name: "Disposable fixture",
      }),
    );
    actor = { ...baseActor, spaceId: target.id };
    await owner(async () => {
      ordinary = await createRepos(prisma).createBot(actor, {
        name: "Ordinary",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      companion = await createRepos(prisma).createBot(actor, {
        name: "Companion",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        botKind: "roleplay",
        conversationEngine: "eros",
        erosCharacterId: "cc0b7acf-d979-4e48-b027-26b04570ea57",
      });
      await prisma.companionSession.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: companion.id,
          threadId: companion.threadId,
          historyGeneration: 0,
          engineUserId: randomUUID(),
          engineSessionId: randomUUID(),
          engineInstanceId: randomUUID(),
        },
      });
      await createThreadEvents(prisma).sendUserMessage({
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: ordinary.id,
        threadId: ordinary.threadId,
        blocks: [{ kind: "text", text: "Retain this queued task" }],
        prompt: "Retain this queued task",
        trigger: "user",
        clientNonce: randomUUID(),
      });
    });
  });
  afterAll(async () => {
    if (actor) {
      const system = asSystem(prisma, "engine deletion fixture cleanup");
      await system.companionSession.deleteMany({ where: { userId: actor.userId } });
      const membership = await system.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      });
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.delete({ where: { id: membership.organizationId } });
      await system.user.delete({ where: { id: actor.userId } });
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });
  function dependencies() {
    const effect = vi.fn(async () => {
      throw new Error("Destructive teardown reached before Eros preflight");
    });
    const deps = {
      prisma,
      dataDir: "/unused-test-directory",
      sandbox: { destroy: effect, stop: effect, prepare: effect },
      home: { remove: effect, exportHome: effect, importHome: effect },
      jobs: { cancel: effect, enqueue: effect },
      artifacts: { remove: effect },
      messagingInstallations: { removeForBot: effect },
      nativeSetupCleanup: effect,
    } as unknown as SpaceDeletionDeps;
    return { deps, effect };
  }
  const snapshot = () =>
    runAsSystem("engine deletion fixture snapshot", async () => ({
      user: await prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { nativeSetupDisabledAt: true },
      }),
      space: await prisma.space.findUniqueOrThrow({
        where: { id: actor.spaceId },
        select: { deletionClaimId: true, deletingAt: true },
      }),
      bots: await prisma.bot.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { id: "asc" },
        select: { id: true, computerId: true, archivedAt: true },
      }),
      runs: await prisma.run.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { id: "asc" },
        select: { id: true, status: true },
      }),
      computers: await prisma.computer.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { id: "asc" },
        select: { id: true, providerRef: true },
      }),
      sessions: await prisma.companionSession.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { id: "asc" },
        select: { id: true, engineUserId: true, engineSessionId: true },
      }),
    }));

  it.each([true, false])(
    "rejects bot teardown before effects when the caller supplies engine ownership: %s",
    async (includeEngine) => {
      const { deps, effect } = dependencies();
      const before = await snapshot();
      const full = await owner(() => createRepos(prisma).getBot(actor, companion.id));
      const bot = includeEngine
        ? full
        : {
            id: full.id,
            spaceId: full.spaceId,
            userId: full.userId,
            name: full.name,
            archivedAt: full.archivedAt,
            computerId: full.computerId,
            webhookSecretId: full.webhookSecretId,
          };
      await expect(
        owner(() =>
          destroyBot(
            deps,
            bot,
            {
              operationId: "fixture-delete",
              traceId: "fixture-delete",
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: companion.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true, strictTeardown: true },
          ),
        ),
      ).rejects.toThrow("External engine data requires operator cleanup");
      expect(effect).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );

  it("rejects space deletion before native, ordinary bot, sandbox, or file teardown and releases the claim", async () => {
    const { deps, effect } = dependencies();
    const before = await snapshot();
    await expect(
      runAsSystem("engine space deletion test", () =>
        deleteSpaceWithContent(deps, actor, actor.spaceId),
      ),
    ).rejects.toThrow("External engine data requires operator cleanup");
    expect(effect).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects the account admission helper before mutating user state when external data exists", async () => {
    const before = await snapshot();
    await expect(fenceAccountConversationEngineDeletion(prisma, actor.userId)).rejects.toThrow(
      "External engine data requires operator cleanup",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("a successful account admission fence prevents subsequent Eros creation and remains stable on retry", async () => {
    const cleanAddress = `engine-admission-${randomUUID()}`;
    const identity = await runAsSystem("engine admission fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address: cleanAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const cleanActor: Actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "admission@example.invalid",
      isDeploymentOwner: false,
    };
    const system = asSystem(prisma, "engine admission fixture cleanup");
    try {
      const admission = await fenceAccountConversationEngineDeletion(prisma, cleanActor.userId);
      expect(admission.previous).toBeNull();
      expect(admission.fencedAt).toBeInstanceOf(Date);
      const retry = await fenceAccountConversationEngineDeletion(prisma, cleanActor.userId);
      expect(retry).toEqual({ previous: admission.fencedAt, fencedAt: admission.fencedAt });
      await expect(
        runAsTenant(cleanActor, () =>
          createRepos(prisma).createBot(cleanActor, {
            name: "Racing companion",
            title: "",
            description: "",
            instructions: "",
            notifyOnFinish: false,
            botKind: "roleplay",
            conversationEngine: "eros",
            erosCharacterId: "cc0b7acf-d979-4e48-b027-26b04570ea57",
          }),
        ),
      ).rejects.toThrow("Resource not found");
      expect(
        await system.bot.count({
          where: { userId: cleanActor.userId, conversationEngine: "eros" },
        }),
      ).toBe(0);
      expect(
        (await system.user.findUniqueOrThrow({ where: { id: cleanActor.userId } }))
          .nativeSetupDisabledAt,
      ).toEqual(admission.fencedAt);
    } finally {
      const membership = await system.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: cleanActor.spaceId, userId: cleanActor.userId } },
      });
      await system.messagingIdentity.deleteMany({
        where: { provider: "sendblue", address: cleanAddress },
      });
      await system.organization.delete({ where: { id: membership.organizationId } });
      await system.user.delete({ where: { id: cleanActor.userId } });
    }
  });

  it("rejects account deletion before native admission fencing, space claims, or unrelated content teardown", async () => {
    const { deps, effect } = dependencies();
    const before = await snapshot();
    await expect(
      runAsSystem("engine account deletion test", () => deleteAccountContent(deps, actor.userId)),
    ).rejects.toThrow("External engine data requires operator cleanup");
    expect(effect).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
});
