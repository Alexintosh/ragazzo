// @vitest-environment jsdom
import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useComposerActions } from "./use-composer-actions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../../lib/user-error", () => ({ errorText: (cause: Error) => cause.message }));
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useComposerActions>;
let props: ComponentProps<typeof Harness>;
const methods = { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), react: vi.fn() };
const refresh = vi.fn(async () => snapshot);
const updateSnapshot = vi.fn();
const snapshot = {
  threadId: "task-thread",
  botId: "bot",
  cursor: 0,
  messages: [],
  olderCursor: null,
  run: null,
} as ThreadSnapshot;
function Harness({ taskId }: { taskId?: string }) {
  const activeBotId = useRef<string | undefined>("bot");
  const activeGroupId = useRef<string | undefined>(undefined);
  latest = useComposerActions({
    rpc: { threads: methods } as unknown as ReturnType<typeof createSpaceRpc>,
    activeId: "bot",
    inGroup: false,
    groupId: undefined,
    taskId,
    activeBotId,
    activeGroupId,
    botsRef: useRef([]),
    bootstrapMe: null,
    activeSnapshot: snapshot,
    navigate: vi.fn(),
    refreshBots: vi.fn(async () => {}),
    refreshThreadRef: useRef(refresh),
    refreshGroupThreadRef: useRef(refresh),
    updateSnapshot,
    terminalRunReceipts: useRef(new Set()),
    computerRef: useRef(null),
    commitComputer: vi.fn(),
    clearReadBoundary: vi.fn(),
    flushPendingBrowserNotifications: vi.fn(),
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  methods.send.mockResolvedValue({ runId: "run", taskId: "task" });
  methods.stop.mockResolvedValue({ ok: true });
  methods.answer.mockResolvedValue({ ok: true });
  methods.react.mockResolvedValue({ ok: true });
  props = { taskId: "task" };
  act(() => root.render(<Harness {...props} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("scopes followups, stop, answers, and reactions to the task conversation", async () => {
  await act(async () => {
    expect(await latest.sendMessage("Follow up", [], "send-nonce")).toBe(true);
  });
  expect(methods.send).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: "task", text: "Follow up" }),
  );
  expect(methods.send.mock.calls[0]![0]).not.toHaveProperty("botId");
  await act(async () => latest.stopRun());
  expect(methods.stop).toHaveBeenCalledWith({ taskId: "task" });
  const message = { id: "ask", runId: "run" } as ThreadMessage;
  await act(async () => latest.answerMessage(message, "Paris"));
  expect(methods.answer).toHaveBeenCalledWith({
    taskId: "task",
    runId: "run",
    messageId: "ask",
    answer: "Paris",
  });
  await act(async () => latest.reactToMessage(message, "👍"));
  expect(methods.react).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: "task", messageId: "ask", reaction: "👍" }),
  );
});

it("does not apply a late stop response to another task on the same bot", async () => {
  let resolveStop!: () => void;
  methods.stop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveStop = resolve;
      }),
  );
  let stopping!: Promise<void>;
  act(() => {
    stopping = latest.stopRun();
  });
  act(() => root.render(<Harness taskId="other-task" />));
  await act(async () => {
    resolveStop();
    await stopping;
  });
  expect(updateSnapshot).not.toHaveBeenCalled();
});
