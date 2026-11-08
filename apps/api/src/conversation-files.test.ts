import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listConversationFiles } from "./conversation-files.js";
import type { ThreadTarget } from "./thread-target.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const target = { kind: "bot", botId: "bot", threadId: "thread" } as ThreadTarget;
function artifact(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    rootArtifactId: null,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot",
    groupId: null,
    runId: null,
    name: `${id}.txt`,
    description: null,
    mimeType: "text/plain",
    size: 5,
    version: 1,
    createdAt: new Date("2026-10-01"),
    ...patch,
  };
}
function setup(rows: unknown[] = [], messages: unknown[] = []) {
  const thread = { findFirst: vi.fn(async () => ({ id: "thread" })) };
  const message = { findMany: vi.fn().mockResolvedValue(messages) };
  const run = { findMany: vi.fn(async () => [{ id: "run" }]) };
  const artifact = { findMany: vi.fn(async (_args: unknown) => rows) };
  return {
    deps: { prisma: { thread, message, run, artifact } as unknown as PrismaClient },
    thread,
    message,
    run,
    artifact,
  };
}

describe("conversation files", () => {
  it("groups versions, counts all bytes and links the exact referenced latest version", async () => {
    const test = setup(
      [
        artifact("v2", { rootArtifactId: "root", version: 2, size: 12, runId: "run" }),
        artifact("root"),
        artifact("upload"),
      ],
      [
        { id: "bot-message", seq: 3, role: "bot", blocks: [{ kind: "file", artifactId: "v2" }] },
        {
          id: "upload-message",
          seq: 2,
          role: "user",
          blocks: [{ kind: "image", artifactId: "upload" }],
        },
      ],
    );
    const result = await listConversationFiles(test.deps, actor, target);
    expect(result.storage).toEqual({ files: 2, versions: 3, bytes: 22 });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "v2",
          familyId: "root",
          versionCount: 2,
          origin: "generated",
          messageId: "bot-message",
        }),
        expect.objectContaining({
          id: "upload",
          origin: "attachment",
          messageId: "upload-message",
        }),
      ]),
    );
    expect(test.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space",
          userId: "owner",
          OR: [
            { id: { in: ["v2", "upload"] } },
            { runId: { in: ["run"] } },
            { botId: "bot", groupId: null, runId: null, uploadThreadId: null },
            { uploadThreadId: "thread" },
          ],
        },
      }),
    );
  });

  it("does not invent a message link for an unreferenced new version", async () => {
    const test = setup(
      [artifact("root"), artifact("v2", { rootArtifactId: "root", version: 2, runId: "run" })],
      [{ id: "old-message", seq: 1, role: "bot", blocks: [{ kind: "file", artifactId: "root" }] }],
    );
    expect((await listConversationFiles(test.deps, actor, target)).items[0]).toMatchObject({
      id: "v2",
      messageId: null,
    });
  });

  it("fails closed before reading messages or files for a foreign thread", async () => {
    const test = setup();
    test.thread.findFirst.mockResolvedValue(null as never);
    await expect(listConversationFiles(test.deps, actor, target)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(test.thread.findFirst).toHaveBeenCalledWith({
      where: { id: "thread", spaceId: "space", userId: "owner" },
      select: { id: true },
    });
    expect(test.message.findMany).not.toHaveBeenCalled();
    expect(test.artifact.findMany).not.toHaveBeenCalled();
  });

  it("restricts task files to exact references and runs from that task thread", async () => {
    const test = setup();
    await listConversationFiles(test.deps, actor, { ...target, taskId: "task" } as ThreadTarget);
    expect(test.artifact.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { OR: [{ id: { in: [] } }, { runId: { in: ["run"] } }, { uploadThreadId: "thread" }] },
    });
    expect(test.run.findMany).toHaveBeenCalledWith({
      where: { threadId: "thread", spaceId: "space", userId: "owner" },
      select: { id: true },
    });
  });

  it("does not list unrelated personal uploads in a group", async () => {
    const test = setup();
    await listConversationFiles(test.deps, actor, {
      kind: "group",
      groupId: "group",
      threadId: "thread",
    } as ThreadTarget);
    expect(test.artifact.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        OR: [
          { id: { in: [] } },
          { runId: { in: ["run"] } },
          { groupId: "group", runId: null, uploadThreadId: null },
          { uploadThreadId: "thread" },
        ],
      },
    });
  });

  it("walks older message pages instead of losing provenance outside the latest transcript", async () => {
    const test = setup([artifact("old")]);
    test.message.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          id: `m${index}`,
          seq: 1000 - index,
          role: "bot",
          blocks: [],
        })),
      )
      .mockResolvedValueOnce([
        {
          id: "old-message",
          seq: 500,
          role: "user",
          blocks: [{ kind: "file", artifactId: "old" }],
        },
      ]);
    expect((await listConversationFiles(test.deps, actor, target)).items[0]?.messageId).toBe(
      "old-message",
    );
    expect(test.message.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { threadId: "thread", seq: { lt: 501 } },
      take: 500,
    });
  });
  it("lists a background artifact without offering a jump to a hidden message", async () => {
    const test = setup(
      [artifact("background", { runId: "background-run" })],
      [
        {
          id: "hidden",
          seq: 1,
          role: "bot",
          runId: "background-run",
          blocks: [{ kind: "file", artifactId: "background" }],
        },
      ],
    );
    test.run.findMany.mockResolvedValue([{ id: "background-run", trigger: "tickets" }] as never);
    const result = await listConversationFiles(test.deps, actor, target);
    expect(result.items[0]).toMatchObject({
      id: "background",
      origin: "generated",
      messageId: null,
    });
  });
});
