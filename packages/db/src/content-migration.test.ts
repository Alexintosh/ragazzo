import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import type { ContentKeyRing } from "./content-keys.js";
import type { ContentMigrationMode } from "./content-migration.js";
import { migrateContent, rewrapSpaceKeys, rotateSpaceDataKeys } from "./content-migration.js";

const fixture = "fixture-space";
const sentinel = "unrelated-space";
const scope = { spaceIds: [fixture] };

// A recording driver only: no pool, connection string, or database is used.
function migrationClient(lockMatches = true) {
  const mutations: string[] = [];
  const scans: Prisma.Sql[] = [];
  const locks: Prisma.Sql[] = [];
  const ring = { remember: vi.fn() };
  const delegate = {
    findMany: vi.fn(async ({ where, select }) =>
      where.id.in.map((id: string) =>
        Object.fromEntries(Object.keys(select).map((key) => [key, key === "id" ? id : "plain"])),
      ),
    ),
    update: vi.fn(async ({ where }) => mutations.push(where.id)),
  };
  const tx = {
    ...Object.fromEntries(
      [
        "bot",
        "thread",
        "message",
        "event",
        "memoryDocument",
        "memoryRevision",
        "companionTurn",
      ].map((name) => [name, delegate]),
    ),
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      locks.push(sql);
      expect(sql.values).toContain(fixture);
      expect(sql.sql).toMatch(/AND .* IN \(/);
      if (sql.sql.includes('FROM "messages"'))
        expect(sql.sql).toContain('FROM threads WHERE id = messages."threadId"');
      if (sql.sql.includes('FROM "memory_revisions"'))
        expect(sql.sql).toContain('FROM memory_documents WHERE id = memory_revisions."documentId"');
      return lockMatches ? [{ id: fixture }] : [];
    }),
    $executeRaw: vi.fn(async (sql: Prisma.Sql) => mutations.push(String(sql.values.at(-1)))),
  };
  const prisma = {
    $contentEncryption: () => ({ ring }),
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      scans.push(sql);
      if (sql.sql.includes("AND FALSE")) return [];
      const column = sql.sql.includes("FROM messages m")
        ? 't."spaceId"'
        : sql.sql.includes("FROM memory_revisions r")
          ? 'd."spaceId"'
          : '"spaceId"';
      // Missing either the bound scope or its ownership predicate exposes the sentinel.
      const scoped = sql.values.includes(fixture) && sql.sql.includes(`AND ${column} IN (`);
      return (scoped ? [fixture] : [fixture, sentinel]).map((spaceId) => ({
        id: spaceId,
        spaceId,
        owner: "owner",
        value: "plain",
        tokens: true,
      }));
    }),
    $transaction: vi.fn(async (work) => work(tx)),
  } as unknown as PrismaClient;
  return { prisma, mutations, scans, locks, ring };
}

describe("content migration space isolation (offline)", () => {
  it.each<ContentMigrationMode>(["encrypt", "reencrypt", "decrypt"])(
    "%s never scans or rewrites the unrelated sentinel",
    async (mode) => {
      const { prisma, mutations, scans, locks, ring } = migrationClient();
      await migrateContent(prisma, { ...scope, mode });
      expect(scans).toHaveLength(10);
      expect(locks).toHaveLength(10);
      expect(mutations).toEqual(Array(10).fill(fixture));
      expect(ring.remember.mock.calls.every((call) => call[1] === fixture)).toBe(true);
    },
  );

  it("rechecks ownership while locking and skips rows that left the scope", async () => {
    const { prisma, mutations } = migrationClient(false);
    await migrateContent(prisma, { ...scope, mode: "encrypt" });
    expect(mutations).toEqual([]);
  });

  it("an explicitly empty migration scope matches no rows", async () => {
    const { prisma, mutations, locks, ring } = migrationClient();
    const progress = await migrateContent(prisma, { mode: "encrypt", spaceIds: [] });
    expect(progress.every((table) => table.scanned === 0 && table.updated === 0)).toBe(true);
    expect(mutations).toEqual([]);
    expect(locks).toEqual([]);
    expect(ring.remember).not.toHaveBeenCalled();
  });

  it.each([[fixture], []])("restricts rewrapping and rotation to scope %j", async (...spaceIds) => {
    const selected = spaceIds as string[];
    const keys = [fixture, sentinel].map((spaceId) => ({
      id: spaceId,
      spaceId,
      version: 1,
      masterKeyId: "old",
      wrappedKey: "wrapped",
    }));
    const provider = {
      activeKeyId: () => "new",
      unwrap: vi.fn(async () => Buffer.from("data key")),
      wrap: vi.fn(async () => ({ masterKeyId: "new", wrappedKey: "rewrapped" })),
    };
    const ring = { provider, rotate: vi.fn() };
    const prisma = {
      spaceKey: {
        findMany: vi.fn(async ({ where }) =>
          keys.filter((key) => key.id > where.id.gt && where.spaceId.in.includes(key.spaceId)),
        ),
        updateMany: vi.fn(),
      },
      space: {
        findMany: vi.fn(async ({ where }) =>
          keys.filter((key) => key.id > where.id.gt && where.id.in.includes(key.id)),
        ),
      },
    };
    await rewrapSpaceKeys(prisma as unknown as PrismaClient, ring as unknown as ContentKeyRing, {
      spaceIds: selected,
    });
    await rotateSpaceDataKeys(
      prisma as unknown as PrismaClient,
      ring as unknown as ContentKeyRing,
      {
        spaceIds: selected,
      },
    );
    expect(ring.rotate.mock.calls.map(([id]) => id)).toEqual(selected);
    expect(prisma.spaceKey.updateMany.mock.calls).toHaveLength(selected.length);
    if (selected.length) {
      expect(prisma.spaceKey.updateMany).toHaveBeenCalledWith({
        where: { id: fixture, spaceId: fixture, masterKeyId: "old", wrappedKey: "wrapped" },
        data: { masterKeyId: "new", wrappedKey: "rewrapped" },
      });
      expect(provider.unwrap.mock.calls).toHaveLength(2);
    } else expect(provider.unwrap).not.toHaveBeenCalled();
  });
});
