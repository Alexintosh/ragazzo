import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type {
  Actor,
  ConversationEngineActionOutcome,
  ConversationEngineActionResult,
  RunConversationEngineAction,
} from "@rakazo/contracts";
import {
  ConversationEngineActionOutcomeSchema,
  RunConversationEngineActionInput,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { conversationEngineSettings, resolveBinding } from "./conversation-engine-state.js";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "env" | "conversationEngines" | "events">;
const uncertain: ConversationEngineActionOutcome = { status: "uncertain", message: null };
const conflict = () =>
  new ORPCError("CONFLICT", { message: "Wait for the current engine operation to settle." });

/** Native actions may generate messages even after a disconnect. Admit and record
 * once before I/O; never replay an uncertain mutation (including inventory POST). */
export async function runConversationEngineAction(
  deps: Deps,
  actor: Actor,
  raw: RunConversationEngineAction,
  signal?: AbortSignal,
): Promise<ConversationEngineActionOutcome> {
  if (!deps.env.roleplayEnabled) throw new ORPCError("FORBIDDEN");
  const input = RunConversationEngineActionInput.parse(raw);
  const initial = await resolveBinding(deps.prisma, actor, input.botId);
  const engine = deps.conversationEngines?.get("eros");
  if (!engine?.characters.some((c) => c.id === initial.bot.erosCharacterId))
    throw new ORPCError("BAD_REQUEST");
  const supported =
    input.action.kind === "open"
      ? engine.openSession
      : input.action.kind === "event"
        ? engine.drawEvent
        : input.action.kind === "add_item"
          ? engine.addItem
          : engine.deleteItem;
  if (!supported)
    throw new ORPCError("BAD_REQUEST", { message: "This engine action is unavailable." });
  const leaseRunId = `action:${input.actionId}`;
  const admitted = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${initial.thread.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
    const { bot, thread } = await resolveBinding(tx, actor, input.botId);
    if (
      thread.id !== initial.thread.id ||
      thread.historyCompactionGeneration !== input.historyGeneration
    )
      throw conflict();
    const prior = await tx.companionAction.findFirst({ where: { id: input.actionId } });
    if (prior) {
      const request = prior.request as { action?: unknown };
      if (
        prior.spaceId !== actor.spaceId ||
        prior.userId !== actor.userId ||
        prior.botId !== bot.id ||
        prior.threadId !== thread.id ||
        prior.historyGeneration !== input.historyGeneration ||
        JSON.stringify(request.action) !== JSON.stringify(input.action)
      )
        throw conflict();
      if (prior.status === "failed")
        throw new ORPCError("BAD_REQUEST", {
          message: "The engine rejected this action. Start a new action after correcting it.",
        });
      return {
        replay:
          prior.status === "completed"
            ? ConversationEngineActionOutcomeSchema.parse(prior.response)
            : uncertain,
      };
    }
    const session = await tx.companionSession.upsert({
      where: {
        threadId_historyGeneration: {
          threadId: thread.id,
          historyGeneration: input.historyGeneration,
        },
      },
      update: {},
      create: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        historyGeneration: input.historyGeneration,
        engineUserId: randomUUID(),
      },
    });
    await tx.$queryRaw`SELECT id FROM companion_sessions WHERE id = ${session.id} FOR UPDATE`;
    const locked = await tx.companionSession.findUniqueOrThrow({ where: { id: session.id } });
    if (
      locked.status !== "active" ||
      locked.userId !== actor.userId ||
      locked.spaceId !== actor.spaceId ||
      locked.botId !== bot.id ||
      (locked.leaseExpiresAt && locked.leaseExpiresAt.getTime() > Date.now())
    )
      throw conflict();
    const [run, turn, action] = await Promise.all([
      tx.run.findFirst({
        where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      }),
      tx.companionTurn.findFirst({
        where: { sessionId: session.id, status: { in: ["submitted", "uncertain"] } },
      }),
      tx.companionAction.findFirst({
        where: { sessionId: session.id, status: { in: ["submitted", "uncertain"] } },
      }),
    ]);
    if (run || turn || action) throw conflict();
    const settings = conversationEngineSettings(bot).values;
    await tx.companionAction.create({
      data: {
        id: input.actionId,
        sessionId: session.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: thread.id,
        historyGeneration: input.historyGeneration,
        request: { version: 1, action: input.action, settings },
        status: "submitted",
      },
    });
    await tx.companionSession.update({
      where: { id: session.id },
      data: { leaseRunId, leaseFence: 0, leaseExpiresAt: new Date(Date.now() + 10 * 60_000) },
    });
    return { session: locked, settings, characterId: bot.erosCharacterId! };
  });
  if ("replay" in admitted) return admitted.replay!;
  const session = admitted.session;
  let attempted = false;
  try {
    let sessionId = session.engineSessionId;
    let instanceId = session.engineInstanceId;
    if (!sessionId || !instanceId) {
      const binding = await engine.provision(
        { userId: session.engineUserId, characterId: admitted.characterId },
        signal,
      );
      const stored = await deps.prisma.companionSession.updateMany({
        where: { id: session.id, leaseRunId, status: "active" },
        data: { engineSessionId: binding.sessionId, engineInstanceId: binding.instanceId },
      });
      if (stored.count !== 1) throw conflict();
      sessionId = binding.sessionId;
      instanceId = binding.instanceId;
    }
    const binding = {
      userId: session.engineUserId,
      sessionId,
      instanceId,
      characterId: admitted.characterId,
    };
    const action = input.action;
    let result: ConversationEngineActionResult = { message: null, event: null };
    attempted = true;
    if (action.kind === "open")
      result = await engine.openSession!(
        {
          ...binding,
          actionId: input.actionId,
          occasion: action.occasion,
          settings: admitted.settings,
        },
        signal,
      );
    else if (action.kind === "event")
      result = await engine.drawEvent!(
        { ...binding, actionId: input.actionId, kinds: action.kinds, settings: admitted.settings },
        signal,
      );
    else if (action.kind === "add_item")
      await engine.addItem!({ ...binding, kind: action.itemKind, name: action.name }, signal);
    else await engine.deleteItem!({ ...binding, itemId: action.itemId }, signal);
    const outcome: ConversationEngineActionOutcome = {
      status: "completed",
      message: result.message?.text ?? null,
    };
    const seq = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${initial.thread.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
      const current = await resolveBinding(tx, actor, input.botId);
      if (
        current.thread.id !== initial.thread.id ||
        current.thread.historyCompactionGeneration !== input.historyGeneration ||
        current.session?.id !== session.id ||
        current.session.engineSessionId !== sessionId ||
        current.session.engineInstanceId !== instanceId ||
        current.session.leaseRunId !== leaseRunId
      )
        throw conflict();
      let eventSeq: number | undefined;
      if (result.message) {
        const nonce = `eros:${sessionId}:${result.message.id}`;
        const existing = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: initial.thread.id, clientNonce: nonce } },
        });
        if (!existing) {
          const blocks = [{ kind: "text" as const, text: result.message.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: initial.thread.id,
            botId: input.botId,
            role: "bot",
            clientNonce: nonce,
            blocks,
          });
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: initial.thread.id,
            botId: input.botId,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "bot", blocks },
          });
          eventSeq = event.seq;
        }
      }
      await tx.companionAction.update({
        where: { id: input.actionId },
        data: { status: "completed", response: outcome },
      });
      await tx.companionSession.updateMany({
        where: { id: session.id, leaseRunId },
        data: { leaseRunId: null, leaseFence: null, leaseExpiresAt: null },
      });
      return eventSeq;
    });
    if (seq !== undefined) await deps.events.notify(initial.thread.id, seq).catch(() => {});
    return outcome;
  } catch (error) {
    const rejected =
      error instanceof ConversationEngineError &&
      ["invalid_request", "failed", "unavailable", "busy", "conflict"].includes(error.code);
    // Leave a submitted row fail-closed if this cleanup also loses its DB connection.
    await deps.prisma.companionAction
      .updateMany({
        where: { id: input.actionId, status: "submitted" },
        data: { status: attempted && !rejected ? "uncertain" : "failed" },
      })
      .catch(() => {});
    await deps.prisma.companionSession
      .updateMany({
        where: { id: session.id, leaseRunId },
        data: { leaseRunId: null, leaseFence: null, leaseExpiresAt: null },
      })
      .catch(() => {});
    if (rejected)
      throw new ORPCError("BAD_REQUEST", {
        message: "The engine rejected this action. Check its configuration and try again.",
      });
    if (!attempted)
      throw new ORPCError("BAD_GATEWAY", {
        message: "The engine could not start this conversation.",
      });
    return uncertain;
  }
}
