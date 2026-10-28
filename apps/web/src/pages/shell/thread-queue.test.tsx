// @vitest-environment jsdom
import type { ThreadQueue } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    children,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string; children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { ThreadQueuePanel } from "./thread-queue";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof ThreadQueuePanel>;
const queue: ThreadQueue = {
  revision: 5,
  canSteer: true,
  waitingReason: "running",
  entries: ["first", "second"].map((id, position) => ({
    id,
    messageId: `m-${id}`,
    botId: "b",
    botName: "Ada",
    text: id,
    position,
    canSteer: true,
  })),
};
function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(<ThreadQueuePanel {...props} />));
}
function button(label: string, row = 0) {
  const item = container.querySelectorAll("li")[row]!;
  return [...item.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    queue,
    error: null,
    busy: false,
    update: vi.fn(async () => false),
    cancel: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    steer: vi.fn(async () => true),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("reorders and cancels by queue identity and revision; hides unsupported steering", () => {
  render();
  expect(button("Move up").disabled).toBe(true);
  act(() => button("Move down").click());
  expect(props.reorder).toHaveBeenCalledWith(["second", "first"], 5);
  act(() => button("Cancel", 1).click());
  expect(props.cancel).toHaveBeenCalledWith("second", 5);
  render({ queue: { ...queue, canSteer: false } });
  expect(container.textContent).not.toContain("Steer");
});
it("preserves the inline edit when a conflict refreshes or claims the entry", async () => {
  render();
  act(() => button("Edit").click());
  const input = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "my revision",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  render({ error: "Temporary refresh error", queue: { ...queue, revision: 6 } });
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(props.update).toHaveBeenCalledWith("first", 5, "my revision");
  render({ error: "Queue changed", queue: { ...queue, revision: 7, entries: [] } });
  expect(container.querySelector("textarea")?.value).toBe("my revision");
  expect(container.textContent).toContain("This message has left the queue.");
  expect(container.querySelector("form")).toBeNull();
});

it("keeps the expanded list and its actions available after saving and refreshing", async () => {
  render({ update: vi.fn(async () => true) });
  const details = container.querySelector("details")!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  act(() => button("Edit").click());
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(details.open).toBe(true);
  expect(container.querySelector("textarea")).toBeNull();
  expect(button("Move down").disabled).toBe(false);
  render({ queue: { ...queue, revision: 6 } });
  expect(details.open).toBe(true);
  act(() => button("Move down").click());
  expect(props.reorder).toHaveBeenCalledWith(["second", "first"], 6);
  act(() => {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  });
  render({ queue: { ...queue, revision: 7 } });
  expect(details.open).toBe(false);
});

it("promotes a queued entry with a stable identity when a response fails", async () => {
  const startTask = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValueOnce(undefined);
  render({ startTask });
  await act(async () => button("Start as task").click());
  expect(startTask).toHaveBeenCalledWith("first", 5, expect.any(String));
  expect(button("Start as task").disabled).toBe(false);
  await act(async () => button("Start as task").click());
  expect(startTask.mock.calls[1]).toEqual(startTask.mock.calls[0]);
});
