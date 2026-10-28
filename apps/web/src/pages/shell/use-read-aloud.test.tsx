// @vitest-environment jsdom
import type { Bot, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpeechSnapshot } from "../../lib/tts";
import { useReadAloud } from "./use-read-aloud";

const speech = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  stop: vi.fn(),
  subscribe: vi.fn((_listener: (state: SpeechSnapshot) => void) => () => {}),
}));
vi.mock("../../lib/tts", () => ({ speaker: speech }));
vi.mock("@rakazo/ui-web", () => ({ toast: { error: vi.fn() } }));

const bot = {
  id: "bot-1",
  autoSpeak: true,
  botKind: "roleplay",
  roleplayCharacter: { conversationStyle: "chat" },
} as Bot;
const reply = (id: string, text: string): ThreadMessage => ({
  id,
  role: "bot",
  threadId: "thread-1",
  seq: 1,
  botId: bot.id,
  runId: "run-1",
  blocks: [{ kind: "text", text }],
  createdAt: "2026-01-01T00:00:00Z",
});
const snapshot = (messages: ThreadMessage[], status = "completed"): ThreadSnapshot =>
  ({
    botId: bot.id,
    threadId: "thread-1",
    cursor: 0,
    olderCursor: null,
    messages,
    run: { id: "run-1", status },
  }) as ThreadSnapshot;
let root: Root;
let latest: ReturnType<typeof useReadAloud>;
function Harness({
  snap,
  active = bot,
  callBotId,
}: {
  snap: ThreadSnapshot;
  active?: Bot;
  callBotId?: string;
}) {
  latest = useReadAloud({
    active,
    snapshot: snap,
    callBotId,
    activeBotId: useRef<string | undefined>(active.id),
  });
  return null;
}
async function render(snap: ThreadSnapshot, active = bot, callBotId?: string) {
  await act(async () => root.render(<Harness snap={snap} active={active} callBotId={callBotId} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("reads every completed chat bubble together and does not replay a refreshed snapshot", async () => {
  await render(snapshot([]));
  const messages = [reply("one", "First."), reply("two", "Second."), reply("three", "Third.")];
  await render(snapshot(messages, "running"));
  expect(speech.speak).not.toHaveBeenCalled();
  await render(snapshot(messages));
  expect(speech.speak).toHaveBeenCalledExactlyOnceWith("First.\n\nSecond.\n\nThird.", {
    botId: bot.id,
    messageId: "three",
  });
  await render(snapshot([...messages]));
  expect(speech.speak).toHaveBeenCalledTimes(1);
});

it("seeds an existing burst on initial load and when switching bots", async () => {
  const messages = [reply("one", "First."), reply("two", "Second.")];
  await render(snapshot(messages));
  const other = { ...bot, id: "bot-2" };
  await render(
    { ...snapshot(messages.map((message) => ({ ...message, botId: other.id }))), botId: other.id },
    other,
  );
  expect(speech.speak).not.toHaveBeenCalled();
});

it("consumes replies during a call or with auto-speak off without replaying them later", async () => {
  await render(snapshot([]));
  await render(snapshot([reply("one", "First.")]), bot, bot.id);
  await render(snapshot([reply("one", "First.")]), bot);
  await render(snapshot([reply("two", "Second.")]), { ...bot, autoSpeak: false });
  await render(snapshot([reply("two", "Second.")]));
  expect(speech.speak).not.toHaveBeenCalled();
});

it("keeps manual read-aloud to the requested bubble", async () => {
  const message = reply("one", "Only this bubble.");
  await render(snapshot([message]));
  act(() => latest.speakMessage(message));
  expect(speech.speak).toHaveBeenCalledExactlyOnceWith("Only this bubble.", {
    botId: bot.id,
    messageId: "one",
  });
});

it("lets the existing read-aloud toggle stop a combined burst", async () => {
  await render(snapshot([]));
  const messages = [reply("one", "First."), reply("two", "Second.")];
  await render(snapshot(messages));
  const listener = speech.subscribe.mock.calls[0]![0];
  act(() => listener({ status: "speaking", botId: bot.id, messageId: "two" }));
  act(() => latest.speakMessage(messages[1]!));
  expect(speech.stop).toHaveBeenCalledOnce();
  expect(speech.speak).toHaveBeenCalledTimes(1);
});
