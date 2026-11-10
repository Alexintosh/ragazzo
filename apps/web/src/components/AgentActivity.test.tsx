// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentActivityEntry } from "@rakazo/contracts";
import { AgentActivity } from "./AgentActivity";
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (value: TemplateStringsArray) => value[0] }),
}));
it("opens the flow, receives completion live, and keeps the user's disclosure choice", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const row: AgentActivityEntry = {
    id: "call",
    runId: "run",
    seq: 1,
    updatedSeq: 1,
    kind: "tool",
    label: "Read file",
    status: "running",
  };
  try {
    flushSync(() => root.render(<AgentActivity entries={[row]} />));
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Read file");
    flushSync(() =>
      root.render(
        <AgentActivity
          entries={[{ ...row, updatedSeq: 2, status: "error", text: "File missing" }]}
        />,
      ),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("File missing");
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
