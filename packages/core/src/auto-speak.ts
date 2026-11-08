import type { MessageBlock } from "@rakazo/contracts";
import { speechFromBlocks } from "./speech-text.js";

const IN_PROGRESS_RUN_STATUSES = new Set(["running", "queued", "leased"]);

export type AutoSpeakMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
  botId?: string;
  runId?: string;
};

export type AutoSpeakDecision =
  | { action: "seed"; messageId: string | null }
  | { action: "wait" }
  | { action: "speak"; messageId: string; text: string };

/** Skip history and live progress; read a completed RP chat burst as one interruptible reply. */
export function nextAutoSpeakAction(input: {
  botId: string;
  autoSpeak: boolean;
  focused: boolean;
  snapshotReady: boolean;
  lastSpokenBotId: string | null;
  lastSpokenMessageId: string | null;
  runStatus?: string | null;
  runId?: string;
  combineRunReplies?: boolean;
  messages: ReadonlyArray<AutoSpeakMessage>;
}): AutoSpeakDecision {
  if (!input.snapshotReady) return { action: "wait" };
  const lastBot = [...input.messages]
    .reverse()
    .find((message) => message.role === "bot" && (!message.botId || message.botId === input.botId));
  const lastBotId = lastBot?.id ?? null;
  if (input.lastSpokenBotId !== input.botId || !input.autoSpeak) {
    return { action: "seed", messageId: lastBotId };
  }
  if (!input.focused) return { action: "wait" };
  if (input.runStatus && IN_PROGRESS_RUN_STATUSES.has(input.runStatus)) {
    return { action: "wait" };
  }
  if (!lastBot || lastBot.id === input.lastSpokenMessageId) return { action: "wait" };
  if (
    input.combineRunReplies &&
    input.runStatus === "completed" &&
    input.runId &&
    lastBot.runId &&
    lastBot.runId !== input.runId
  ) {
    return { action: "seed", messageId: lastBot.id };
  }
  let messages = [lastBot];
  if (
    input.combineRunReplies &&
    input.runStatus === "completed" &&
    input.runId &&
    lastBot.runId === input.runId &&
    lastBot.blocks.every((block) => block.kind === "text")
  ) {
    const spokenIndex = input.messages.findIndex(
      (message) => message.id === input.lastSpokenMessageId,
    );
    const userIndex = input.messages.findLastIndex((message) => message.role === "user");
    messages = input.messages
      .slice(Math.max(spokenIndex, userIndex) + 1)
      .filter(
        (message) =>
          message.role === "bot" &&
          message.botId === lastBot.botId &&
          message.runId === input.runId &&
          message.blocks.every((block) => block.kind === "text"),
      );
  }
  const text = messages
    .map((message) => speechFromBlocks(message.blocks).trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return { action: "seed", messageId: lastBot.id };
  return { action: "speak", messageId: lastBot.id, text };
}
