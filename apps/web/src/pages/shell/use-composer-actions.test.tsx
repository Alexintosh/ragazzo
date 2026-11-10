// @vitest-environment jsdom
import type { Bot, ComputerStatus, Me, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { act, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useComposerActions } from "./use-composer-actions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
}));
vi.mock("../../lib/prepare-image", () => ({
  canPrepareImage: () => false,
  prepareImage: async (file: File) => file,
}));

type Rpc = {
  routines: { testRun: ReturnType<typeof vi.fn> };
  artifacts: { create: ReturnType<typeof vi.fn> };
  threads: { send: ReturnType<typeof vi.fn>; sendWithRoutines: ReturnType<typeof vi.fn> };
};

let rpc: Rpc;
let me: Me | null;
let navigate: ReturnType<typeof vi.fn>;
let root: Root;
let latest: ReturnType<typeof useComposerActions>;

function ref<T>(current: T) {
  return { current };
}

function Harness() {
  latest = useComposerActions({
    rpc: rpc as unknown as ReturnType<typeof createSpaceRpc>,
    activeId: "bot-1",
    inGroup: false,
    groupId: undefined,
    activeBotId: ref<string | undefined>("bot-1"),
    activeGroupId: ref<string | undefined>(undefined),
    botsRef: ref<Bot[]>([]),
    bootstrapMe: me,
    activeSnapshot: null,
    navigate: navigate as never,
    refreshBots: async () => undefined,
    refreshThreadRef: ref(async () => ({}) as ThreadSnapshot),
    refreshGroupThreadRef: ref(async () => ({}) as ThreadSnapshot),
    updateSnapshot: () => undefined,
    terminalRunReceipts: ref(new Set<string>()),
    computerRef: ref<ComputerStatus | null>(null),
    commitComputer: () => undefined,
    clearReadBoundary: () => undefined,
    flushPendingBrowserNotifications: () => undefined,
  });
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  me = null;
  navigate = vi.fn();
  rpc = {
    routines: { testRun: vi.fn() },
    artifacts: { create: vi.fn() },
    threads: { send: vi.fn(), sendWithRoutines: vi.fn() },
  };
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

it.each([undefined, 1, 8])(
  "uses the server attachment count with a fallback (%s)",
  (maxAttachmentsPerMessage) => {
    me = { maxAttachmentsPerMessage } as Me;
    act(() => root.render(<Harness />));
    const files = Array.from(
      { length: 9 },
      (_, i) => new File(["a"], `${i}.txt`, { type: "text/plain" }),
    );
    act(() => {
      latest.onAttachmentPick(files);
    });
    const limit = maxAttachmentsPerMessage ?? 4;
    expect(latest.activePendingAttachments).toHaveLength(limit);
    expect(latest.attachmentNotice).toContain(`max ${limit} attachments`);
  },
);

it("keeps an attachment added while a send is in flight", async () => {
  const fileA = new File(["a"], "a.txt", { type: "text/plain" });
  const fileB = new File(["b"], "b.txt", { type: "text/plain" });
  rpc.artifacts.create.mockImplementation(async ({ name }: { name: string }) => ({
    id: `artifact-${name}`,
  }));
  let finishSend!: () => void;
  rpc.threads.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  act(() => void latest.onAttachmentPick([fileA]));

  let sent!: Promise<boolean>;
  act(() => {
    sent = latest.sendMessage("", [], "nonce-1");
  });
  await flush();
  act(() => void latest.onAttachmentPick([fileB]));
  finishSend();
  await act(async () => void (await sent));

  expect(rpc.threads.send).toHaveBeenCalledWith(
    expect.objectContaining({ artifactIds: ["artifact-a.txt"] }),
  );
  expect(latest.activePendingAttachments.map((pending) => pending.file)).toEqual([fileB]);
});

const digest = { kind: "routine" as const, id: "routine-1", name: "digest" };
const review = { kind: "routine" as const, id: "routine-2", name: "review" };

async function send(text: string, mentions: (typeof digest)[]) {
  let accepted!: boolean;
  await act(async () => {
    accepted = await latest.sendMessage(text, mentions, "nonce-1");
  });
  return accepted;
}

it("sends text and routines as one request and gives the draft back when it fails", async () => {
  // Before, the routines ran on their own first, so a failed text send could not be retried.
  rpc.routines.testRun.mockResolvedValue({ runId: "routine-run" });
  rpc.threads.send.mockRejectedValue(new Error("offline"));
  rpc.threads.sendWithRoutines.mockRejectedValue(new Error("offline"));

  expect(await send("@digest @review and the notes", [digest, review])).toBe(false);

  expect(rpc.routines.testRun).not.toHaveBeenCalled();
  expect(rpc.threads.send).not.toHaveBeenCalled();
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledTimes(1);
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "bot-1",
      clientNonce: "nonce-1",
      routineIds: ["routine-1", "routine-2"],
      text: expect.stringContaining("and the notes"),
    }),
  );
});

