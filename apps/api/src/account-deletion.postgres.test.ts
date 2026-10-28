import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  JobPublisher,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  checkpointAndRecordComputerWorkspace,
  ObjectAgentHomeStore,
  PrismaAgentHomeRecords,
  teamBrowserProfileName,
} from "@rakazo/adapters";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  asSystem,
  ContentKeyRing,
  claimSpacesLeavingWithAccount,
  computerHomeKey,
  computerScopeKey,
  createDb,
  deleteSpaceLeavingWithAccount,
  LocalKeyProvider,
  legacyTeamHomeKey,
  lockSpaceForContentCreation,
  runAsSystem,
  runAsTenant,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.ts";
import { deleteAccountContent } from "./account-deletion.js";
import { assertNativeSetupAdmission } from "./native-setup-admission.js";
import { nativeSetupOwners } from "./native-setup-owners.js";
import { deleteSpaceWithContent } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("account deletion on bot computers (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let suffix: string;
  let root: string;
  let storage: MemoryObjectStorage;
  let records: PrismaAgentHomeRecords;
  let home: ObjectAgentHomeStore;
  let sandbox: ReturnType<typeof fakeSandbox>;
  let ids: ReturnType<typeof fixtureIds>;

  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "test",
    userId: "test",
    signal: new AbortController().signal,
  };
  const deleteAccount = (
    userId: string,
    nativeSetupCleanup?: (owners: Array<{ spaceId: string; userId: string }>) => Promise<void>,
  ) =>
    runAsSystem("account deletion test", () =>
      deleteAccountContent(
        {
          prisma,
          sandbox: sandbox as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
          dataDir: root,
          nativeSetupCleanup,
        },
        userId,
      ),
    );
  /** Another API or worker host: same bucket and database, its own empty cache. */
  const freshHost = async () =>
    new ObjectAgentHomeStore(
      await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-host-")),
      storage,
      records,
    );
  const storedFiles = async (homeKey: string) => {
    const files: string[] = [];
    for await (const file of (await freshHost()).exportHome(homeKey, context))
      files.push(file.path);
    return files.sort();
  };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    ids = fixtureIds(suffix);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-"));
    storage = new MemoryObjectStorage();
    records = new PrismaAgentHomeRecords(system, memoryRing());
    home = new ObjectAgentHomeStore(root, storage, records);
    sandbox = fakeSandbox();
    await seed();
    return async () => {
      await system.organization.deleteMany({
        where: { id: { in: [ids.personalOrg, ids.sharedOrg] } },
      });
      await system.user.deleteMany({ where: { id: { in: [ids.leaver, ids.stayer] } } });
      await rm(root, { recursive: true, force: true });
    };
  });

  /**
   * The leaver has a personal organization (space with a Team Computer and a bot with its own
   * computer) and shares an organization with the stayer: a space both use, and a space only
   * the leaver uses. In the shared space the stayer owns the Team Computer from before each
   * person got their own, which still holds the leaver's bot folder and browser profile.
   */
  async function seed() {
    const now = new Date();
    await system.user.createMany({
      data: [ids.leaver, ids.stayer].map((id) => ({
        id,
        name: id,
        email: `${id}@rakazo.test`,
        emailVerified: false,
      })),
    });
    await system.organization.createMany({
      data: [ids.personalOrg, ids.sharedOrg].map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: now,
      })),
    });
    await system.space.createMany({
      data: [
        { id: ids.personalSpace, organizationId: ids.personalOrg, name: "Mine", isDefault: true },
        { id: ids.sharedSpace, organizationId: ids.sharedOrg, name: "Ours", isDefault: true },
        { id: ids.soloSpace, organizationId: ids.sharedOrg, name: "Only mine" },
      ],
    });
    // Members join each organization's default space by trigger.
    await system.member.createMany({
      data: [
        { org: ids.personalOrg, user: ids.leaver },
        { org: ids.sharedOrg, user: ids.leaver },
        { org: ids.sharedOrg, user: ids.stayer },
      ].map(({ org, user }) => ({
        id: `${org}-${user}`,
        organizationId: org,
        userId: user,
        role: "owner",
        createdAt: now,
      })),
    });
    await system.spaceMember.create({
      data: {
        id: `${ids.soloSpace}-member`,
        spaceId: ids.soloSpace,
        organizationId: ids.sharedOrg,
        userId: ids.leaver,
        role: "owner",
        createdAt: now,
      },
    });

    const team = (spaceId: string, userId: string, providerRef: string, state = "stopped") => ({
      id: `${providerRef}-row`,
      spaceId,
      userId,
      scope: "team",
      scopeKey: computerScopeKey({ mode: "team", spaceId, userId }),
      homeKey: computerHomeKey({ mode: "team", spaceId, userId }),
      kind: "e2b",
      providerRef,
      state,
    });
    await system.computer.createMany({
      data: [
        team(ids.personalSpace, ids.leaver, `sb-personal-${suffix}`),
        team(ids.soloSpace, ids.leaver, `sb-solo-${suffix}`),
        team(ids.sharedSpace, ids.leaver, `sb-own-${suffix}`, "running"),
        {
          ...team(ids.sharedSpace, ids.stayer, `sb-legacy-${suffix}`),
          homeKey: legacyTeamHomeKey(ids.sharedSpace),
        },
        {
          id: `sb-dedicated-${suffix}-row`,
          spaceId: ids.personalSpace,
          userId: ids.leaver,
          scope: "dedicated",
          scopeKey: `bot:${ids.dedicatedBot}`,
          homeKey: ids.dedicatedBot,
          kind: "e2b",
          providerRef: `sb-dedicated-${suffix}`,
        },
      ],
    });
    const bot = (id: string, spaceId: string, userId: string, computerId: string) => ({
      id,
      spaceId,
      userId,
      name: id,
      color: "blue",
      computerId,
    });
    await system.bot.createMany({
      data: [
        bot(ids.personalBot, ids.personalSpace, ids.leaver, `sb-personal-${suffix}-row`),
        bot(ids.dedicatedBot, ids.personalSpace, ids.leaver, `sb-dedicated-${suffix}-row`),
        bot(ids.soloBot, ids.soloSpace, ids.leaver, `sb-solo-${suffix}-row`),
        bot(ids.leaverBot, ids.sharedSpace, ids.leaver, `sb-own-${suffix}-row`),
        bot(ids.stayerBot, ids.sharedSpace, ids.stayer, `sb-legacy-${suffix}-row`),
      ],
    });

    for (const [homeKey, files] of [
      [computerHomeKey({ mode: "team", spaceId: ids.personalSpace, userId: ids.leaver }), ["a"]],
      [computerHomeKey({ mode: "team", spaceId: ids.soloSpace, userId: ids.leaver }), ["a"]],
      [ids.dedicatedBot, ["a"]],
      [
        computerHomeKey({ mode: "team", spaceId: ids.sharedSpace, userId: ids.leaver }),
        [`bots/${ids.leaverBot}/notes.txt`, "shared/mine.txt"],
      ],
      [
        legacyTeamHomeKey(ids.sharedSpace),
        [
          `bots/${ids.leaverBot}/old.txt`,
          `.browser-profiles/${teamBrowserProfileName(ids.leaverBot)}/Cookies`,
          `bots/${ids.stayerBot}/work.txt`,
          `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
          "shared/plan.txt",
        ],
      ],
    ] as const) {
      await home.commit(homeKey, await staged(files), context);
    }
  }

  it("retains account content when scoped native setup cleanup is uncertain", async () => {
    const cleanup = vi.fn(async (_owners: Array<{ spaceId: string; userId: string }>) => {
      await expect(
        prisma.$transaction((tx) =>
          assertNativeSetupAdmission(tx, { spaceId: ids.sharedSpace, userId: ids.leaver }),
        ),
      ).rejects.toThrow();
      await prisma.$transaction((tx) =>
        assertNativeSetupAdmission(tx, { spaceId: ids.sharedSpace, userId: ids.stayer }),
      );
      throw new Error("setup cleanup uncertain");
    });
    await expect(deleteAccount(ids.leaver, cleanup)).rejects.toThrow("setup cleanup uncertain");
    expect(cleanup).toHaveBeenCalledWith(
      expect.arrayContaining([
        { spaceId: ids.personalSpace, userId: ids.leaver },
        { spaceId: ids.sharedSpace, userId: ids.leaver },
        { spaceId: ids.soloSpace, userId: ids.leaver },
      ]),
    );
    expect(cleanup.mock.calls[0]![0]).toHaveLength(3);
    expect(sandbox.destroyed).toEqual([]);
    expect(await system.bot.count({ where: { userId: ids.leaver } })).toBe(4);
  });

  it("claims the Space before setup cleanup and retains its bots on uncertain acknowledgement", async () => {
    await system.space.update({
      where: { id: ids.soloSpace },
      data: { createdByUserId: ids.leaver },
    });
    const cleanup = vi.fn(async (owners: Array<{ spaceId: string; userId: string }>) => {
      expect(owners).toEqual([{ spaceId: ids.soloSpace, userId: ids.leaver }]);
      expect(
        (await system.space.findUniqueOrThrow({ where: { id: ids.soloSpace } })).deletionClaimId,
      ).not.toBeNull();
      await expect(
        prisma.$transaction((tx) =>
          assertNativeSetupAdmission(tx, { spaceId: ids.soloSpace, userId: ids.leaver }),
        ),
      ).rejects.toThrow(SpaceDeletionInProgressError);
      throw new Error("setup cleanup uncertain");
    });
    await expect(
      runAsSystem("Space setup deletion test", () =>
        deleteSpaceWithContent(
          {
            prisma,
            sandbox: sandbox as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
            artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
            dataDir: root,
            nativeSetupCleanup: cleanup,
          },
          { spaceId: ids.sharedSpace, userId: ids.leaver },
          ids.soloSpace,
        ),
      ),
    ).rejects.toThrow("setup cleanup uncertain");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sandbox.destroyed).toEqual([]);
    expect(await system.bot.findUnique({ where: { id: ids.soloBot } })).not.toBeNull();
  });

  it("includes registered and local-only setup after their owners leave membership", async () => {
    await system.space.update({
      where: { id: ids.soloSpace },
      data: { createdByUserId: ids.leaver },
    });
    await system.spaceMember.create({
      data: {
        id: `${ids.soloSpace}-departed`,
        spaceId: ids.soloSpace,
        organizationId: ids.sharedOrg,
        userId: ids.stayer,
        role: "member",
        createdAt: new Date(),
      },
    });
    // No bot, computer or membership is required to retain a local setup owner.
    await system.nativeSetupOwner.create({
      data: { spaceId: ids.soloSpace, userId: ids.stayer },
    });
    await system.spaceMember.delete({ where: { id: `${ids.soloSpace}-departed` } });
    expect(await nativeSetupOwners(system, { spaceId: ids.soloSpace })).toContainEqual({
      spaceId: ids.soloSpace,
      userId: ids.stayer,
    });
    expect(
      await runAsTenant({ spaceId: ids.soloSpace, userId: ids.leaver }, () =>
        prisma.nativeSetupOwner.findMany({ where: { spaceId: ids.soloSpace } }),
      ),
    ).toEqual([]);
    await expect(
      runAsTenant({ spaceId: ids.soloSpace, userId: ids.leaver }, () =>
        prisma.nativeSetupOwner.upsert({
          where: { spaceId_userId: { spaceId: ids.soloSpace, userId: ids.stayer } },
          create: { spaceId: ids.soloSpace, userId: ids.stayer },
          update: {},
        }),
      ),
    ).rejects.toThrow();
    await system.registeredHost.create({
      data: {
        id: `departed-host-${suffix}`,
        spaceId: ids.soloSpace,
        userId: ids.stayer,
        name: "Departed host",
        endpoint: "https://host.example.test",
        ciphertext: "fake-ciphertext",
      },
    });
    const cleanup = vi.fn(async () => {
      throw new Error("cleanup uncertain");
    });
    await expect(
      runAsSystem("former-owner Space cleanup test", () =>
        deleteSpaceWithContent(
          {
            prisma,
            sandbox: sandbox as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
            artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
            dataDir: root,
            nativeSetupCleanup: cleanup,
          },
          { spaceId: ids.sharedSpace, userId: ids.leaver },
          ids.soloSpace,
        ),
      ),
    ).rejects.toThrow("cleanup uncertain");
    expect(cleanup).toHaveBeenCalledWith([
      { spaceId: ids.soloSpace, userId: ids.leaver },
      { spaceId: ids.soloSpace, userId: ids.stayer },
    ]);
    // A registered former owner remains discoverable even without a durable local record.
    await system.nativeSetupOwner.deleteMany({ where: { userId: ids.stayer } });
    expect(await nativeSetupOwners(system, { spaceId: ids.soloSpace })).toContainEqual({
      spaceId: ids.soloSpace,
      userId: ids.stayer,
    });
  });

  it("cleans departed account owners without membership and former owners only before actual Space deletion", async () => {
    await system.spaceMember.deleteMany({
      where: { spaceId: ids.sharedSpace, userId: ids.leaver },
    });
    await system.nativeSetupOwner.createMany({
      data: [
        { spaceId: ids.sharedSpace, userId: ids.leaver },
        { spaceId: ids.soloSpace, userId: ids.stayer },
      ],
    });
    const cleanup = vi.fn(async (owners: Array<{ spaceId: string; userId: string }>) => {
      if (owners.some((owner) => owner.userId === ids.stayer))
        throw new Error("former-owner cleanup uncertain");
    });
    await expect(deleteAccount(ids.leaver, cleanup)).rejects.toThrow(
      "former-owner cleanup uncertain",
    );
    expect(cleanup.mock.calls[0]![0]).toContainEqual({
      spaceId: ids.sharedSpace,
      userId: ids.leaver,
    });
    expect(cleanup.mock.calls[0]![0].every((owner) => owner.userId === ids.leaver)).toBe(true);
    expect(cleanup).toHaveBeenLastCalledWith([{ spaceId: ids.soloSpace, userId: ids.stayer }]);
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).not.toBeNull();
    expect(await system.nativeSetupOwner.count({ where: { spaceId: ids.soloSpace } })).toBe(1);
    cleanup.mockImplementation(async () => {});
    await deleteAccount(ids.leaver, cleanup);
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toBeNull();
    expect(await system.nativeSetupOwner.count({ where: { spaceId: ids.soloSpace } })).toBe(0);
  });

  it("keeps the final cleanup decision after a former owner's revocation loses its acknowledgement", async () => {
    await system.nativeSetupOwner.create({
      data: { spaceId: ids.soloSpace, userId: ids.stayer },
    });
    let loseAcknowledgement = true;
    const tombstone = path.join(root, "former-owner-setup-revoked");
    const cleanup = vi.fn(async (owners: Array<{ spaceId: string; userId: string }>) => {
      if (!owners.some((owner) => owner.userId === ids.stayer)) return;
      // A host's persistent revocation survives the API transaction/request failing.
      await writeFile(tombstone, "revoked");
      expect(
        (await system.space.findUniqueOrThrow({ where: { id: ids.soloSpace } }))
          .deletionCleanupStartedAt,
      ).toBeInstanceOf(Date);
      if (loseAcknowledgement) throw new Error("revocation acknowledgement lost");
    });

    await expect(deleteAccount(ids.leaver, cleanup)).rejects.toThrow(
      "revocation acknowledgement lost",
    );
    expect(await readdir(root)).toContain("former-owner-setup-revoked");
    const decision = await system.space.findUniqueOrThrow({ where: { id: ids.soloSpace } });
    expect(decision.deletionClaimId).toBe(`account-deletion:${ids.leaver}`);
    expect(decision.deletionCleanupStartedAt).toBeInstanceOf(Date);

    // Direct writes model older APIs that have no application-level admission check.
    await expect(
      system.spaceMember.create({
        data: {
          id: `${ids.soloSpace}-late-join`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow("Space deletion cleanup has started");
    await expect(
      system.$executeRaw`
        UPDATE space_members SET "userId" = ${ids.stayer}
        WHERE "spaceId" = ${ids.soloSpace} AND "userId" = ${ids.leaver}
      `,
    ).rejects.toThrow("Space deletion cleanup has started");
    await expect(
      system.$executeRaw`
        UPDATE space_members SET "spaceId" = ${ids.soloSpace}
        WHERE "spaceId" = ${ids.sharedSpace} AND "userId" = ${ids.stayer}
      `,
    ).rejects.toThrow("Space deletion cleanup has started");
    await expect(
      system.space.update({
        where: { id: ids.soloSpace },
        data: { deletingAt: null, deletionClaimId: null },
      }),
    ).rejects.toThrow("Space cleanup decision cannot be reversed");
    await expect(
      system.space.update({
        where: { id: ids.soloSpace },
        data: { deletionCleanupStartedAt: null },
      }),
    ).rejects.toThrow("Space cleanup decision cannot be reversed");
    await expect(
      system.space.update({
        where: { id: ids.soloSpace },
        data: { deletionClaimId: "another-deletion" },
      }),
    ).rejects.toThrow("Space cleanup decision cannot be reversed");

    loseAcknowledgement = false;
    await deleteAccount(ids.leaver, cleanup);
    expect(cleanup).toHaveBeenLastCalledWith([{ spaceId: ids.soloSpace, userId: ids.stayer }]);
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toBeNull();
    expect(await system.nativeSetupOwner.count({ where: { spaceId: ids.soloSpace } })).toBe(0);
    expect(await readdir(root)).toContain("former-owner-setup-revoked");
    expect(await system.space.findUnique({ where: { id: ids.sharedSpace } })).not.toBeNull();
  });

  it("serializes the cleanup marker with an uncommitted membership and retains the committed join", async () => {
    await runAsSystem("concurrent account claim test", () =>
      claimSpacesLeavingWithAccount(prisma, ids.leaver),
    );
    await system.bot.deleteMany({ where: { spaceId: ids.soloSpace } });
    await system.computer.deleteMany({ where: { spaceId: ids.soloSpace } });
    await system.$transaction(async (joining) => {
      await joining.spaceMember.create({
        data: {
          id: `${ids.soloSpace}-joining`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      });
      // The FK's KEY SHARE alone would allow this non-key update. Admission's
      // SHARE lock keeps the cleanup decision behind the membership commit.
      await expect(
        system.$transaction(async (deciding) => {
          await deciding.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
          await deciding.space.update({
            where: { id: ids.soloSpace },
            data: { deletionCleanupStartedAt: new Date() },
          });
        }),
      ).rejects.toThrow("lock timeout");
    });
    const cleanup = vi.fn(async () => {});
    expect(
      await runAsSystem("retain committed pre-cleanup join test", () =>
        deleteSpaceLeavingWithAccount(
          prisma,
          { spaceId: ids.soloSpace, userId: ids.leaver },
          cleanup,
        ),
      ),
    ).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletingAt: null,
      deletionClaimId: null,
      deletionCleanupStartedAt: null,
    });
  });

  it("commits membership admission closure before the setup cleanup callback", async () => {
    await runAsSystem("account claim test", () =>
      claimSpacesLeavingWithAccount(prisma, ids.leaver),
    );
    await system.bot.deleteMany({ where: { spaceId: ids.soloSpace } });
    await system.computer.deleteMany({ where: { spaceId: ids.soloSpace } });
    let join: Promise<unknown> | undefined;
    await runAsSystem("locked setup teardown test", () =>
      deleteSpaceLeavingWithAccount(
        prisma,
        { spaceId: ids.soloSpace, userId: ids.leaver },
        async () => {
          // Another connection sees the committed fence while external cleanup runs.
          join = system.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
            await tx.spaceMember.create({
              data: {
                id: `${ids.soloSpace}-concurrent-join`,
                spaceId: ids.soloSpace,
                organizationId: ids.sharedOrg,
                userId: ids.stayer,
                role: "member",
                createdAt: new Date(),
              },
            });
          });
          await expect(join).rejects.toThrow("Space deletion cleanup has started");
        },
      ),
    );
    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toBeNull();
  });

  it("deletes every computer of the account and its own spaces, and only its folders elsewhere", async () => {
    const legacyKey = legacyTeamHomeKey(ids.sharedSpace);
    const legacyStorage = (
      await system.computer.findUniqueOrThrow({ where: { homeKey: legacyKey } })
    ).homeStorageId;

    await deleteAccount(ids.leaver);

    expect(sandbox.destroyed.sort()).toEqual(
      [
        `sb-dedicated-${suffix}`,
        `sb-own-${suffix}`,
        `sb-personal-${suffix}`,
        `sb-solo-${suffix}`,
      ].sort(),
    );
    expect(
      await system.computer.findMany({
        where: { OR: [{ userId: ids.leaver }, { spaceId: { in: [ids.personalSpace] } }] },
      }),
    ).toEqual([]);
    expect(
      (await system.space.findMany({ where: { id: { in: ids.spaces } } })).map(({ id }) => id),
    ).toEqual([ids.sharedSpace]);
    expect(
      (await system.bot.findMany({ where: { id: { in: ids.bots } } })).map(({ id }) => id),
    ).toEqual([ids.stayerBot]);

    // The stayer's computer keeps its own work, on any host, and loses the leaver's.
    expect(await storedFiles(legacyKey)).toEqual(
      [
        `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
        `bots/${ids.stayerBot}/work.txt`,
        "shared/plan.txt",
      ].sort(),
    );
    expect(sandbox.destroyed).not.toContain(`sb-legacy-${suffix}`);

    // Nothing of the leaver's homes is left on this host, and the sweep empties the bucket of
    // them: only the stayer's home is still stored.
    expect(await readdir(path.join(root, "homes"))).toEqual([legacyKey]);
    await home.sweep();
    expect(new Set([...storage.objects.keys()].map((key) => key.split("/")[1]))).toEqual(
      new Set([legacyStorage]),
    );
  });

  it("finishes on a retry after a provider fails, and a third run changes nothing", async () => {
    sandbox.failDestroy.add(`sb-dedicated-${suffix}`);
    await expect(deleteAccount(ids.leaver)).rejects.toThrow("provider unavailable");
    // A computer the provider could not confirm gone keeps its handle (and a dedicated one its
    // bot), so the retry can destroy it.
    expect(
      await system.computer.findUnique({ where: { id: `sb-dedicated-${suffix}-row` } }),
    ).toMatchObject({ providerRef: `sb-dedicated-${suffix}` });
    expect(await system.bot.findUnique({ where: { id: ids.dedicatedBot } })).not.toBeNull();

    sandbox.failDestroy.clear();
    await deleteAccount(ids.leaver);
    await deleteAccount(ids.leaver);

    expect(await system.computer.findMany({ where: { userId: ids.leaver } })).toEqual([]);
    expect(await system.bot.findMany({ where: { userId: ids.leaver } })).toEqual([]);
    expect(await system.bot.findUnique({ where: { id: ids.stayerBot } })).not.toBeNull();
    expect(await storedFiles(legacyTeamHomeKey(ids.sharedSpace))).toContain(
      `bots/${ids.stayerBot}/work.txt`,
    );
  });

  it("does not let a running computer's later save bring the deleted bot's folder back", async () => {
    await deleteAccount(ids.leaver);
    const legacy = await system.computer.findUniqueOrThrow({
      where: { homeKey: legacyTeamHomeKey(ids.sharedSpace) },
    });
    const stale = fakeSandbox([
      `bots/${ids.leaverBot}/old.txt`,
      `.browser-profiles/${teamBrowserProfileName(ids.leaverBot)}/Cookies`,
      `bots/${ids.stayerBot}/work.txt`,
      "shared/plan.txt",
    ]);

    await runAsSystem("account deletion test", () =>
      checkpointAndRecordComputerWorkspace(
        { prisma, sandbox: stale as unknown as SandboxProvider, home },
        legacy,
        { id: "sb", botId: legacy.homeKey, kind: "e2b", providerRef: "sb" },
        context,
      ),
    );

    expect(await storedFiles(legacy.homeKey)).toEqual(
      [`bots/${ids.stayerBot}/work.txt`, "shared/plan.txt"].sort(),
    );
  });

  it("keeps a space someone else joined while the account was being deleted", async () => {
    // The stayer joins after deletion has decided the space was the leaver's alone.
    sandbox.beforeDestroy = async (providerRef) => {
      if (providerRef !== `sb-solo-${suffix}`) return;
      await system.spaceMember.create({
        data: {
          id: `${ids.soloSpace}-joined`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      });
      // Until the deletion settles, the new member cannot add content it would tear down.
      await expect(
        prisma.$transaction((tx) =>
          lockSpaceForContentCreation(tx, { spaceId: ids.soloSpace, userId: ids.stayer }),
        ),
      ).rejects.toThrow(SpaceDeletionInProgressError);
    };

    await deleteAccount(ids.leaver);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletingAt: null,
      deletionClaimId: null,
    });
    expect(
      await system.spaceMember.findUnique({ where: { id: `${ids.soloSpace}-joined` } }),
    ).not.toBeNull();
    // The leaver's bot and computer there still go.
    expect(await system.bot.findUnique({ where: { id: ids.soloBot } })).toBeNull();
    expect(sandbox.destroyed).toContain(`sb-solo-${suffix}`);
  });

  it("releases its claim on a space someone joined before a failed attempt", async () => {
    const cleanup = vi.fn(async (_owners: Array<{ spaceId: string; userId: string }>) => {});
    sandbox.failDestroy.add(`sb-dedicated-${suffix}`);
    sandbox.beforeDestroy = async (providerRef) => {
      if (providerRef !== `sb-dedicated-${suffix}`) return;
      await system.spaceMember.upsert({
        where: { id: `${ids.soloSpace}-joined` },
        update: {},
        create: {
          id: `${ids.soloSpace}-joined`,
          spaceId: ids.soloSpace,
          organizationId: ids.sharedOrg,
          userId: ids.stayer,
          role: "member",
          createdAt: new Date(),
        },
      });
    };
    await expect(deleteAccount(ids.leaver, cleanup)).rejects.toThrow("provider unavailable");
    sandbox.failDestroy.clear();

    await system.nativeSetupOwner.create({ data: { spaceId: ids.soloSpace, userId: ids.stayer } });
    await deleteAccount(ids.leaver, cleanup);
    expect(
      cleanup.mock.calls
        .flatMap(([owners]) => owners)
        .every((owner) => owner.userId === ids.leaver),
    ).toBe(true);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toMatchObject({
      deletingAt: null,
      deletionClaimId: null,
    });
  });

  it("waits for another deletion of a leaving space, and takes over once it is stale", async () => {
    await system.space.update({
      where: { id: ids.soloSpace },
      data: { deletingAt: new Date(), deletionClaimId: "another-deletion" },
    });
    await expect(deleteAccount(ids.leaver)).rejects.toThrow(SpaceDeletionInProgressError);

    await system.space.update({
      where: { id: ids.soloSpace },
      data: { deletingAt: new Date(Date.now() - 60 * 60_000) },
    });
    await deleteAccount(ids.leaver);

    expect(await system.space.findUnique({ where: { id: ids.soloSpace } })).toBeNull();
  });

  it("fails and retries when the other member's stored home cannot be saved", async () => {
    const legacyKey = legacyTeamHomeKey(ids.sharedSpace);
    const put = storage.put.bind(storage);
    storage.put = async () => {
      throw new Error("bucket unavailable");
    };
    await expect(deleteAccount(ids.leaver)).rejects.toThrow("bucket unavailable");
    storage.put = put;
    expect(await storedFiles(legacyKey)).toContain(`bots/${ids.leaverBot}/old.txt`);

    await deleteAccount(ids.leaver);

    expect(await storedFiles(legacyKey)).toEqual(
      [
        `.browser-profiles/${teamBrowserProfileName(ids.stayerBot)}/Cookies`,
        `bots/${ids.stayerBot}/work.txt`,
        "shared/plan.txt",
      ].sort(),
    );
  });
});

