import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { messageBlockForArtifact } from "@rakazo/core";
import type { RunContext } from "./run-context.js";
import { isUniqueViolation, persistMessageInTransaction } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";

/** The native event identity survives approval continuations and cursor replay. */
export async function publishNativeOutput(
  ctx: RunContext,
  file: Parameters<NonNullable<AgentRunRequest["onOutputFile"]>>[0],
  lease: { workerId: string; fence: number },
) {
  const { deps, run, thread } = ctx;
  if (!deps.artifacts) return;
  ctx.context.signal.throwIfAborted();
  const clientNonce = `native-output:${file.id}`;
  const where = { threadId_clientNonce: { threadId: thread.id, clientNonce } };
  if (await deps.prisma.message.findUnique({ where, select: { id: true } })) {
    ctx.state.reply.publishedMidTurnUserMessage = true;
    return;
  }
  let committed: Awaited<ReturnType<typeof persistMessageInTransaction>> | undefined;
  try {
    await attachWorkspaceFileToThread(
      {
        prisma: deps.prisma,
        artifacts: deps.artifacts,
        maxUploadSizeBytes: deps.maxUploadSizeBytes,
      },
      {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        groupId: thread.groupId ?? undefined,
        runId: run.id,
        filePath: file.path,
        bytes: file.bytes,
        operationId: clientNonce,
        onAttached: async (tx, artifact) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
          // A conditional write holds the run lock through artifact/message commit.
          // A plain read would allow cancellation or a new fence to win in between.
          const owned = await tx.run.updateMany({
            where: {
              id: run.id,
              status: "running",
              leaseOwner: lease.workerId,
              leaseFence: lease.fence,
              leaseExpiresAt: { gt: new Date() },
            },
            data: { leaseFence: lease.fence },
          });
          if (owned.count !== 1)
            throw new Error("Run lease expired before publishing native output");
          ctx.context.signal.throwIfAborted();
          committed = await persistMessageInTransaction(
            tx,
            run,
            "bot",
            [messageBlockForArtifact(artifact)],
            undefined,
            clientNonce,
          );
        },
      },
    );
  } catch (error) {
    if (
      !isUniqueViolation(error) ||
      !(await deps.prisma.message.findUnique({ where, select: { id: true } }))
    )
      throw error;
    ctx.state.reply.publishedMidTurnUserMessage = true;
    return;
  }
  if (committed)
    await deps.events
      .notify(thread.id, committed.eventSeq, committed.firstResponseRunId)
      .catch(() => undefined);
  ctx.state.reply.publishedMidTurnUserMessage = true;
}
