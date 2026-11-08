import { describe, expect, it } from "vitest";
import { nextAutoSpeakAction } from "./auto-speak";

function textMessage(id: string, text: string) {
  return {
    id,
    role: "bot" as const,
    blocks: [{ kind: "text" as const, text }],
  };
}

describe("nextAutoSpeakAction", () => {
  const base = {
    botId: "bot-1",
    autoSpeak: true,
    focused: true,
    snapshotReady: true,
    lastSpokenBotId: "bot-1",
    lastSpokenMessageId: "msg-1",
    runStatus: "completed" as string | null,
    messages: [textMessage("msg-1", "Earlier."), textMessage("msg-2", "Hello from the bot.")],
  };

  it("seeds the latest reply when opening a bot so history is not spoken", () => {
    expect(
      nextAutoSpeakAction({
        ...base,
        lastSpokenBotId: null,
        lastSpokenMessageId: null,
      }),
    ).toEqual({ action: "seed", messageId: "msg-2" });
  });

  it("waits until the thread snapshot belongs to this bot", () => {
    expect(nextAutoSpeakAction({ ...base, snapshotReady: false })).toEqual({ action: "wait" });
  });

  it("seeds when autoSpeak is off so enabling later does not dump the last reply", () => {
    expect(nextAutoSpeakAction({ ...base, autoSpeak: false })).toEqual({
      action: "seed",
      messageId: "msg-2",
    });
  });

  it("waits while the thread is not focused instead of speaking in the background", () => {
    expect(nextAutoSpeakAction({ ...base, focused: false })).toEqual({ action: "wait" });
  });

  it("waits while a run is still in flight", () => {
    expect(nextAutoSpeakAction({ ...base, runStatus: "running" })).toEqual({ action: "wait" });
    expect(nextAutoSpeakAction({ ...base, runStatus: "queued" })).toEqual({ action: "wait" });
    expect(nextAutoSpeakAction({ ...base, runStatus: "leased" })).toEqual({ action: "wait" });
  });

  it("speaks a finished reply that has not been spoken yet", () => {
    expect(nextAutoSpeakAction(base)).toEqual({
      action: "speak",
      messageId: "msg-2",
      text: "Hello from the bot.",
    });
  });

  it("does not speak the same reply twice", () => {
    expect(nextAutoSpeakAction({ ...base, lastSpokenMessageId: "msg-2" })).toEqual({
      action: "wait",
    });
  });

  it("marks an empty reply spoken without playing it", () => {
    expect(
      nextAutoSpeakAction({
        ...base,
        messages: [textMessage("msg-2", "   ")],
      }),
    ).toEqual({ action: "seed", messageId: "msg-2" });
  });

  const burst = {
    ...base,
    combineRunReplies: true,
    runId: "run-2",
    messages: [
      { ...textMessage("msg-1", "Earlier."), runId: "run-1", botId: "bot-1" },
      { id: "user-2", role: "user", blocks: [] },
      { ...textMessage("msg-2", "First."), runId: "run-2", botId: "bot-1" },
      { ...textMessage("msg-3", "Second."), runId: "run-2", botId: "bot-1" },
      { ...textMessage("msg-4", "Third."), runId: "run-2", botId: "bot-1" },
    ],
  };

  it("speaks all unseen bubbles from the completed RP chat run in one request", () => {
    expect(nextAutoSpeakAction(burst)).toEqual({
      action: "speak",
      messageId: "msg-4",
      text: "First.\n\nSecond.\n\nThird.",
    });
    expect(nextAutoSpeakAction({ ...burst, lastSpokenMessageId: "msg-4" })).toEqual({
      action: "wait",
    });
  });

  it("does not replay a completed burst when opening or reconnecting to a chat", () => {
    expect(nextAutoSpeakAction({ ...burst, lastSpokenBotId: null })).toEqual({
      action: "seed",
      messageId: "msg-4",
    });
  });

  it("waits for completion even when all burst bubbles have arrived", () => {
    expect(nextAutoSpeakAction({ ...burst, runStatus: "running" })).toEqual({ action: "wait" });
  });

  it("keeps only the unseen part of a burst", () => {
    expect(nextAutoSpeakAction({ ...burst, lastSpokenMessageId: "msg-2" })).toEqual({
      action: "speak",
      messageId: "msg-4",
      text: "Second.\n\nThird.",
    });
  });

  it("does not merge other bots, earlier runs, earlier user turns, or progress blocks", () => {
    expect(
      nextAutoSpeakAction({
        ...burst,
        messages: [
          { ...textMessage("old-turn", "Old turn."), runId: "run-2", botId: "bot-1" },
          { id: "user-2", role: "user", blocks: [] },
          { ...textMessage("old-run", "Old run."), runId: "run-1", botId: "bot-1" },
          { ...textMessage("peer", "Other bot."), runId: "run-2", botId: "bot-2" },
          {
            id: "progress",
            role: "bot",
            runId: "run-2",
            botId: "bot-1",
            blocks: [{ kind: "progress", text: "Still working." }],
          },
          ...burst.messages.slice(2),
        ],
      }),
    ).toEqual({
      action: "speak",
      messageId: "msg-4",
      text: "First.\n\nSecond.\n\nThird.",
    });
  });

  it("preserves last-message behavior for agents and narrative RP", () => {
    expect(nextAutoSpeakAction({ ...burst, combineRunReplies: false })).toEqual({
      action: "speak",
      messageId: "msg-4",
      text: "Third.",
    });
  });

  it("does not speak an older run when the latest completed run has no reply", () => {
    expect(nextAutoSpeakAction({ ...burst, runId: "run-3" })).toEqual({
      action: "seed",
      messageId: "msg-4",
    });
  });
});
