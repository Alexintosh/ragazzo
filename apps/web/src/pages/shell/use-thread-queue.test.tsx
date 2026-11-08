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
