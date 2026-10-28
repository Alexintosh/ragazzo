import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";

const actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.test",
  isDeploymentOwner: false,
};

describe("roleplay group boundary", () => {
  it.each(["create", "update"] as const)(
    "rejects %s before any group mutation",
    async (operation) => {
      const transaction = vi.fn();
      const prisma = {
        bot: {
          findMany: vi.fn().mockResolvedValue([
            { id: "agent", name: "Agent", color: "gray", botKind: "agent" },
            { id: "character", name: "Character", color: "gray", botKind: "roleplay" },
          ]),
        },
        $transaction: transaction,
      } as unknown as PrismaClient;
      const repos = createGroupRepos(prisma);
      const input = { name: "Group", botIds: ["agent", "character"] };
      await expect(
        operation === "create"
          ? repos.createGroup(actor, input)
          : repos.updateGroup(actor, { ...input, groupId: "group" }),
      ).rejects.toThrow("individual stories");
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
