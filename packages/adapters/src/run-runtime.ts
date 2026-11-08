import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";

export function runtimeForBot(
  deps: Pick<ExecutorDeps, "runtime" | "runtimes">,
  bot: { runtimeKind?: string; executionTarget?: string; projectPath?: string | null },
): AgentRuntime {
  if (!bot.runtimeKind || bot.runtimeKind === "pi") return deps.runtime;
  if (!["codex", "claude", "acp"].includes(bot.runtimeKind))
    throw new Error("Unsupported agent runtime");
  if (bot.executionTarget !== "host" || !bot.projectPath)
    throw new Error("Codex requires a host computer and a project folder");
  const runtime = deps.runtimes?.[bot.runtimeKind as "codex" | "claude" | "acp"];
  if (!runtime) throw new Error("Native Codex requires a configured local host");
  return runtime;
}

/** Read the persisted answer ID, never infer approval from a model prompt or translated label. */
export async function nativeRuntimeAnswer(
  prisma: PrismaClient,
  run: { id: string; threadId: string; botId: string },
  options: { interactionId?: string; ordinaryQuestion?: boolean } = {},
): Promise<AgentRunRequest["resumeToolResult"]> {
  const messages = await prisma.message.findMany({
    where: { runId: run.id, threadId: run.threadId, botId: run.botId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 20,
    select: { blocks: true },
  });
  for (const message of messages) {
    const parsed = MessageBlock.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const ask = parsed.data.find((block) => block.kind === "ask");
    if (ask?.kind !== "ask") continue;
    if (options.interactionId && ask.nativeInteractionId !== options.interactionId)
      return undefined;
    if (options.ordinaryQuestion && (isApprovalAskBlock(ask) || isSecretAskBlock(ask)))
      return undefined;
    if (ask.status !== "answered" || typeof ask.answer !== "string") return undefined;
    return { content: [{ type: "text", text: ask.answer }] };
  }
  return undefined;
}