function fixtureIds(suffix: string) {
  const ids = {
    leaver: `acct-del-leaver-${suffix}`,
    stayer: `acct-del-stayer-${suffix}`,
    personalOrg: `acct-del-personal-${suffix}`,
    sharedOrg: `acct-del-shared-${suffix}`,
    personalSpace: `acct-del-personal-space-${suffix}`,
    sharedSpace: `acct-del-shared-space-${suffix}`,
    soloSpace: `acct-del-solo-space-${suffix}`,
    personalBot: `acctdelpersonal${suffix.replace(/[^a-z0-9]/g, "")}`,
    dedicatedBot: `acctdeldedicated${suffix.replace(/[^a-z0-9]/g, "")}`,
    soloBot: `acctdelsolo${suffix.replace(/[^a-z0-9]/g, "")}`,
    leaverBot: `acctdelleaver${suffix.replace(/[^a-z0-9]/g, "")}`,
    stayerBot: `acctdelstayer${suffix.replace(/[^a-z0-9]/g, "")}`,
  };
  return {
    ...ids,
    spaces: [ids.personalSpace, ids.sharedSpace, ids.soloSpace],
    bots: [ids.personalBot, ids.dedicatedBot, ids.soloBot, ids.leaverBot, ids.stayerBot],
  };
}

/** A provider that records destroys and runs folder commands as a no-op. */
function fakeSandbox(exportedPaths: string[] = []) {
  const destroyed: string[] = [];
  const failDestroy = new Set<string>();
  return {
    destroyed,
    failDestroy,
    beforeDestroy: undefined as ((providerRef: string) => Promise<void>) | undefined,
    async destroy(computer: ComputerRef) {
      await this.beforeDestroy?.(computer.providerRef);
      if (failDestroy.has(computer.providerRef)) throw new Error("provider unavailable");
      destroyed.push(computer.providerRef);
    },
    async releaseScreen() {},
    async *execute() {
      yield { type: "exit" as const, code: 0 };
    },
    async *exportWorkspace(): AsyncGenerator<PortableFile> {
      for (const filePath of exportedPaths)
        yield { path: filePath, content: Buffer.from(filePath), executable: false };
    },
  };
}

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}

async function staged(files: readonly string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-account-delete-staging-"));
  for (const name of files) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), name);
  }
  return dir;
}
