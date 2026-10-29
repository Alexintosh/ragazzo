import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  destroyBot,
  removeAgentHome,
  removeDeletedBotsFromLegacyTeamHome,
  toComputerRef,
} from "@rakazo/adapters";
import {
  accountDeletionCandidateSpaces,
  claimSpacesLeavingWithAccount,
  deleteSpaceLeavingWithAccount,
  recordComputerRunEnd,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { nativeSetupOwners } from "./native-setup-owners.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

/**
 * Delete what an account leaves on bot computers before its rows go.
 *
 * Spaces nobody else uses go entirely. In spaces others still use, the account's bots go with
 * their folders and browser profiles (on the account's own Team Computer and on the space's Team
 * Computer from before each person got their own), and so do the account's computers: since
 * then a Team Computer only ever runs one person's bots. Each sandbox is destroyed at its
 * provider before its row goes, so a failure keeps the handle and deleting again resumes from
 * what is left.
 */
export async function deleteAccountContent(deps: SpaceDeletionDeps, userId: string): Promise<void> {
  const context = (spaceId: string, botId?: string): AdapterContext => ({
    operationId: `account-delete:${userId}`,
    traceId: `account-delete:${userId}`,
    spaceId,
    userId,
    ...(botId ? { botId } : {}),
    signal: new AbortController().signal,
  });
  await fenceAccountConversationEngineDeletion(deps.prisma, userId);
  const leaving = await claimSpacesLeavingWithAccount(deps.prisma, userId);
  await assertAccountConversationEngineDeletion(deps.prisma, userId);
  if (deps.nativeSetupCleanup) {
    const owners = await runAsSystem("account runtime setup teardown owners", () =>
      nativeSetupOwners(deps.prisma, { userId }),
    );
    await deps.nativeSetupCleanup(owners);
  }
  const bots = await deps.prisma.bot.findMany({
    where: { OR: [{ userId }, { spaceId: { in: leaving } }] },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
      conversationEngine: true,
    },
  });
  await settleAll(
    bots.map((bot) =>
      destroyBot(deps, bot, context(bot.spaceId, bot.id), {
        deleteMemories: true,
        strictTeardown: true,
      }),
    ),
  );

  // Bot deletion cleans these best-effort; here a failure fails the account deletion, and the
  // retry finds the ids again in bot_deletions.
  const deletions = await deps.prisma.botDeletion.findMany({
    where: { deletedByUserId: userId, spaceId: { notIn: leaving } },
    select: { id: true, spaceId: true },
  });
  const deletedBySpace = new Map<string, string[]>();
  for (const { id, spaceId } of deletions)
    deletedBySpace.set(spaceId, [...(deletedBySpace.get(spaceId) ?? []), id]);
  await settleAll(
    [...deletedBySpace].map(([spaceId, botIds]) =>
      removeDeletedBotsFromLegacyTeamHome(deps, spaceId, botIds),
    ),
  );

  const computers = await deps.prisma.computer.findMany({
    where: { OR: [{ userId }, { spaceId: { in: leaving } }] },
    select: {
      id: true,
      spaceId: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      bots: { select: { id: true } },
    },
  });
  await settleAll(
    computers.map(async (computer) => {
      // Only someone else's bot can still be on it, and its files are theirs.
      if (computer.bots.length) {
        getLogger().warn("account.delete.computer_in_use", { "computer.id": computer.id });
        return;
      }
      if (computer.providerRef) {
        await deps.sandbox.destroy(toComputerRef(computer), context(computer.spaceId));
        await recordComputerRunEnd(deps.prisma, computer, "deleted");
      }
      await removeAgentHome(deps.home, computer.homeKey, deps.dataDir);
      // The row holds the stored home's key, so the stored copy is unreadable from here on.
      await deps.prisma.computer.deleteMany({
        where: { id: computer.id, providerRef: computer.providerRef, bots: { none: {} } },
      });
    }),
  );

  for (const spaceId of leaving) {
    const deleted = await deleteSpaceLeavingWithAccount(
      deps.prisma,
      { spaceId, userId },
      deps.nativeSetupCleanup
        ? async () => {
            const owners = await runAsSystem("account Space runtime setup teardown owners", () =>
              nativeSetupOwners(deps.prisma, { spaceId }),
            );
            const formerOwners = owners.filter((owner) => owner.userId !== userId);
            if (formerOwners.length) await deps.nativeSetupCleanup!(formerOwners);
          }
        : undefined,
    );
    if (!deleted) continue;
    const cleanup = await Promise.allSettled(
      deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context(spaceId))),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
  }
}

/** Runs every teardown, then fails with the first error so a retry finishes the rest. */
async function settleAll(work: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(work)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

/** Keep billing and teardown untouched when external engine data still needs operator cleanup. */
export async function assertAccountConversationEngineDeletion(
  prisma: Pick<SpaceDeletionDeps["prisma"], "member" | "space" | "bot">,
  userId: string,
) {
  await runAsSystem("account external engine deletion preflight", async () => {
    const candidates = await accountDeletionCandidateSpaces(prisma, userId);
    const externalBots = await prisma.bot.findMany({
      where: {
        conversationEngine: "eros",
        OR: [
          { userId },
          {
            spaceId: { in: candidates.map((space) => space.id) },
            space: {
              OR: [
                { memberships: { every: { userId } } },
                { deletionClaimId: `account-deletion:${userId}` },
              ],
            },
          },
        ],
      },
      select: { id: true },
    });
    if (externalBots.length)
      throw new Error(
        "External engine data requires operator cleanup before deleting this account.",
      );
  });
}

/** Shares the user-row lock with Eros creation. Must run before any billing or teardown I/O. */
export async function fenceAccountConversationEngineDeletion(
  prisma: SpaceDeletionDeps["prisma"],
  userId: string,
) {
  return runAsSystem("account deletion admission fence", () =>
    prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ nativeSetupDisabledAt: Date | null }>>`
      SELECT "nativeSetupDisabledAt" FROM "user" WHERE id = ${userId} FOR UPDATE
    `;
      if (rows.length !== 1) throw new Error("Account not found");
      await assertAccountConversationEngineDeletion(tx, userId);
      const previous = rows[0]!.nativeSetupDisabledAt;
      const fencedAt = previous ?? new Date();
      await tx.user.update({ where: { id: userId }, data: { nativeSetupDisabledAt: fencedAt } });
      return { previous, fencedAt };
    }),
  );
}
