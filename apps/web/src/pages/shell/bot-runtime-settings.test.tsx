// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotRuntimeSettingsValue } from "./bot-runtime-settings";
import { BotRuntimeSettings } from "./bot-runtime-settings";

const mocks = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock("../../lib/space-rpc", () => ({
  useSpaceRpc: () => client,
}));
const client = { me: mocks.me };
vi.mock("./registered-host-picker", () => ({ RegisteredHostPicker: () => <div>Host picker</div> }));
vi.mock("./native-runtime-setup", () => ({ NativeRuntimeSetup: () => null }));
vi.mock("./project-folder-picker", () => ({ ProjectFolderPicker: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray) => parts.join(""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
let container: HTMLDivElement;
const initial: BotRuntimeSettingsValue = {
  runtimeKind: "pi",
  executionTarget: "default",
  runtimePermission: "workspace",
  projectPath: null,
  registeredHostId: null,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.me.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
async function render(value = initial) {
  function Form() {
    const [runtime, setRuntime] = useState(value);
    return <BotRuntimeSettings value={runtime} onChange={setRuntime} />;
  }
  await act(async () => root.render(<Form />));
}
function option(value: string) {
  return container.querySelector<HTMLOptionElement>(`[id$="-target"] option[value="${value}"]`)!;
}
async function choose(value: string) {
  await act(async () => {
    const target = container.querySelector<HTMLSelectElement>('[id$="-target"]')!;
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it.each(["desktop", "none", "daytona"])(
  "disables Docker for %s but leaves host and default usable",
  async (sandboxProvider) => {
    mocks.me.mockResolvedValue({ sandboxProvider });
    await render();
    expect(option("docker").disabled).toBe(true);
    expect(option("default").disabled).toBe(false);
    expect(option("host").disabled).toBe(false);
    expect(container.textContent).toContain("Docker is not enabled on this deployment.");
    await choose("host");
    expect(container.textContent).toContain("Host picker");
  },
);
it("enables Docker only after availability resolves", async () => {
  let resolve!: (me: { sandboxProvider: string }) => void;
  mocks.me.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  expect(option("docker").disabled).toBe(true);
  expect(container.textContent).toContain("Checking Docker availability…");
  await act(async () => resolve({ sandboxProvider: "docker" }));
  expect(option("docker").disabled).toBe(false);
  expect(container.textContent).not.toContain("Docker availability");
  await choose("docker");
  expect(container.querySelector<HTMLSelectElement>('[id$="-target"]')!.value).toBe("docker");
});
it("preserves an existing Docker target when the availability read fails", async () => {
  mocks.me.mockRejectedValue(new Error("offline"));
  await render({ ...initial, executionTarget: "docker" });
  expect(container.querySelector<HTMLSelectElement>('[id$="-target"]')!.value).toBe("docker");
  expect(option("docker").disabled).toBe(true);
  expect(container.textContent).toContain("Could not check Docker availability.");
  await choose("default");
  expect(container.querySelector<HTMLSelectElement>('[id$="-target"]')!.value).toBe("default");
});
