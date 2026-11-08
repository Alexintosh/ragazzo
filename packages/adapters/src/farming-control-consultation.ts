import { MessageBlock } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlOutsideBlocks, farmingControlRole } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

type ConsultationDb = Pick<PrismaClient, "run" | "message" | "steeringMessage">;
type RunIdentity = { id: string; botId: string; userId: string; spaceId: string; threadId: string };
export type FarmingControlPrivateConsultation = {
  intent: "request" | "question" | "result" | "status";
  rootRunId: string;
  rootSourceMessageId: string;
};
export class FarmingControlPrivateConsultationDenied extends Error {
  constructor() {
    super("This run is not an authorized private Farming Control consultation.");
    this.name = "FarmingControlPrivateConsultationDenied";
  }
}

async function privateRun(
  prisma: ConsultationDb,
  identity: RunIdentity,
  role: "coordinator" | "opportunities",
  status?: "running" | "terminal",
) {
  const run = await prisma.run.findFirst({
    where: {
      id: identity.id,
      botId: identity.botId,
      userId: identity.userId,
      spaceId: identity.spaceId,
      threadId: identity.threadId,
      ...(status === "running"
        ? { status: "running" }
        : status === "terminal"
          ? { status: { in: ["completed", "failed", "cancelled"] } }
          : {}),
    },
    select: {
      id: true,
      trigger: true,
      sourceMessageId: true,
      bot: { select: { id: true, spaceId: true, userId: true, spawnKey: true, archivedAt: true } },
      thread: {
        select: {
          id: true,
          userId: true,
          spaceId: true,
          botId: true,
          groupId: true,
          externalConversationId: true,
        },
      },
      sourceMessage: {
        select: {
          id: true,
          role: true,
          threadId: true,
          botId: true,
          runId: true,
          blocks: true,
          replyToMessageId: true,
        },
      },
    },
  });
  if (
    !run ||
    run.bot.archivedAt ||
    farmingControlRole(run.bot) !== role ||
    run.bot.id !== identity.botId ||
    run.bot.userId !== identity.userId ||
    run.bot.spaceId !== identity.spaceId ||
    run.thread.id !== identity.threadId ||
    run.thread.userId !== identity.userId ||
    run.thread.spaceId !== identity.spaceId ||
    run.thread.botId !== identity.botId ||
    run.thread.groupId ||
    run.thread.externalConversationId ||
    !run.sourceMessage ||
    run.sourceMessage.id !== run.sourceMessageId ||
    run.sourceMessage.threadId !== identity.threadId
  )
    throw new FarmingControlPrivateConsultationDenied();
  const outside = await prisma.steeringMessage.findFirst({
    where: {
      runId: run.id,
      OR: [
        { originTrigger: { not: null } },
        { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
        { message: { blocks: { array_contains: [{ kind: "bot_message_received" }] } } },
      ],
    },
    select: { id: true },
  });
  if (outside) throw new FarmingControlPrivateConsultationDenied();
  return run;
}

/** Only a surviving owner app turn may start a consultation. Returned results cannot start another. */
export async function verifyFarmingControlPrivateRequest(
  prisma: ConsultationDb,
  identity: RunIdentity,
) {
  return ownerRequest(prisma, identity, "running");
}
async function ownerRequest(prisma: ConsultationDb, identity: RunIdentity, status?: "running") {
  const run = await privateRun(prisma, identity, "coordinator", status);
  if (
    (run.trigger !== "user" && run.trigger !== "follow_up") ||
    run.sourceMessage!.role !== "user" ||
    run.sourceMessage!.botId ||
    farmingControlOutsideBlocks(run.sourceMessage!.blocks)
  )
    throw new FarmingControlPrivateConsultationDenied();
  return { rootRunId: run.id, rootSourceMessageId: run.sourceMessage!.id };
}

/** Validate both durable halves of the native delivery, never a peer-provided origin claim. */
async function nativeEdge(
  prisma: ConsultationDb,
  identity: RunIdentity,
  role: "coordinator" | "opportunities",
  status?: "running" | "terminal",
) {
  const run = await privateRun(prisma, identity, role, status);
  const source = run.sourceMessage!;
  const blocks = MessageBlock.array().safeParse(source.blocks);
  const inbound = blocks.success && blocks.data.length === 1 ? blocks.data[0] : undefined;
  if (
    run.trigger !== "bot_message" ||
    source.role !== "user" ||
    source.botId ||
    source.runId !== run.id ||
    inbound?.kind !== "bot_message_received" ||
    !inbound.returnToMessageId
  )
    throw new FarmingControlPrivateConsultationDenied();
  const outbound = await prisma.message.findUnique({
    where: { id: inbound.returnToMessageId },
    select: { id: true, role: true, threadId: true, botId: true, runId: true, blocks: true },
  });
  const sent = MessageBlock.array().safeParse(outbound?.blocks);
  const block = sent.success && sent.data.length === 1 ? sent.data[0] : undefined;
  if (
    outbound?.role !== "bot" ||
    outbound.botId !== inbound.fromBotId ||
    !outbound.runId ||
    block?.kind !== "bot_message_sent" ||
    block.toBotId !== identity.botId ||
    block.text !== inbound.text ||
    (block.intent ?? "request") !== (inbound.intent ?? "request")
  )
    throw new FarmingControlPrivateConsultationDenied();
  return {
    run,
    source,
    inbound,
    outbound,
    parent: {
      userId: identity.userId,
      spaceId: identity.spaceId,
      id: outbound.runId,
      botId: inbound.fromBotId,
      threadId: outbound.threadId,
    },
  };
}

/** Requests and their exact terminal returns share the original private Coordinator owner turn. */
export async function verifyFarmingControlPrivateConsultation(
  prisma: ConsultationDb,
  identity: RunIdentity,
  options: { allowTerminalSource?: boolean } = {},
): Promise<FarmingControlPrivateConsultation> {
  const status = options.allowTerminalSource ? "terminal" : "running";
  // The fixed role is checked from persisted bot identity, never the caller's name.
  if (identity.botId === farmingControlBotId(identity.spaceId, "coordinator")) {
    const coordinatorReturn = await nativeEdge(prisma, identity, "coordinator", status);
    const intent = coordinatorReturn.inbound.intent;
    if (coordinatorReturn.inbound.hop !== 2 || (intent !== "result" && intent !== "status"))
      throw new FarmingControlPrivateConsultationDenied();
    const request = await nativeEdge(prisma, coordinatorReturn.parent, "opportunities");
    const requestIntent = request.inbound.intent ?? "request";
    if (
      request.inbound.hop !== 1 ||
      (requestIntent !== "request" && requestIntent !== "question") ||
      request.parent.botId !== identity.botId ||
      request.parent.threadId !== identity.threadId ||
      coordinatorReturn.source.replyToMessageId !== request.outbound.id
    )
      throw new FarmingControlPrivateConsultationDenied();
    return { intent, ...(await ownerRequest(prisma, request.parent)) };
  }
  const request = await nativeEdge(prisma, identity, "opportunities", status);
  const intent = request.inbound.intent ?? "request";
  if (request.inbound.hop !== 1 || (intent !== "request" && intent !== "question"))
    throw new FarmingControlPrivateConsultationDenied();
  return { intent, ...(await ownerRequest(prisma, request.parent)) };
}
