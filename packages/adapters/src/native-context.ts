import { createHash } from "node:crypto";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

/** A distinct, deterministic provider run; the logical application run remains unchanged. */
export function nativeIntroExecutionId(applicationRunId: string): string {
  return `intro-answer:${createHash("sha256").update(applicationRunId).digest("hex")}`;
}

export function nativeCheckpointBelongsToRun(
  checkpoint: { runId: string; introHandover?: { applicationRunId: string; phase: string } },
  applicationRunId: string,
): boolean {
  if (!checkpoint.introHandover) return checkpoint.runId === applicationRunId;
  return (
    checkpoint.introHandover.applicationRunId === applicationRunId &&
    checkpoint.runId ===
      (checkpoint.introHandover.phase === "ready"
        ? nativeIntroExecutionId(applicationRunId)
        : applicationRunId)
  );
}

/** Match executor history authorization, including turns intentionally isolated from history. */
export function nativeContextScope(
  run: {
    id: string;
    spaceId: string;
    userId: string;
    trigger: string;
  },
  channelId?: string,
): string {
  const surface =
    run.trigger === "routine" || run.trigger === "created"
      ? ["isolated", run.trigger, run.id]
      : channelId
        ? ["channel", channelId]
        : ["private"];
  return createHash("sha256")
    .update(JSON.stringify(["native-context-v1", run.spaceId, run.userId, ...surface]))
    .digest("hex");
}

export const NATIVE_HISTORY_MAX_BYTES = 128 * 1024;
const omitted = "[Earlier conversation context omitted to fit the runtime context limit.]\n\n";

/** The executor supplies authorized, redacted history; adapters must not reload wider threads. */
export function buildNativeHistory(
  history: AgentRunRequest["history"],
  options: { excludeMessageIds?: ReadonlySet<string>; maxBytes?: number } = {},
): string {
  const maxBytes = options.maxBytes ?? NATIVE_HISTORY_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > NATIVE_HISTORY_MAX_BYTES)
    throw new Error("Invalid native history budget");
  const messages = history.filter(
    (message) => !message.id || !options.excludeMessageIds?.has(message.id),
  );
  const parts: string[] = [];
  let remaining = maxBytes - Buffer.byteLength(omitted);
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const prefix = `${message.role}: `;
    const text = `${prefix}${message.content}`;
    const separatorBytes = parts.length ? 2 : 0;
    const bytes = Buffer.byteLength(text);
    if (bytes + separatorBytes <= remaining) {
      parts.unshift(text);
      remaining -= bytes + separatorBytes;
      continue;
    }
    truncated = true;
    const excerptPrefix = `${message.role} (end of message): `;
    const available = remaining - separatorBytes - Buffer.byteLength(excerptPrefix);
    if (available > 0) {
      const content = Buffer.from(message.content);
      let start = Math.max(0, content.length - available);
      // Do not split a UTF-8 code point at the start of the retained suffix.
      while (start < content.length && (content[start]! & 0xc0) === 0x80) start++;
      if (start < content.length) parts.unshift(excerptPrefix + content.subarray(start).toString());
    }
    break;
  }
  return `${truncated ? omitted : ""}${parts.join("\n\n")}`;
}
