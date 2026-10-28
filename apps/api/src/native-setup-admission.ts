import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { IsolationError, lockSpaceForContentCreation } from "@rakazo/db";

/** Serialize new host identities with Space claims and account setup teardown. */
export async function assertNativeSetupAdmission(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
) {
  await lockSpaceForContentCreation(tx, actor);
  const owners = await tx.$queryRaw<Array<{ nativeSetupDisabledAt: Date | null }>>`
    SELECT "nativeSetupDisabledAt" FROM "user" WHERE id = ${actor.userId} FOR UPDATE
  `;
  if (owners.length !== 1 || owners[0]!.nativeSetupDisabledAt) throw new IsolationError();
}
