import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";

function fixture() {
  const actor = {
    userId: "owner",
    spaceId: "personal",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const members = ["lead", "specialist"].map((id) => ({
    bot: { id, name: id, color: "#111", runs: [] },
  }));
  const row = {
    id: "managed-team",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name: "Team",
    pinned: false,
    sectionId: null,
    archivedAt: null as Date | null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    thread: { id: "thread", unread: false, messages: [] },
    members,
  };
  let created = false;
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push("space-lock");
      return [];
    }),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "personal", space: { deletingAt: null } })),
    },
    chatGroup: {
      findFirst: vi.fn(async () => {
        calls.push("find-existing");
        return created ? row : null;
      }),
      create: vi.fn(async ({ data }) => {
        created = true;
        return { id: data.id };
      }),
      findFirstOrThrow: vi.fn(async () => row),
    },
    chatGroupMember: { createMany: vi.fn() },
    thread: { create: vi.fn() },
    message: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    bot: { findMany: vi.fn(async () => members.map((member) => member.bot)) },
  } as unknown as PrismaClient;
  return { actor, row, tx, calls, repos: createGroupRepos(prisma) };
}

it("reuses a deterministic group and its thread after obtaining the existing space lock", async () => {
  const f = fixture();
  const input = { id: "managed-team", name: "Team", botIds: ["lead", "specialist"] };
  const first = await f.repos.createGroup(f.actor, input);
  const second = await f.repos.createGroup(f.actor, input);
  expect(first.id).toBe(second.id);
  expect(first.threadId).toBe(second.threadId);
  expect(f.tx.chatGroup.create).toHaveBeenCalledTimes(1);
  expect(f.tx.thread.create).toHaveBeenCalledTimes(1);
  expect(f.tx.chatGroupMember.createMany).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual(["space-lock", "find-existing", "space-lock", "find-existing"]);
  expect(f.tx.chatGroup.findFirst).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: { id: input.id, spaceId: f.actor.spaceId, userId: f.actor.userId },
    }),
  );
});

it("does not revive an archived managed group or silently replace edited membership", async () => {
  const f = fixture();
  const input = { id: "managed-team", name: "Team", botIds: ["lead", "specialist"] };
  await f.repos.createGroup(f.actor, input);
  f.row.archivedAt = new Date();
  await expect(f.repos.createGroup(f.actor, input)).rejects.toThrow("configured group has changed");
  f.row.archivedAt = null;
  f.row.members = [
    { bot: { id: "outsider", name: "Other", color: "#111", runs: [] } },
    f.row.members[0]!,
  ];
  await expect(f.repos.createGroup(f.actor, input)).rejects.toThrow("configured group has changed");
  expect(f.tx.chatGroup.create).toHaveBeenCalledTimes(1);
  expect(f.tx.chatGroupMember.createMany).toHaveBeenCalledTimes(1);
});
