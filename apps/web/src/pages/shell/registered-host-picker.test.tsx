// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(async () => []), register: vi.fn() }));
vi.mock("../../lib/space-rpc", () => {
  const client = { hosts: api };
  return { useSpaceRpc: () => client };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { RegisteredHostPicker } from "./registered-host-picker";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("closing registration fences a late returned host selection", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const changed = vi.fn();
  let complete: (value: unknown) => void = () => {};
  api.register.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => {
    root.render(<RegisteredHostPicker value={null} onChange={changed} />);
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => {
    button("Register host").click();
  });
  for (const [label, value] of [
    ["Host name", "Build"],
    ["Host URL", "https://host.example.test"],
    ["Host token", "ab".repeat(32)],
  ]) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  await act(async () => {
    button("Register").click();
  });
  expect(api.register).toHaveBeenCalledOnce();
  await act(async () => {
    button("Register host").click();
  });
  await act(async () => {
    complete({
      id: "late",
      name: "Build",
      endpoint: "https://host.example.test",
      revokedAt: null,
      healthStatus: "unchecked",
      healthCheckedAt: null,
    });
  });
  expect(changed).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]')).toBeNull();
});
