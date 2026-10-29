// @vitest-environment jsdom
import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, useMemo, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { Transcript } from "./transcript";
import type { ComputerState } from "./use-computer";
import { useThreadState } from "./use-thread-state";
import { useThreadSync } from "./use-thread-sync";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query", () => ({ queryClient: {} }));
vi.mock("@rakazo/core/query", () => ({ fetchFresh: async () => [] }));
vi.mock("../../lib/performance", () => ({ markOnce: () => {} }));
vi.mock("./message-view", () => ({ MessageView: () => <div>Message</div> }));
vi.mock("../../components/ai/CollaborationMarker", () => ({ ActiveBotGlyph: () => null }));
vi.mock("../../components/call/VoiceChatCard", () => ({ VoiceChatCard: () => null }));

const noop = () => {};
const resolved = async () => {};
const get = vi.fn();
let host: HTMLDivElement;
let root: Root;
let latest: { thread: ReturnType<typeof useThreadState>; sync: ReturnType<typeof useThreadSync> };
let metrics: { scrollHeight: number; clientHeight: number; scrollTop: number };
let frames: FrameRequestCallback[];
let scrollTo: ReturnType<typeof vi.fn>;

function message(seq: number, role: ThreadMessage["role"] = "bot"): ThreadMessage {
  return {
    id: `message-${seq}`,
    threadId: "thread",
    seq,
    role,
    createdAt: "2026-01-01T00:00:00Z",
    blocks: [{ kind: "text", text: `Message ${seq}` }],
  };
}

function snapshot(messages = [message(1)]): ThreadSnapshot {
  return {
    threadId: "thread",
    botId: "bot",
    cursor: messages.length,
    messages,
    olderCursor: null,
    run: null,
  };
}

function Harness({ group = false }: { group?: boolean }) {
  const thread = useThreadState();
  const activeBotId = useRef<string | undefined>(group ? undefined : "bot");
  const activeGroupId = useRef<string | undefined>(group ? "group" : undefined);
  const computerRef = useRef(null);
  const computerOpenRef = useRef(false);
  const computerBotIdRef = useRef(null);
  const sync = useThreadSync({
    rpc: { threads: { get } } as unknown as ReturnType<typeof createSpaceRpc>,
    queries: {
      routines: { list: { queryOptions: noop } },
      skills: { list: { queryOptions: noop } },
    } as unknown as SpaceQueries,
    thread,
    computerState: {
      computerRef,
      computerOpenRef,
      computerBotIdRef,
      commitComputer: noop,
      cacheComputerFor: noop,
      refreshComputerScreen: resolved,
    } as unknown as ComputerState,
    seed: undefined,
    // The test drives completed refreshes directly; no live subscription or RPC transport.
    active: undefined,
    activeGroup: undefined,
    inGroup: group,
    groupId: undefined,
    activeBotId,
    activeGroupId,
    botsRef: useRef([]),
    searchParamsRef: useRef(new URLSearchParams()),
    refreshBots: resolved,
    notifyBrowserForEvent: noop,
    markBotReadIfVisible: noop,
    markGroupReadOnReply: noop,
  });
  latest = { thread, sync };
  const transcript = useMemo(
    () => foldPeerReplies(thread.snapshot?.messages ?? [], { includePeerReceipts: true }),
    [thread.snapshot?.messages],
  );
  const [draft, setDraft] = useState("");
  const props: ComponentProps<typeof Transcript> = {
    scrollRef: thread.messageScroll,
    scrollRequest: null,
    onScrollRequestHandled: noop,
    artifactTarget: { botId: "bot" },
    transcript,
    showToolActivity: false,
    olderCursor: null,
    unreadAfterSeq: null,
    loadingOlder: false,
    answerableAskIds: new Set(),
    dismissableAskIds: new Set(),
    running: false,
    workingBots: [],
    onLoadOlder: noop,
    onOpenBot: noop,
    onAnswer: resolved,
    onReply: noop,
    onMarkUnread: noop,
    onQuote: noop,
    onReact: resolved,
    onJumpToMessage: noop,
    onOpenPeerMessages: noop,
    peerBot: () => undefined,
    onRefresh: resolved,
    onBotChanged: resolved,
    onAddRoutine: noop,
    voiceReady: false,
    speakingMessageId: null,
    onSpeak: noop,
    onOpenComputer: noop,
  };
  return (
    <>
      <Transcript key={thread.snapshot?.threadId} {...props} />
      <textarea
        aria-label="Draft"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
    </>
  );
}

