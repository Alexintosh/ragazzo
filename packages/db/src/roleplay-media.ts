import type { MessageBlock } from "@rakazo/contracts";
import {
  isAttachmentImageMimeType,
  RoleplayCharacterSchema,
  RoleplayMediaStateSchema,
} from "@rakazo/contracts";
import type { Prisma } from "./client.js";

export type RoleplayMediaGuard = {
  revision: number;
  historyGeneration: number;
  characterMedia: string;
  /** Server-selected explicit player request, never spontaneous direction. */
  imageRequested?: boolean;
};

/** Called under the thread, bot and account locks in the finalization transaction. */
export async function validateRoleplayMediaDelivery(
  tx: Prisma.TransactionClient,
  input: {
    botId: string;
    threadId: string;
    spaceId: string;
    userId: string;
    blocks: MessageBlock[];
    additionalMessages?: MessageBlock[][];
    roleplayState?: Prisma.InputJsonValue;
    roleplayMediaGuard?: RoleplayMediaGuard;
    spontaneous: boolean;
  },
): Promise<{ suppress: boolean; roleplayState: Prisma.InputJsonValue | undefined }> {
  const images = [input.blocks, ...(input.additionalMessages ?? [])]
    .flat()
    .filter((block) => block.kind === "image");
  const [bot, thread, user] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, userId: input.userId, spaceId: input.spaceId, archivedAt: null },
    }),
    tx.thread.findFirst({
      where: {
        id: input.threadId,
        userId: input.userId,
        spaceId: input.spaceId,
        botId: input.botId,
        groupId: null,
        externalConversationId: null,
      },
    }),
    tx.user.findUnique({ where: { id: input.userId }, select: { roleplayEnabled: true } }),
  ]);
  if (bot?.botKind !== "roleplay" && !input.roleplayMediaGuard)
    return { suppress: false, roleplayState: input.roleplayState };
  const state = input.roleplayState as Record<string, Prisma.InputJsonValue> | undefined;
  const currentState = thread?.roleplayState as Record<string, unknown> | null;
  const current = RoleplayMediaStateSchema.safeParse(currentState?.media);
  const prior = current.success
    ? current.data
    : { revision: 0, turn: 0, lastImageTurn: null, sentImageIds: [] as string[] };
  const next = RoleplayMediaStateSchema.safeParse(state?.media);
  const character = RoleplayCharacterSchema.safeParse(bot?.roleplayCharacter);
  const media = character.success ? character.data.media : undefined;
  const guard = input.roleplayMediaGuard;
  const valid =
    bot?.botKind === "roleplay" &&
    !!thread &&
    user?.roleplayEnabled === true &&
    !!guard &&
    guard.revision === prior.revision &&
    guard.historyGeneration === thread.historyCompactionGeneration &&
    guard.characterMedia === JSON.stringify(media ?? null);
  const preserveMedia = () => {
    if (!state) return input.roleplayState;
    const saved = { ...state };
    if (current.success) saved.media = current.data;
    else delete saved.media;
    return saved;
  };
  if (!valid) return { suppress: images.length > 0, roleplayState: preserveMedia() };
  if (
    !next.success ||
    next.data.revision !== prior.revision + 1 ||
    next.data.turn !== prior.turn + 1
  )
    return { suppress: images.length > 0, roleplayState: preserveMedia() };
  if (!images.length) {
    if (
      next.data.lastImageTurn !== prior.lastImageTurn ||
      JSON.stringify(next.data.sentImageIds) !== JSON.stringify(prior.sentImageIds)
    )
      return { suppress: false, roleplayState: preserveMedia() };
    return { suppress: false, roleplayState: input.roleplayState };
  }
  if (!media?.enabled || (input.spontaneous && !media.allowSpontaneous) || images.length > 1)
    return { suppress: true, roleplayState: undefined };
  const entries = images.map((block) =>
    media.album.find((entry) => entry.enabled && entry.artifactId === block.artifactId),
  );
  if (
    entries.some((entry) => !entry) ||
    entries.some((entry) => !next.data.sentImageIds.includes(entry!.id))
  )
    return { suppress: true, roleplayState: undefined };
  const entry = entries[0]!;
  if (
    (prior.sentImageIds.includes(entry.id) && (!guard.imageRequested || input.spontaneous)) ||
    next.data.lastImageTurn !== next.data.turn ||
    JSON.stringify(next.data.sentImageIds) !==
      JSON.stringify([...new Set([...prior.sentImageIds, entry.id])].slice(-32))
  )
    return { suppress: true, roleplayState: undefined };
  const artifacts = await tx.artifact.findMany({
    where: {
      id: { in: images.map((block) => block.artifactId) },
      botId: input.botId,
      spaceId: input.spaceId,
      userId: input.userId,
      groupId: null,
      uploadThreadId: null,
    },
  });
  if (
    artifacts.length !== images.length ||
    images.some(
      (image) =>
        !artifacts.some(
          (artifact) =>
            artifact.id === image.artifactId &&
            artifact.mimeType === image.mimeType &&
            isAttachmentImageMimeType(artifact.mimeType),
        ),
    )
  )
    return { suppress: true, roleplayState: undefined };
  return { suppress: false, roleplayState: input.roleplayState };
}
