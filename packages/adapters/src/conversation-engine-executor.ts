import { randomUUID } from "node:crypto";
import type { ConversationEngine } from "@rakazo/adapter-kit";
import { ConversationEngineError, runContinueJob } from "@rakazo/adapter-kit";
import { displayName, redactSecrets } from "@rakazo/core";
import type { CompanionSession, CompanionTurn, Run } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { renewRunLease } from "./run-lifecycle.js";
import {
  completionNotificationPreview,
  notifyRun,
  runSendsFinishNotification,
} from "./run-notifications.js";

const LEASE_MS = 5 * 60_000;

export function conversationEngineInput(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new Error("Conversation engines support text messages only");
  const parts: string[] = [];
  for (const block of blocks) {
    if (block?.kind === "meta") continue;
    if (block?.kind !== "text" || typeof block.text !== "string")
      throw new Error("Conversation engines support text messages only");
    parts.push(block.text);
  }
  const text = parts.join("\n\n");
  if (!text.trim() || [...text].length > 4096)
    throw new Error("Engine messages must contain between 1 and 4096 characters");
  return text;
}

/** A remote engine has its own commit boundary. Persist identity and request BEFORE I/O.
 * Stop detaches delivery; it cannot roll back the remote transcript or memory. */
export async function executeConversationEngineRun(
  deps: ExecutorDeps,
  run: Run,
  ownership: { workerId: string; fence: number },
  onRunStarted?: () => void,
): Promise<void> {
  const { workerId, fence } = ownership;
  const attempt = await deps.prisma.attempt.create({
    data: { runId: run.id, fence, status: "running" },
  });
  const controller = new AbortController();
  const signal = deps.shutdownSignal
    ? AbortSignal.any([controller.signal, deps.shutdownSignal])
    : controller.signal;
  let botName = "Bot";
  let session: CompanionSession | null = null;
  let ownsSession = false;
  let checking = false;
  let lastRenewed = Date.now();
  const sessionFence = () => ({ id: session!.id, leaseRunId: run.id, leaseFence: fence });
  async function checkOwnership() {
    if (checking) return;
    checking = true;
    try {
      const current = await deps.prisma.run.findUnique({ where: { id: run.id } });
      if (
        current?.status !== "running" ||
        current.leaseOwner !== workerId ||
        current.leaseFence !== fence
      )
        controller.abort();
      if (!signal.aborted && Date.now() - lastRenewed > 30_000) {
        if (!(await renewRunLease(deps, run.id, workerId, fence))) controller.abort();
        if (ownsSession) {
          const renewed = await deps.prisma.companionSession.updateMany({
            where: sessionFence(),
            data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
          });
          if (!renewed.count) controller.abort();
        }
        lastRenewed = Date.now();
      }
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  }
  const heartbeat = setInterval(() => {
    void checkOwnership();
  }, 1000);
  heartbeat.unref?.();
  const finalize = async (outcome: "completed" | "failed", response?: string, error?: string) => {
    const result = await deps.events.finalizeRun({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: workerId,
      leaseFence: fence,
      ...(outcome === "completed"
        ? {
            outcome: "completed" as const,
            blocks: [{ kind: "text" as const, text: response ?? "" }],
          }
        : { outcome: "failed" as const, error: error ?? "Conversation engine failed" }),
    });
    if (!result) return;
    if (result.continuationRunId) await deps.jobs.enqueue(runContinueJob(result.continuationRunId));
    if (!result.suppressed && !result.continuationRunId && runSendsFinishNotification(run.trigger))
      await notifyRun(deps, run, {
        kind: outcome === "completed" ? "completion" : "failure",
        title: `${displayName(botName, "Bot")} ${outcome === "completed" ? "finished" : "failed"}`,
        body:
          outcome === "completed"
            ? completionNotificationPreview(response ?? "")
            : (error ?? "Conversation engine failed"),
        botId: run.botId,
        threadId: run.threadId,
      });
  };
  try {
    const [bot, thread, task] = await Promise.all([
      deps.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } }),
      deps.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } }),
      deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
    ]);
    if (
      !deps.roleplayEnabled ||
      bot.botKind !== "roleplay" ||
      bot.conversationEngine !== "eros" ||
      !bot.erosCharacterId ||
      bot.computerId ||
      bot.runtimeKind !== "pi" ||
      bot.spaceId !== run.spaceId ||
      bot.userId !== run.userId ||
      thread.spaceId !== run.spaceId ||
      thread.userId !== run.userId ||
      thread.groupId ||
      thread.externalConversationId ||
      (thread.botId ?? thread.taskBotId) !== bot.id ||
      task.botId !== bot.id ||
      task.threadId !== thread.id ||
      task.spaceId !== run.spaceId ||
      !["user", "follow_up"].includes(run.trigger)
    )
      throw new Error("This engine supports direct text conversations only");
    botName = bot.name;
    const engine = deps.conversationEngines?.get(bot.conversationEngine);
    if (!engine) throw new Error("This conversation engine is unavailable");
    const started = await deps.prisma.run.updateMany({
      where: { id: run.id, status: "running", leaseOwner: workerId, leaseFence: fence },
      data: { startedAt: run.startedAt ?? new Date() },
    });
    if (!started.count) return;
    onRunStarted?.();
    const bindingKey = {
      threadId: thread.id,
      historyGeneration: thread.historyCompactionGeneration,
    };
    session = await deps.prisma.companionSession.upsert({
      where: { threadId_historyGeneration: bindingKey },
      update: {},
      create: {
        ...bindingKey,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        engineUserId: randomUUID(),
      },
    });
    if (
      session.spaceId !== run.spaceId ||
      session.userId !== run.userId ||
      session.botId !== bot.id
    )
      throw new Error("Conversation engine identity mismatch");
    const acquired = await deps.prisma.companionSession.updateMany({
      where: {
        id: session.id,
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: new Date() } },
          { leaseRunId: run.id, leaseFence: { lt: fence } },
        ],
      },
      data: {
        leaseRunId: run.id,
        leaseFence: fence,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    if (!acquired.count)
      throw new Error("The engine is still processing a previous message. Try again shortly.");
    ownsSession = true;
    if (!session.engineSessionId) {
      const provisioned = await engine.provision(
        { userId: session.engineUserId, characterId: bot.erosCharacterId },
        signal,
      );
      const updated = await deps.prisma.companionSession.updateMany({
        where: sessionFence(),
        data: { engineSessionId: provisioned.sessionId, engineInstanceId: provisioned.instanceId },
      });
      if (!updated.count) throw new Error("Conversation engine session ownership changed");
      session = {
        ...session,
        engineSessionId: provisioned.sessionId,
        engineInstanceId: provisioned.instanceId,
      };
    }
    // Recover accepted but locally unfinished turns before submitting anything new. Never
    // mint a new upstream ID when acceptance is uncertain (including Stop and restarts).
    const pending = await deps.prisma.companionTurn.findMany({
      where: {
        sessionId: session.id,
        runId: { not: run.id },
        status: { in: ["submitted", "uncertain"] },
      },
      orderBy: { createdAt: "asc" },
    });
    for (const previous of pending) await settle(engine, previous);
    let turn = await deps.prisma.companionTurn.findUnique({ where: { runId: run.id } });
    if (!turn) {
      const steering =
        run.trigger === "follow_up"
          ? await deps.events.claimSteering({
              threadId: thread.id,
              botId: bot.id,
              runId: run.id,
              leaseOwner: workerId,
              leaseFence: fence,
              seenIds: [],
              initial: true,
            })
          : [];
      const rows = await deps.prisma.message.findMany({
        where: {
          threadId: thread.id,
          role: "user",
          ...(steering.length
            ? { id: { in: steering.map((item) => item.messageId) } }
            : run.sourceMessageId
              ? { id: run.sourceMessageId }
              : { runId: run.id }),
        },
        orderBy: { seq: "asc" },
        select: { blocks: true },
      });
      const input = conversationEngineInput(
        rows.flatMap((row) => (Array.isArray(row.blocks) ? row.blocks : [row.blocks])),
      );
      turn = await deps.prisma.companionTurn.create({
        data: {
          runId: run.id,
          sessionId: session.id,
          spaceId: run.spaceId,
          userId: run.userId,
          clientMessageId: randomUUID(),
          input,
        },
      });
    }
    if (turn.sessionId !== session.id || turn.spaceId !== run.spaceId || turn.userId !== run.userId)
      throw new Error("Conversation engine turn ownership mismatch");
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      type: "run.started",
      payload: { trigger: run.trigger, routineId: null },
    });
    const response = await settle(engine, turn);
    await checkOwnership();
    signal.throwIfAborted();
    await finalize("completed", redactSecrets(response, deps.secrets));
  } catch (error) {
    if (!signal.aborted) {
      const message =
        error instanceof ConversationEngineError
          ? error.code === "duplicate_in_progress" || error.code === "uncertain"
            ? "The engine is still processing a previous message. Try again shortly."
            : "The conversation engine could not complete this message."
          : error instanceof Error
            ? error.message
            : "Conversation engine failed";
      await finalize("failed", undefined, redactSecrets(message, deps.secrets));
    }
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    if (ownsSession)
      await deps.prisma.companionSession.updateMany({
        where: sessionFence(),
        data: { leaseRunId: null, leaseFence: null, leaseExpiresAt: null },
      });
  }

  async function settle(engine: ConversationEngine, turn: CompanionTurn): Promise<string> {
    if (turn.status === "completed" && turn.response != null) return turn.response;
    if (turn.status === "failed") throw new ConversationEngineError("duplicate_failed");
    await checkOwnership();
    signal.throwIfAborted();
    await deps.prisma.companionTurn.update({
      where: { id: turn.id, session: { leaseRunId: run.id, leaseFence: fence } },
      data: { status: "submitted" },
    });
    try {
      let final: string | undefined;
      for await (const event of engine.stream(
        {
          userId: session!.engineUserId,
          sessionId: session!.engineSessionId!,
          clientMessageId: turn.clientMessageId,
          text: turn.input,
        },
        signal,
      )) {
        if (event.type === "final") {
          if (event.ghost || event.truncated || !event.text.trim())
            throw new ConversationEngineError("failed");
          final = event.text;
        }
      }
      if (final === undefined) throw new ConversationEngineError("uncertain", true);
      await deps.prisma.companionTurn.update({
        where: { id: turn.id, session: { leaseRunId: run.id, leaseFence: fence } },
        data: { status: "completed", response: final, error: null },
      });
      return final;
    } catch (error) {
      const definite =
        error instanceof ConversationEngineError &&
        ["invalid_request", "duplicate_failed", "failed"].includes(error.code);
      await deps.prisma.companionTurn.update({
        where: { id: turn.id, session: { leaseRunId: run.id, leaseFence: fence } },
        data: {
          status: definite ? "failed" : "uncertain",
          error: definite ? "Engine rejected this turn" : "Awaiting engine reconciliation",
        },
      });
      throw error;
    }
  }
}
