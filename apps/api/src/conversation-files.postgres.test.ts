import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  IsolationError,
  resolveNextArtifactVersion,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listConversationFiles } from "./conversation-files.js";
import type { ThreadTarget } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("conversation files tenant boundaries (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `files-user-${suffix}`;
  const otherUserId = `files-other-${suffix}`;
  const organizationId = `files-org-${suffix}`;
  const spaceId = `files-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let target: ThreadTarget;
  let rootId: string;
  let versionId: string;
  let messageId: string;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.createMany({
      data: [userId, otherUserId].map((id) => ({
        id,
        name: "File owner",
        email: `${id}@rakazo.test`,
        emailVerified: false,
      })),
    });
    await system.organization.create({
      data: { id: organizationId, name: "Files", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Files", isDefault: true },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Files", color: "blue" },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    target = { kind: "bot", botId: bot.id, threadId: thread.id } as ThreadTarget;
    const common = {
      spaceId,
      userId,
      botId: bot.id,
      name: "result.txt",
      mimeType: "text/plain",
      size: 5,
      hash: "test-hash",
      storageKey: "test-blob",
    };
    const root = await system.artifact.create({ data: common });
    rootId = root.id;
    const version = await system.artifact.create({
      data: { ...common, rootArtifactId: root.id, version: 2, size: 12 },
    });
    versionId = version.id;
    // Same space and bot, different user: explicit ownership must still apply.
    await system.artifact.create({ data: { ...common, userId: otherUserId, name: "private.txt" } });
    const message = await system.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [
          {
            kind: "file",
            artifactId: version.id,
            name: "result.txt",
            mimeType: "text/plain",
            size: 12,
          },
        ],
      },
    });
    messageId = message.id;
  });
  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });
  it("reads existing attachment references and versions without leaking a same-space user's artifact", async () => {
    const result = await runAsTenant(actor, () => listConversationFiles({ prisma }, actor, target));
    expect(result.storage).toEqual({ files: 1, versions: 2, bytes: 17 });
    expect(result.items).toEqual([
      expect.objectContaining({
        id: versionId,
        familyId: rootId,
        versionCount: 2,
        messageId,
        origin: "attachment",
      }),
    ]);
  });
  it("refuses another user's access to the conversation before loading references", async () => {
    const other = { ...actor, userId: otherUserId };
    await expect(
      runAsTenant(other, () => listConversationFiles({ prisma }, other, target)),
    ).rejects.toBeInstanceOf(IsolationError);
  });
  it("does not spill bot uploads into a task conversation", async () => {
    const taskThread = await system.thread.create({
      data: { spaceId, userId, taskBotId: target.kind === "bot" ? target.botId : undefined },
    });
    const taskTarget = { ...target, threadId: taskThread.id, taskId: "task-test" } as ThreadTarget;
    const result = await runAsTenant(actor, () =>
      listConversationFiles({ prisma }, actor, taskTarget),
    );
    expect(result).toEqual({ items: [], storage: { files: 0, versions: 0, bytes: 0 } });
  });
  it("keeps task uploads out of the direct conversation, including before send", async () => {
    const taskThread = await system.thread.create({
      data: { spaceId, userId, taskBotId: target.kind === "bot" ? target.botId : undefined },
    });
    const upload = await system.artifact.create({
      data: {
        spaceId,
        userId,
        botId: target.kind === "bot" ? target.botId : "",
        uploadThreadId: taskThread.id,
        name: "result.txt",
        mimeType: "text/plain",
        size: 7,
        hash: "test-hash",
        storageKey: "task-blob",
      },
    });
    const direct = await runAsTenant(actor, () => listConversationFiles({ prisma }, actor, target));
    expect(direct.items.some((file) => file.id === upload.id)).toBe(false);
    const taskFiles = await runAsTenant(actor, () =>
      listConversationFiles({ prisma }, actor, {
        ...target,
        taskId: "test-task",
        threadId: taskThread.id,
      } as ThreadTarget),
    );
    expect(taskFiles.items.map((file) => file.id)).toEqual([upload.id]);
    const versionScope = { spaceId, userId, botId: upload.botId!, name: "result.txt" };
    expect(
      await runAsTenant(actor, () =>
        resolveNextArtifactVersion(prisma, { ...versionScope, uploadThreadId: taskThread.id }),
      ),
    ).toEqual({ rootArtifactId: upload.id, version: 2 });
    expect(
      await runAsTenant(actor, () => resolveNextArtifactVersion(prisma, versionScope)),
    ).toEqual({ rootArtifactId: rootId, version: 3 });
  });
});
