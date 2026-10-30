import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { isCiphertext } from "./content-crypto.js";
import { contentEncryptionOf, withContentEncryption } from "./content-encryption.js";
import type { SpaceKeyRecord, SpaceKeyStore } from "./content-keys.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";

// No query reaches the database: every case fails before the driver is used.
const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
const unreachable = () => Promise.reject(new Error("unexpected key store access"));
const store: SpaceKeyStore = {
  forSpace: unreachable,
  byId: unreachable,
  insert: unreachable,
  rowContext: unreachable,
  sampleByMasterKey: unreachable,
};
const ring = new ContentKeyRing(new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]), store);
const prisma = withContentEncryption(new PrismaClient({ adapter: new PrismaPg(pool) }), ring);

afterAll(async () => {
  await pool.end();
});

describe("withContentEncryption", () => {
  it("exposes its key ring to raw-SQL readers and nothing to plain clients", () => {
    expect(contentEncryptionOf(prisma)?.ring).toBe(ring);
    expect(contentEncryptionOf({})).toBeUndefined();
  });

  it("rejects nested writes that would bypass encryption", async () => {
    await expect(
      prisma.thread.create({
        data: {
          spaceId: "s",
          userId: "u",
          messages: { create: { seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] } },
        },
      }),
    ).rejects.toThrow(/nested write/);
    await expect(
      prisma.thread.create({
        data: {
          spaceId: "s",
          userId: "u",
          messages: {
            createMany: { data: [{ seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] }] },
          },
        },
      }),
    ).rejects.toThrow(/nested write/);
    await expect(
      prisma.memoryDocument.update({
        where: { id: "doc" },
        data: { revisions: { create: { revision: 2, content: "x" } } },
      }),
    ).rejects.toThrow(/nested write/);
  });

  it("requires encrypted updates to name one row by id", async () => {
    await expect(
      prisma.message.updateMany({ where: { threadId: "t" }, data: { blocks: [] } }),
    ).rejects.toThrow(/updated by id/);
    await expect(
      prisma.memoryDocument.upsert({
        where: { id: "doc" },
        create: { spaceId: "s", userId: "u", scope: "user", path: "p", content: "x" },
        update: { content: "x" },
      }),
    ).rejects.toThrow(/Upserts/);
  });

  it("protects companion turn content and requires its durable row identity", async () => {
    await expect(
      prisma.companionTurn.create({ data: { input: "private" } as never }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      prisma.companionTurn.update({ where: { runId: "run" }, data: { response: "private" } }),
    ).rejects.toThrow(/updated by id/);
  });

  it("requires durable ownership for private engine settings and actions", async () => {
    await expect(
      prisma.bot.updateMany({
        where: { spaceId: "s" },
        data: { conversationEngineSettings: { promptTraits: [{ tag: "private", text: "text" }] } },
      }),
    ).rejects.toThrow(/updated by id/);
    await expect(
      prisma.companionAction.create({ data: { id: "action", request: {} } as never }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      prisma.companionAction.updateMany({
        where: { sessionId: "session" },
        data: { response: {} },
      }),
    ).rejects.toThrow(/updated by id/);
  });

  it("requires creates to name their owner", async () => {
    await expect(
      prisma.memoryRevision.create({ data: { revision: 1, content: "x" } as never }),
    ).rejects.toThrow(/documentId/);
  });
});

describe("withContentEncryption with encryption off", () => {
  // A recorder stands in for the driver, so the test sees exactly what would be written.
  // Query extensions run in the order they were added: encryption first, then this.
  const writes: unknown[] = [];
  const off = new ContentKeyRing(new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]), store, {
    encryptWrites: false,
  });
  const plain = withContentEncryption(
    new PrismaClient({ adapter: new PrismaPg(pool) }),
    off,
  ).$extends({
    query: {
      $allModels: {
        async $allOperations({ args }) {
          const data = (args as { data?: object }).data;
          writes.push(data);
          return { id: "m1", threadId: "t", ...data };
        },
      },
    },
  }) as unknown as PrismaClient;

  it("stores new content as given, without touching keys", async () => {
    writes.length = 0;
    const blocks = [{ kind: "text", text: "plain words" }];
    await plain.message.create({ data: { threadId: "t", seq: 0, role: "user", blocks } });
    await plain.memoryDocument.create({
      data: { spaceId: "s", userId: "u", scope: "user", path: "p", content: "remember this" },
    });
    expect(writes).toEqual([
      { threadId: "t", seq: 0, role: "user", blocks },
      { spaceId: "s", userId: "u", scope: "user", path: "p", content: "remember this" },
    ]);
  });

  it("drops the search tokens of a message rewritten in plaintext", async () => {
    writes.length = 0;
    await plain.message.update({ where: { id: "m1" }, data: { blocks: [] } });
    await plain.message.update({ where: { id: "m1" }, data: { role: "bot" } });
    expect(writes).toEqual([{ blocks: [], searchTokens: { set: [] } }, { role: "bot" }]);
  });

  it("still rejects writes that could not be encrypted once switched back on", async () => {
    await expect(
      plain.thread.create({
        data: {
          spaceId: "s",
          userId: "u",
          messages: { create: { seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] } },
        },
      }),
    ).rejects.toThrow(/nested write/);
  });
});

describe("companion turn encryption", () => {
  it("seals durable input, reply, and errors and binds them to the session", async () => {
    const keys: SpaceKeyRecord[] = [];
    const memory: SpaceKeyStore = {
      forSpace: async (spaceId) => keys.filter((key) => key.spaceId === spaceId),
      byId: async (id) => keys.find((key) => key.id === id),
      insert: async (record) => {
        keys.push(record);
        return record;
      },
      sampleByMasterKey: async () => keys,
      rowContext: async () => ({ spaceId: "space", owner: "session" }),
    };
    let stored: Record<string, unknown> = {};
    const encrypted = withContentEncryption(
      new PrismaClient({ adapter: new PrismaPg(pool) }),
      new ContentKeyRing(new LocalKeyProvider([{ id: "a", key: Buffer.alloc(32, 1) }]), memory),
    ).$extends({
      query: {
        $allModels: {
          async $allOperations({ args }) {
            const data = (args as { data?: Record<string, unknown> }).data;
            if (data) stored = structuredClone(data);
            return { ...stored };
          },
        },
      },
    }) as unknown as PrismaClient;
    const result = await encrypted.companionTurn.create({
      data: {
        id: "turn",
        runId: "run",
        sessionId: "session",
        spaceId: "space",
        userId: "user",
        clientMessageId: "client",
        input: "private input",
        response: "private reply",
        error: "private error",
      },
    });
    for (const field of ["input", "response", "error"] as const)
      expect(isCiphertext(stored[field])).toBe(true);
    expect(result).toMatchObject({
      input: "private input",
      response: "private reply",
      error: "private error",
    });
    stored.sessionId = "foreign-session";
    await expect(encrypted.companionTurn.findUnique({ where: { id: "turn" } })).rejects.toThrow();
  });
});
