// @vitest-environment jsdom
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Workflow, WorkflowNodeState, WorkflowRun } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  list: vi.fn(),
  bots: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  save: vi.fn(),
  start: vi.fn(),
  recover: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: unknown }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    workflows: {
      save: calls.save,
      start: calls.start,
      recover: calls.recover,
      cancel: calls.cancel,
    },
  },
}));
vi.mock("../lib/query", () => ({ useSpaceQueries: () => queries }));
vi.mock("../lib/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));

import { WorkflowsPage } from "./Workflows";

function makeQueries() {
  return createTanstackQueryUtils({
    workflows: { list: calls.list, runs: calls.runs, run: calls.run },
    bots: { list: calls.bots },
  });
}
let queries: ReturnType<typeof makeQueries>;
let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
const definition: Workflow = {
  id: "workflow-a",
  name: "Workflow A",
  revision: 1,
  graph: {
    nodes: [
      { id: "step", label: "Review", botId: "bot", prompt: "Review the project", x: 20, y: 20 },
    ],
    edges: [],
  },
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};
const node: WorkflowNodeState = {
  nodeId: "step",
  status: "failed",
  taskId: "task",
  runId: "execution",
  error: null,
};
const stopped: WorkflowRun = {
  ...definition,
  id: "workflow-run",
  workflowId: definition.id,
  status: "failed",
  nodes: [node],
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
const click = async (text: string) => {
  await act(async () => button(text).click());
  await flush();
};
function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkflowsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await flush();
  await click("Workflow A");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  calls.list.mockResolvedValue({
    workflows: [definition, { ...definition, id: "workflow-b", name: "Workflow B" }],
  });
  calls.bots.mockResolvedValue([{ id: "bot", name: "Writer" }]);
  calls.runs.mockResolvedValue({ runs: [] });
  calls.run.mockResolvedValue(stopped);
  queries = makeQueries();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
it("reuses the start receipt when a committed request loses its response", async () => {
  calls.start
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce({ ...stopped, status: "running" });
  await render();
  await click("Run");
  await click("Run");
  expect(calls.start).toHaveBeenCalledTimes(2);
  expect(calls.start.mock.calls[0]![0]).toEqual(calls.start.mock.calls[1]![0]);
  expect(calls.start.mock.calls[0]![0].clientNonce).toBeTruthy();
});
it("reuses the recovery receipt across an ambiguous transport failure", async () => {
  calls.runs.mockResolvedValue({ runs: [stopped] });
  calls.recover.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce(stopped);
  await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.includes("Failed"))!
      .click();
  });
  await flush();
  await click("ReviewFailed");
  await click("Recover step");
  await click("Recover step");
  expect(calls.recover).toHaveBeenCalledTimes(2);
  expect(calls.recover.mock.calls[0]![0]).toEqual(calls.recover.mock.calls[1]![0]);
});
it("locks selection and draft edits while saving, so the response cannot overwrite a different draft", async () => {
  let resolveSave: (value: Workflow) => void = () => undefined;
  calls.save.mockImplementation(
    () =>
      new Promise<Workflow>((resolve) => {
        resolveSave = resolve;
      }),
  );
  await render();
  const name = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]')!;
  await act(async () => fill(name, "Saved A"));
  await click("Save");
  expect(button("New workflow").matches(":disabled")).toBe(true);
  expect(button("Workflow B").matches(":disabled")).toBe(true);
  expect(name.matches(":disabled")).toBe(true);
  await click("Workflow B");
  await click("New workflow");
  expect(name.value).toBe("Saved A");
  await act(async () => resolveSave({ ...definition, name: "Saved A", revision: 2 }));
  await flush();
  expect(name.value).toBe("Saved A");
  expect(button("Run").disabled).toBe(false);
});
