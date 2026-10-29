import { ORPCError } from "@orpc/server";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type {
  Actor,
  ConversationEngineInspection,
  ConversationEngineState,
  UpdateConversationEngineState,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "env" | "conversationEngines">;

function mapEngineError(error: unknown, mutation = false): never {
  if (error instanceof ConversationEngineError) {
    if (error.code === "conflict" || error.code === "busy")
      throw new ORPCError("CONFLICT", {
        message:
          error.code === "busy"
            ? "Wait for the current reply before changing engine state."
            : "Engine state changed. Refresh before saving.",
      });
    if (error.code === "uncertain" && mutation)
      throw new ORPCError("BAD_GATEWAY", {
        message: "The engine did not confirm the change. Refresh its state before saving again.",
      });
    throw new ORPCError("BAD_GATEWAY", { message: "Engine state is unavailable." });
  }
  throw error;
}

async function resolveBinding(
  prisma: Pick<Prisma.TransactionClient, "bot" | "companionSession">,
  actor: Actor,
  botId: string,
) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { thread: true },
  });
  if (!bot) throw new IsolationError();
  const thread = bot.thread;
  if (
    bot.botKind !== "roleplay" ||
    bot.conversationEngine !== "eros" ||
    !bot.erosCharacterId ||
    !thread ||
    thread.botId !== bot.id ||
    thread.spaceId !== actor.spaceId ||
    thread.userId !== actor.userId ||
    thread.groupId ||
    thread.externalConversationId
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "Engine state requires a direct engine conversation.",
    });
  const session = await prisma.companionSession.findFirst({
    where: {
      botId: bot.id,
      spaceId: actor.spaceId,
      userId: actor.userId,
      threadId: thread.id,
      historyGeneration: thread.historyCompactionGeneration,
      status: "active",
    },
  });
  return { bot, thread, session };
}

function assertEnabled(deps: Deps) {
  if (!deps.env.roleplayEnabled)
    throw new ORPCError("FORBIDDEN", { message: "Roleplay is not enabled." });
}

export async function loadConversationEngineState(
  deps: Deps,
  actor: Actor,
  botId: string,
  signal?: AbortSignal,
): Promise<ConversationEngineState> {
  assertEnabled(deps);
  const { bot, thread, session } = await resolveBinding(deps.prisma, actor, botId);
  const engine = deps.conversationEngines?.get("eros");
  const character = engine?.characters.find(({ id }) => id === bot.erosCharacterId);
  if (!engine?.inspect || !character)
    throw new ORPCError("BAD_REQUEST", { message: "Engine state is unavailable." });
  const base = {
    engineId: "eros" as const,
    character: { id: character.id, name: character.name },
    historyGeneration: thread.historyCompactionGeneration,
  };
  if (!session?.engineSessionId || !session.engineInstanceId)
    return { ...base, status: "uninitialized", inspection: null };
  let inspection: ConversationEngineInspection;
  try {
    inspection = await engine.inspect(
      {
        userId: session.engineUserId,
        sessionId: session.engineSessionId,
        instanceId: session.engineInstanceId,
        characterId: character.id,
      },
      signal,
    );
  } catch (error) {
    return mapEngineError(error);
  }
  // Recheck after external I/O so an in-flight archive or binding change cannot return old state.
  const current = await resolveBinding(deps.prisma, actor, botId);
  if (
    current.thread.id !== thread.id ||
    current.thread.historyCompactionGeneration !== thread.historyCompactionGeneration ||
    current.bot.erosCharacterId !== character.id ||
    current.session?.id !== session.id ||
    current.session.engineSessionId !== session.engineSessionId ||
    current.session.engineInstanceId !== session.engineInstanceId ||
    current.session.engineUserId !== session.engineUserId
  )
    throw new ORPCError("CONFLICT", { message: "The conversation changed. Refresh its state." });
  return { ...base, status: "ready", inspection };
}

export async function updateConversationEngineState(
  deps: Deps,
  actor: Actor,
  input: UpdateConversationEngineState,
  signal?: AbortSignal,
): Promise<ConversationEngineState> {
  assertEnabled(deps);
  const initial = await resolveBinding(deps.prisma, actor, input.botId);
  let remoteAttempted = false;
  try {
    await deps.prisma.$transaction(
      async (tx) => {
        // Same lock order as send/finalization; block a new turn until the remote CAS finishes.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${initial.thread.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
        const { bot, thread, session } = await resolveBinding(tx, actor, input.botId);
        if (
          thread.id !== initial.thread.id ||
          thread.historyCompactionGeneration !== input.historyGeneration
        )
          throw new ORPCError("CONFLICT", {
            message: "The conversation changed. Refresh its state.",
          });
        const engine = deps.conversationEngines?.get("eros");
        if (!engine?.updateState || !engine.characters.some(({ id }) => id === bot.erosCharacterId))
          throw new ORPCError("BAD_REQUEST", { message: "Engine state editing is unavailable." });
        if (!session?.engineSessionId || !session.engineInstanceId)
          throw new ORPCError("CONFLICT", {
            message: "Start a conversation before changing engine state.",
          });
        await tx.$queryRaw`SELECT id FROM companion_sessions WHERE id = ${session.id} FOR UPDATE`;
        const locked = await tx.companionSession.findFirst({
          where: {
            id: session.id,
            botId: bot.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: thread.id,
            historyGeneration: input.historyGeneration,
            status: "active",
          },
        });
        if (
          !locked ||
          locked.engineSessionId !== session.engineSessionId ||
          locked.engineInstanceId !== session.engineInstanceId ||
          locked.engineUserId !== session.engineUserId ||
          (locked.leaseExpiresAt && locked.leaseExpiresAt.getTime() > Date.now())
        )
          throw new ORPCError("CONFLICT", {
            message: "Wait for the current reply before changing engine state.",
          });
        const [run, pending] = await Promise.all([
          tx.run.findFirst({
            where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            select: { id: true },
          }),
          tx.companionTurn.findFirst({
            where: { sessionId: session.id, status: { in: ["submitted", "uncertain"] } },
            select: { id: true },
          }),
        ]);
        if (run || pending)
          throw new ORPCError("CONFLICT", {
            message: "Wait for the current reply before changing engine state.",
          });
        remoteAttempted = true;
        await engine.updateState(
          {
            userId: locked.engineUserId,
            sessionId: session.engineSessionId,
            instanceId: session.engineInstanceId,
            characterId: bot.erosCharacterId!,
            expectedRevision: input.expectedRevision,
            axes: input.axes,
            warmthGrade: input.warmthGrade,
            patienceGrade: input.patienceGrade,
            ...(input.elapsedHours === undefined ? {} : { elapsedHours: input.elapsedHours }),
          },
          signal,
        );
      },
      { maxWait: 5_000, timeout: 40_000 },
    );
  } catch (error) {
    if (remoteAttempted && !(error instanceof ConversationEngineError))
      return mapEngineError(new ConversationEngineError("uncertain"), true);
    return mapEngineError(error, true);
  }
  try {
    return await loadConversationEngineState(deps, actor, input.botId, signal);
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    throw new ORPCError("BAD_GATEWAY", {
      message: "Engine state was saved. Refresh to see its current state.",
    });
  }
}
