import type { PrismaClient } from "./client.js";

/** Read at admission time so API instances and workers share the saved account preference. */
export async function isRoleplayEnabled(
  prisma: Pick<PrismaClient, "user">,
  userId: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roleplayEnabled: true },
  });
  return user?.roleplayEnabled === true;
}
