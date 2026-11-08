import type { Prisma } from "@rakazo/db";

/** Membership alone misses departed owners and setup without a bot or registration. */
export async function nativeSetupOwners(
  db: Pick<Prisma.TransactionClient, "spaceMember" | "registeredHost" | "nativeSetupOwner">,
  where: { spaceId: string } | { userId: string },
): Promise<Array<{ spaceId: string; userId: string }>> {
  const select = { spaceId: true, userId: true } as const;
  const groups = await Promise.all([
    db.spaceMember.findMany({ where, select }),
    db.registeredHost.findMany({ where, select }),
    db.nativeSetupOwner.findMany({ where, select }),
  ]);
  return [...new Map(groups.flat().map((owner) => [JSON.stringify(owner), owner])).values()];
}
