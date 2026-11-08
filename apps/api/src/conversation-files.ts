import type { Actor, ConversationFiles } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { withoutPeerRunMessages } from "./thread-message-pages.js";
import type { ThreadTarget } from "./thread-target.js";

const MESSAGE_PAGE_SIZE = 500;

type Reference = { messageId: string | null; role: string };

/** Read through Prisma so encrypted message blocks use the normal decryption boundary. */
export async function listConversationFiles(
  deps: { prisma: Pick<PrismaClient, "thread" | "message" | "run" | "artifact"> },
  actor: Actor,
  target: ThreadTarget,
): Promise<ConversationFiles> {
  // Recheck the tenant boundary here as well as in the route's target resolver.
  const thread = await deps.prisma.thread.findFirst({
    where: { id: target.threadId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!thread) throw new IsolationError();

  const references = new Map<string, Reference>();
  let before: number | undefined;
  while (true) {
    const messages = await deps.prisma.message.findMany({
      where: {
        threadId: target.threadId,
        ...(before === undefined ? {} : { seq: { lt: before } }),
      },
      select: { id: true, seq: true, role: true, blocks: true, runId: true },
      orderBy: { seq: "desc" },
      take: MESSAGE_PAGE_SIZE,
    });
    const visibleIds = new Set(
      (await withoutPeerRunMessages(deps.prisma, messages)).map((message) => message.id),
    );
    for (const message of messages) {
      if (!Array.isArray(message.blocks)) continue;
      for (const value of message.blocks) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const block = value as Record<string, unknown>;
        if (
          (block.kind !== "file" && block.kind !== "image") ||
          typeof block.artifactId !== "string"
        )
          continue;
        if (!references.has(block.artifactId)) {
          references.set(block.artifactId, {
            messageId: visibleIds.has(message.id) ? message.id : null,
            role: message.role,
          });
        }
      }
    }
    if (messages.length < MESSAGE_PAGE_SIZE) break;
    before = messages.at(-1)!.seq;
  }

  const runs = await deps.prisma.run.findMany({
    where: { threadId: target.threadId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  const sources: Prisma.ArtifactWhereInput[] = [
    { id: { in: [...references.keys()] } },
    { runId: { in: runs.map((run) => run.id) } },
  ];
  // Unsent uploads have no message yet. Task conversations only include explicit
  // references or their own runs; a bot's general uploads must not bleed into them.
  if (target.kind === "group")
    sources.push({ groupId: target.groupId, runId: null, uploadThreadId: null });
  else if (!("taskId" in target && target.taskId)) {
    sources.push({ botId: target.botId, groupId: null, runId: null, uploadThreadId: null });
  }
  sources.push({ uploadThreadId: target.threadId });
  const rows = await deps.prisma.artifact.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, OR: sources },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const families = new Map<string, typeof rows>();
  for (const row of rows) {
    const familyId = row.rootArtifactId ?? row.id;
    const family = families.get(familyId) ?? [];
    family.push(row);
    families.set(familyId, family);
  }
  const items = [...families]
    .map(([familyId, versions]) => {
      const row = versions.reduce((latest, version) =>
        version.version > latest.version ? version : latest,
      );
      const reference = references.get(row.id);
      return {
        id: row.id,
        familyId,
        botId: row.botId,
        groupId: row.groupId,
        runId: row.runId,
        name: row.name,
        description: row.description,
        mimeType: row.mimeType,
        size: row.size,
        version: row.version,
        versionCount: versions.length,
        createdAt: row.createdAt.toISOString(),
        origin:
          reference?.role === "user"
            ? ("attachment" as const)
            : row.runId || reference
              ? ("generated" as const)
              : ("file" as const),
        messageId: reference?.messageId ?? null,
      };
    })
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  return {
    items,
    storage: {
      bytes: rows.reduce((sum, row) => sum + row.size, 0),
      versions: rows.length,
      files: families.size,
    },
  };
}
