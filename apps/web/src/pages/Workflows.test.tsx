// @vitest-environment jsdom
import type { WorkflowGraph } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: unknown }) => children,
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));
vi.mock("../lib/query", () => ({ useSpaceQueries: vi.fn() }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));

import { WorkflowCanvas } from "./Workflows";

let root: Root;
let container: HTMLDivElement;
const graph: WorkflowGraph = {
  nodes: [
    { id: "a", label: "Research", botId: "one", prompt: "Research", x: 40, y: 40 },
    { id: "b", label: "Review", botId: "two", prompt: "Review", x: 280, y: 200 },
  ],
  edges: [{ from: "a", to: "b" }],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("renders directed dependencies and supports selection and keyboard layout editing", async () => {
  const onSelect = vi.fn();
  const onMove = vi.fn();
  await act(async () =>
    root.render(<WorkflowCanvas graph={graph} selected="a" onSelect={onSelect} onMove={onMove} />),
  );
  expect(container.querySelectorAll('path[marker-end="url(#workflow-arrow)"]')).toHaveLength(1);
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    button.click();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(onSelect).toHaveBeenCalledWith("a");
  expect(onMove).toHaveBeenCalledWith("a", 60, 40);
});
it("makes persisted run snapshots selectable without allowing layout mutation", async () => {
  const onSelect = vi.fn();
  await act(async () =>
    root.render(<WorkflowCanvas graph={graph} selected={null} onSelect={onSelect} />),
  );
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  expect(onSelect).toHaveBeenCalledWith("a");
  expect(button.className).not.toContain("cursor-grab");
});