function transcript() {
  return host.querySelector<HTMLDivElement>('[data-testid="transcript"]')!;
}

function scroll(top: number) {
  metrics.scrollTop = top;
  act(() => transcript().dispatchEvent(new Event("scroll", { bubbles: true })));
}

function readAboveEnd(top = 450) {
  act(() => transcript().dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true })));
  scroll(top);
}

function typeDraft() {
  const textarea = host.querySelector("textarea")!;
  textarea.focus();
  textarea.value = "An unsent draft";
  act(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
}

function flushFrames() {
  act(() => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  metrics = { scrollHeight: 1_000, clientHeight: 500, scrollTop: 0 };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  for (const key of ["scrollHeight", "clientHeight", "scrollTop"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "transcript" ? metrics[key] : 0;
    });
  }
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (
    this: HTMLElement,
    value,
  ) {
    if (this.dataset.testid === "transcript") {
      metrics.scrollTop = Math.min(value, metrics.scrollHeight - metrics.clientHeight);
    }
  });
  scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  get.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
});

it.each([
  { name: "bot", group: false },
  { name: "group", group: true },
])("keeps a reader's position while typing through a $name refresh", async ({ group }) => {
  act(() => root.render(<Harness group={group} />));
  act(() =>
    latest.thread.commitSnapshot({ ...snapshot(), ...(group ? { groupId: "group" } : {}) }),
  );
  expect(metrics.scrollTop).toBe(500);
  readAboveEnd();
  typeDraft();
  get.mockResolvedValue({ ...snapshot(), ...(group ? { groupId: "group" } : {}) });
  await act(async () => {
    if (group) await latest.sync.refreshGroupThread("group");
    else await latest.sync.refreshThread("bot");
  });
  flushFrames();
  expect(metrics.scrollTop).toBe(450);
  expect(host.querySelector("textarea")?.value).toBe("An unsent draft");
});

it("keeps a reader who scrolls away while a refresh is in flight", async () => {
  act(() => root.render(<Harness />));
  act(() => latest.thread.commitSnapshot(snapshot()));
  let finish!: (next: ThreadSnapshot) => void;
  get.mockImplementation(
    () =>
      new Promise<ThreadSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  let refreshing!: Promise<ThreadSnapshot>;
  act(() => {
    refreshing = latest.sync.refreshThread("bot");
  });
  readAboveEnd();
  typeDraft();
  await act(async () => {
    finish(snapshot([message(1), message(2)]));
    await refreshing;
  });
  flushFrames();
  expect(metrics.scrollTop).toBe(450);
});

it("resumes following after an explicit jump to latest", () => {
  act(() => root.render(<Harness />));
  act(() => latest.thread.commitSnapshot(snapshot()));
  readAboveEnd(100);
  const jumpButton = host.querySelector<HTMLButtonElement>('button[aria-label="Jump to latest"]')!;
  act(() => jumpButton.click());
  expect(metrics.scrollTop).toBe(500);
  metrics.scrollHeight = 1_100;
  act(() => latest.thread.commitSnapshot(snapshot([message(1), message(2)])));
  expect(metrics.scrollTop).toBe(600);
});

it("does not re-arm following on a no-motion scroll event while drafting", () => {
  act(() => root.render(<Harness />));
  act(() => latest.thread.commitSnapshot(snapshot()));
  readAboveEnd();
  typeDraft();
  // Layout/queued scroll events can arrive at the same offset without a reader scroll down.
  scroll(450);
  act(() => latest.thread.commitSnapshot(snapshot([message(1), message(2)])));
  expect(metrics.scrollTop).toBe(450);
});

it("initially opens at the end, follows new messages, and resumes after scrolling down", () => {
  act(() => root.render(<Harness />));
  act(() => latest.thread.commitSnapshot(snapshot()));
  expect(metrics.scrollTop).toBe(500);
  metrics.scrollHeight = 1_100;
  act(() => latest.thread.commitSnapshot(snapshot([message(1), message(2, "user")])));
  expect(metrics.scrollTop).toBe(600);
  readAboveEnd(100);
  typeDraft();
  act(() => latest.thread.commitSnapshot(snapshot([message(1), message(2), message(3)])));
  expect(metrics.scrollTop).toBe(100);
  scroll(550);
  metrics.scrollHeight = 1_200;
  act(() =>
    latest.thread.commitSnapshot(snapshot([message(1), message(2), message(3), message(4)])),
  );
  expect(metrics.scrollTop).toBe(700);
});
