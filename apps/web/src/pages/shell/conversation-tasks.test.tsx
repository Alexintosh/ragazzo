// @vitest-environment jsdom
import type { Bot, ConversationTask, StoppedConversationRun } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../lib/user-error", () => ({ errorText: (cause: Error) => cause.message }));

import { ConversationTasks } from "./conversation-tasks";

const source: StoppedConversationRun = {
  runId: "old-run",
  taskId: "old-task",
  botId: "ada",
  botName: "Ada",
  prompt: "Publish the example",
  status: "cancelled",
  error: null,
  recoveredTaskId: null,
  createdAt: "2026-01-01",
};
const task = {
  id: "successor",
  botId: "bea",
  prompt: "Review the already published example",
} as ConversationTask;
let root: Root;
let container: HTMLDivElement;
let recover: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let createScoped: ReturnType<typeof vi.fn>;
let onOpen: (task: ConversationTask) => void;
let props: ComponentProps<typeof ConversationTasks>;
const click = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === text)!.click();
async function render() {
  await act(async () => root.render(<ConversationTasks {...props} />));
}
async function expand() {
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}
function fill(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  recover = vi.fn().mockResolvedValue(task);
  create = vi.fn().mockResolvedValue(task);
  createScoped = vi.fn().mockResolvedValue(task);
  onOpen = vi.fn();
  props = {
    rpc: {
      tasks: { stopped: vi.fn().mockResolvedValue({ runs: [source] }), recover, create, createScoped },
    } as unknown as ReturnType<typeof createSpaceRpc>,
    target: { botId: "ada" },
    bots: [
      { id: "ada", name: "Ada" },
      { id: "bea", name: "Bea" },
    ] as Bot[],
    tasks: [],
    onOpen,
    onChanged: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reviews stopped work before starting a new execution on the selected bot", async () => {
  await render();
  await expand();
  await act(async () => click("Recover or reassign"));
  expect(recover).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Earlier actions may already have taken effect");
  expect(container.querySelector("textarea")!.value).toBe(source.prompt);
  act(() => {
    fill(container.querySelector("select")!, "bea");
    fill(container.querySelector("textarea")!, "Review the already published example");
  });
  await submit();
  expect(recover).toHaveBeenCalledWith({
    runId: "old-run",
    botId: "bea",
    text: "Review the already published example",
    clientNonce: expect.any(String),
  });
  expect(onOpen).toHaveBeenCalledWith(task);
});

it("preserves reviewed instructions and the request identity after a failed response", async () => {
  recover.mockRejectedValueOnce(new Error("Connection interrupted"));
  await render();
  await expand();
  await act(async () => click("Recover or reassign"));
  await submit();
  expect(container.querySelector("[role=alert]")!.textContent).toBe("Connection interrupted");
  expect(container.querySelector("textarea")!.value).toBe(source.prompt);
  await submit();
  expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0]);
});

it("opens an existing successor instead of offering another recovery", async () => {
  props.rpc.tasks.stopped = vi
    .fn()
    .mockResolvedValue({ runs: [{ ...source, recoveredTaskId: task.id }] });
  props.tasks = [task];
  await render();
  await expand();
  expect(container.textContent).not.toContain("Recover or reassign");
  act(() => click("Open recovery"));
  expect(onOpen).toHaveBeenCalledWith(task);
});

it("creates task work with explicit conversation provenance", async () => {
  props.target = { groupId: "group" };
  await render();
  await expand();
  act(() => click("New task"));
  act(() => fill(container.querySelector("textarea")!, "Prepare the example"));
  await submit();
  expect(create).toHaveBeenCalledWith({
    botId: "ada",
    text: "Prepare the example",
    originGroupId: "group",
    clientNonce: expect.any(String),
  });
});
it("creates a scoped task through the versioned route without falling back to whole-project execution", async () => {
  props.bots[0] = { ...props.bots[0]!, runtimeKind: "codex", runtimePermission: "workspace" };
  createScoped.mockRejectedValueOnce(new Error("Scoped tasks require an updated server"));
  await render();
  await expand();
  act(() => click("New task"));
  act(() => {
    fill(container.querySelector("textarea")!, "Work only in the selected folder");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project subdirectory"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "packages/editor");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(create).not.toHaveBeenCalled();
  expect(createScoped).toHaveBeenCalledWith(expect.objectContaining({ writeSubdirectory: "packages/editor" }));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("updated server");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Project subdirectory"]')!.value).toBe("packages/editor");
  await submit();
  expect(createScoped.mock.calls[1]).toEqual(createScoped.mock.calls[0]);
});
