// @vitest-environment jsdom
import type { ThreadQueue } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useThreadQueue } from "./use-thread-queue";

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useThreadQueue>;
const read = vi.fn();
const enqueue = vi.fn();
const rpc = { threads: { queue: read, enqueue } } as unknown as ReturnType<typeof createSpaceRpc>;
const snapshot = (revision: number): ThreadQueue => ({
  revision,
  entries: [],
  canSteer: false,
  waitingReason: "ready",
});
function deferred() {
  let resolve!: (value: ThreadQueue) => void;
  const promise = new Promise<ThreadQueue>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Harness({ botId }: { botId: string }) {
  current = useThreadQueue(rpc, botId, 0);
  return null;
}
async function render(botId: string) {
  await act(async () => root.render(<Harness botId={botId} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  read.mockReset();
  enqueue.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("ignores a late refresh older than an accepted mutation", async () => {
  const oldRead = deferred();
  read.mockReturnValueOnce(oldRead.promise);
  enqueue.mockResolvedValue(snapshot(8));
  await render("a");
  await act(async () => {
    await current.enqueue("later", "nonce");
  });
  expect(current.queue?.revision).toBe(8);
  await act(async () => oldRead.resolve(snapshot(4)));
  expect(current.queue?.revision).toBe(8);
});
it("does not display a request or error from a chat the user left", async () => {
  const pending = deferred();
  read.mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot(9));
  await render("a");
  await render("b");
  expect(current.queue?.revision).toBe(9);
  await act(async () => pending.resolve(snapshot(20)));
  expect(current.queue?.revision).toBe(9);
});

it("rereads on reconnect and drops a stale action at the same queue revision", async () => {
  const question: ThreadQueue = {
    ...snapshot(7),
    waitingReason: "approval",
    waitingDetail: { reason: "question", runId: "run", messageId: "ask", action: "answer" },
  };
  read.mockResolvedValue(question);
  await render("a");
  expect(current.waitingHref).toBe("/app/a?m=ask");
  read.mockResolvedValue({ ...question, waitingDetail: { reason: "waiting", runId: "run" } });
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(current.queue?.revision).toBe(7);
  expect(current.waitingHref).toBeUndefined();
});

it("does not let a late equal-revision read resurrect the old request", async () => {
  vi.useFakeTimers();
  const stale = deferred();
  const question: ThreadQueue = {
    ...snapshot(7),
    waitingReason: "approval",
    waitingDetail: { reason: "question", runId: "run", messageId: "ask", action: "answer" },
  };
  read
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue({ ...question, waitingDetail: { reason: "waiting", runId: "run" } });
  await render("a");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(current.waitingHref).toBeUndefined();
  await act(async () => stale.resolve(question));
  expect(current.queue?.waitingDetail?.reason).toBe("waiting");
});

it("rereads rejected queue mutations while retaining the server CAS revision", async () => {
  read.mockResolvedValue(snapshot(7));
  enqueue.mockRejectedValue(new Error("Queue changed"));
  await render("a");
  read.mockResolvedValue(snapshot(8));
  await act(async () => {
    expect(await current.enqueue("draft", "nonce")).toBe(false);
  });
  expect(current.queue?.revision).toBe(8);
  expect(current.error).toContain("Queue changed");
});
