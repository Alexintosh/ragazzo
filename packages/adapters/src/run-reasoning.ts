import { randomUUID } from "node:crypto";
import { createStreamingRedactor, isBackgroundRunTrigger } from "@rakazo/core";
import type { RunContext } from "./run-context.js";

/** Bounded, throttled summaries use the run's existing secret and lease boundaries. */
export function createRunReasoning(ctx: RunContext) {
  let id = randomUUID();
  let redactor: ReturnType<typeof createStreamingRedactor> | undefined;
  let text = "";
  let received = false;
  let lastFlush = 0;
  let lastText = "";
  const publish = async (done: boolean) => {
    if (!received || (!done && (Date.now() - lastFlush < 350 || text === lastText))) return;
    lastFlush = Date.now();
    lastText = text;
    await ctx.deps.events.append({
      spaceId: ctx.run.spaceId,
      threadId: ctx.run.threadId,
      botId: ctx.bot.id,
      runId: ctx.runId,
      type: "agent.reasoning",
      lease: { owner: ctx.workerId, fence: ctx.fence },
      payload: { id, text, done },
    });
  };
  return {
    async push(delta: string) {
      if (
        ctx.scripted ||
        isBackgroundRunTrigger(ctx.run.trigger) ||
        ctx.run.trigger === "bot_message"
      )
        return;
      received = true;
      // Redact before truncation, including secret values split across provider chunks.
      redactor ??= createStreamingRedactor(ctx.secrets);
      text = (text + redactor.push(delta)).slice(0, 16_384);
      await publish(false);
    },
    async finish() {
      if (!received) return;
      text = (text + redactor!.finish()).slice(0, 16_384);
      await publish(true);
      id = randomUUID();
      redactor = undefined;
      text = "";
      lastText = "";
      received = false;
      lastFlush = 0;
    },
  };
}