it("clears the draft once the send with routines is accepted", async () => {
  rpc.threads.sendWithRoutines.mockResolvedValue({
    routineRunIds: ["routine-run"],
    send: { runId: "run-1", taskId: "task-1", seq: 1 },
  });

  expect(await send("@digest and the notes", [digest])).toBe(true);
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledTimes(1);
});

it("runs routines without text in one request", async () => {
  rpc.routines.testRun.mockImplementation(async ({ routineId }: { routineId: string }) => {
    if (routineId === review.id) throw new Error("offline");
    return { runId: "routine-run" };
  });
  rpc.threads.sendWithRoutines.mockRejectedValueOnce(new Error("offline"));

  expect(await send("@digest @review", [digest, review])).toBe(false);
  expect(rpc.routines.testRun).not.toHaveBeenCalled();
  expect(rpc.threads.sendWithRoutines).toHaveBeenCalledWith({
    botId: "bot-1",
    clientNonce: "nonce-1",
    routineIds: ["routine-1", "routine-2"],
  });

  rpc.threads.sendWithRoutines.mockResolvedValueOnce({ routineRunIds: ["a", "b"] });
  expect(await send("@digest @review", [digest, review])).toBe(true);
  expect(rpc.threads.send).not.toHaveBeenCalled();
});

it("opens a mentioned group without running anything", async () => {
  const team = { kind: "group" as const, id: "group-2", name: "Team" };
  let accepted!: boolean;
  await act(async () => {
    accepted = await latest.sendMessage("@Team", [team], "nonce-1");
  });

  expect(accepted).toBe(true);
  expect(navigate).toHaveBeenCalledWith("/app/g/group-2");
  expect(rpc.threads.sendWithRoutines).not.toHaveBeenCalled();
  expect(rpc.threads.send).not.toHaveBeenCalled();
});

describe("task conversations", () => {
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

  it("rereads the current task after a rejected answer and preserves its error", async () => {
    const rejected = new Error("Question already answered");
    methods.answer.mockRejectedValueOnce(rejected);
    refresh.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await act(async () => {
      await expect(
        latest.answerMessage({ id: "ask", runId: "run" } as ThreadMessage, "Paris"),
      ).rejects.toBe(rejected);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("preserves a late answer rejection without refreshing a different task", async () => {
    let rejectAnswer!: (error: Error) => void;
    methods.answer.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectAnswer = reject;
      }),
    );
    let answer!: Promise<void>;
    act(() => {
      answer = latest.answerMessage({ id: "ask", runId: "run" } as ThreadMessage, "Paris");
    });
    props = { taskId: "other-task" };
    act(() => root.render(<Harness {...props} />));
    const rejected = new Error("Question no longer pending");
    await act(async () => {
      rejectAnswer(rejected);
      await expect(answer).rejects.toBe(rejected);
    });
    expect(refresh).not.toHaveBeenCalled();
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
});
