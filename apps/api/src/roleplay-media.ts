import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { fetchSafeWebBytes } from "@rakazo/adapters";
import type { Actor, RoleplayCharacter } from "@rakazo/contracts";
import {
  attachmentMaxBytes,
  isAttachmentImageMimeType,
  RoleplayMediaStateSchema,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, roleplayStoryState } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { IsolationError, isRoleplayEnabled } from "@rakazo/db";
import { createOwnedArtifact, getOwnedArtifact } from "./artifacts.js";
import type { RouterDeps } from "./router.js";

function mediaState(value: unknown) {
  const parsed = RoleplayMediaStateSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        storyMode: false,
        scene: "",
        revision: 0,
        lastImageTurn: null,
        sentImageIds: [],
        turn: 0,
      };
}
function revision(thread: {
  roleplayState: unknown;
  historyCompactionGeneration: number;
  nextMessageSeq: number;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        thread.roleplayState,
        thread.historyCompactionGeneration,
        thread.nextMessageSeq,
      ]),
    )
    .digest("hex");
}
async function ownedBot(deps: Pick<RouterDeps, "prisma">, actor: Actor, botId: string) {
  if (!(await isRoleplayEnabled(deps.prisma, actor.userId)))
    throw new ORPCError("FORBIDDEN", { message: "Roleplay is not enabled" });
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { thread: true },
  });
  if (!bot) throw new IsolationError();
  if (
    bot.botKind !== "roleplay" ||
    !bot.thread ||
    bot.thread.groupId ||
    bot.thread.externalConversationId ||
    bot.thread.spaceId !== actor.spaceId ||
    bot.thread.userId !== actor.userId
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "Images require a direct roleplay conversation",
    });
  return bot as typeof bot & { thread: NonNullable<typeof bot.thread> };
}
async function snapshot(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  bot: Awaited<ReturnType<typeof ownedBot>>,
) {
  const state = roleplayStoryState(bot.thread.roleplayState, {
    threadId: bot.thread.id,
    botId: bot.id,
    historyGeneration: bot.thread.historyCompactionGeneration,
  });
  const media = mediaState(state.media);
  const artifacts = await deps.prisma.artifact.findMany({
    where: {
      botId: bot.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: null,
      uploadThreadId: null,
      mimeType: { in: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return {
    artifacts: artifacts.map((row) => ({
      id: row.id,
      botId: row.botId,
      groupId: row.groupId,
      runId: row.runId,
      name: row.name,
      description: row.description,
      mimeType: row.mimeType,
      size: row.size,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    })),
    storyMode: media.storyMode,
    scene: media.scene,
    historyGeneration: bot.thread.historyCompactionGeneration,
    revision: revision(bot.thread),
  };
}
export async function loadRoleplayMedia(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  botId: string,
) {
  return snapshot(deps, actor, await ownedBot(deps, actor, botId));
}
export async function updateRoleplayStoryMode(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  input: { botId: string; enabled: boolean; historyGeneration: number; expectedRevision: string },
) {
  const bot = await ownedBot(deps, actor, input.botId);
  await deps.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.id} FOR UPDATE`;
      const current = await ownedBot({ prisma: tx as RouterDeps["prisma"] }, actor, bot.id);
      if (
        current.thread.id !== bot.thread.id ||
        current.thread.historyCompactionGeneration !== input.historyGeneration ||
        revision(current.thread) !== input.expectedRevision
      )
        throw new ORPCError("CONFLICT", {
          message: "The conversation changed. Reload story mode before saving.",
        });
      if (
        await tx.run.findFirst({
          where: { threadId: current.thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
          select: { id: true },
        })
      )
        throw new ORPCError("CONFLICT", {
          message: "Wait for the current reply before changing story mode.",
        });
      const state = roleplayStoryState(current.thread.roleplayState, {
        threadId: current.thread.id,
        botId: current.id,
        historyGeneration: current.thread.historyCompactionGeneration,
      });
      const media = mediaState(state.media);
      state.media = { ...media, storyMode: input.enabled, revision: media.revision + 1 };
      await tx.thread.update({
        where: { id: current.thread.id },
        data: { roleplayState: state as unknown as Prisma.InputJsonValue },
      });
    },
    { maxWait: 5_000, timeout: 20_000 },
  );
  return loadRoleplayMedia(deps, actor, bot.id);
}
export async function assertRoleplayAlbum(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  botId: string | null,
  character: RoleplayCharacter | null | undefined,
) {
  if (!character?.media?.album.length) return;
  if (!botId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Save the character before adding album images",
    });
  const ids = character.media.album.map((entry) => entry.artifactId);
  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: null,
      uploadThreadId: null,
    },
  });
  if (rows.length !== ids.length || rows.some((row) => !isAttachmentImageMimeType(row.mimeType)))
    throw new ORPCError("BAD_REQUEST", { message: "Album images must belong to this character" });
}

/** Only raster formats already supported in chat, with a signature matching the HTTP type. */
export function roleplayImageMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (
    bytes.length >= 8 &&
    bytes[0] === 137 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  return null;
}
export async function importRoleplayMedia(
  deps: RouterDeps,
  actor: Actor,
  input: { botId: string; url: string; name?: string; description?: string },
) {
  await ownedBot(deps, actor, input.botId);
  try {
    const downloaded = await fetchSafeWebBytes(input.url, {
      fetch: deps.remoteConnectors?.fetch,
      resolveHostname: deps.remoteConnectors?.resolveHostname,
      maxBytes: attachmentMaxBytes(deps.env),
      allowedPorts: [80, 443],
    });
    const mimeType = roleplayImageMime(downloaded.body);
    if (!mimeType || downloaded.contentType?.split(";")[0]?.trim().toLowerCase() !== mimeType)
      throw new Error("URL must return a supported image with a matching content type");
    return await createOwnedArtifact(
      { ...deps, maxUploadSizeBytes: attachmentMaxBytes(deps.env) },
      actor,
      {
        botId: input.botId,
        name: input.name ?? `story-image.${mimeType.split("/")[1]}`,
        description: input.description,
        mimeType,
        contentBase64: Buffer.from(downloaded.body).toString("base64"),
      },
    );
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Image import failed",
    });
  }
}

export async function duplicateRoleplayAlbum(
  deps: RouterDeps,
  actor: Actor,
  sourceBotId: string,
  botId: string,
  character: RoleplayCharacter,
) {
  if (!character.media?.album.length) return character;
  const album = [];
  for (const entry of character.media.album) {
    const image = await getOwnedArtifact(deps, actor, {
      botId: sourceBotId,
      artifactId: entry.artifactId,
    });
    const copied = await createOwnedArtifact(deps, actor, {
      botId,
      name: image.name,
      mimeType: image.mimeType,
      contentBase64: image.contentBase64,
      description: image.description ?? undefined,
    });
    album.push({ ...entry, artifactId: copied.id });
  }
  const copied = { ...character, media: { ...character.media, album } };
  await deps.prisma.bot.update({
    where: { id: botId },
    data: {
      roleplayCharacter: copied as unknown as Prisma.InputJsonValue,
    },
  });
  return copied;
}
