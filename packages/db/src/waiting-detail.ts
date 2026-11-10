import type { WaitingDetail } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import {
  isApprovalAskBlock,
  isSecretAskBlock,
  TAKEOVER_COMPUTER_PENDING_STATE,
} from "@rakazo/core";

type WaitingRun = { id: string; status: string; threadId: string; botId: string };
type WaitingMessage = { id: string; runId: string | null; blocks: unknown };
type WaitingEffect = { id: string; runId: string; kind: string; status: string };

/** Messages are newest first, matching findPendingAsk and the existing answer operation. */
export function deriveRunWaitingDetail(input: {
  run: WaitingRun;
  messages: readonly WaitingMessage[];
  effects: readonly WaitingEffect[];
  canTakeover?: boolean;
}): WaitingDetail | undefined {
  const { run } = input;
  if (run.status !== "waiting_input" && run.status !== "waiting_takeover") return undefined;
  const generic: WaitingDetail = { reason: "waiting", runId: run.id };
  for (const message of input.messages) {
    if (message.runId !== run.id) continue;
    const parsed = MessageBlock.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    if (run.status === "waiting_takeover") {
      if (
        parsed.data.some(
          (block) => block.kind === "computer" && block.state === TAKEOVER_COMPUTER_PENDING_STATE,
        )
      )
        return {
          reason: "takeover",
          runId: run.id,
          messageId: message.id,
          ...(input.canTakeover ? { action: "takeover" as const } : {}),
        };
      continue;
    }
    const ask = parsed.data.find((block) => block.kind === "ask" && block.status !== "answered");
    if (ask?.kind !== "ask") continue;
    const reference = { runId: run.id, messageId: message.id };
    if (isApprovalAskBlock(ask)) {
      if (
        !ask.nativeApproval &&
        !input.effects.some(
          (effect) =>
            effect.id === ask.approvalEffectId &&
            effect.runId === run.id &&
            effect.status === "intended",
        )
      )
        return generic;
      return { ...reference, reason: "approval", action: "review_approval" };
    }
    // An unrecognized approval card must never become an ordinary text question.
    if (ask.approvalEffectId || ask.nativeApproval) return generic;
    if (isSecretAskBlock(ask)) return { ...reference, reason: "secret", action: "provide_secret" };
    return { ...reference, reason: "question", action: "answer" };
  }
  return generic;
}
