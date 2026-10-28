// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../lib/space-rpc", () => {
  const client = { nativeSetup: api };
  return { useSpaceRpc: () => client };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import { NativeRuntimeSetup } from "./native-runtime-setup";

const status = {
  kind: "codex",
  available: true,
  authenticated: false,
  managed: false,
  installSupported: true,
  loginSupported: true,
};
const session = {
  id: "11111111-1111-4111-8111-111111111111",
  action: "login",
  state: "awaiting-consent",
  expiresAt: "2099-01-01T00:00:00Z",
  command: ["codex", "login", "--device-auth"],
  destination: "/host-data",
  localApproval: "pnpm host:setup --session 11111111-1111-4111-8111-111111111111",
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((row) => row.textContent === text)!;
  return { root, container, button };
}
it("progressively prepares a host-local plan without granting installation/login permission", async () => {
  api.request.mockResolvedValue(status);
  const f = mount();
  await act(async () => f.root.render(<NativeRuntimeSetup kind="codex" hostId="host-a" />));
  expect(api.request).not.toHaveBeenCalled();
  await act(async () => f.button("Set up runtime").click());
  api.request.mockResolvedValue({ ...status, session });
  await act(async () => f.button("Prepare sign-in").click());
  expect(api.request).toHaveBeenLastCalledWith({
    hostId: "host-a",
    kind: "codex",
    action: "login",
  });
  expect(f.container.textContent).toContain("Approve in the host terminal");
  expect(f.container.textContent).toContain(session.localApproval);
  expect(f.container.textContent).not.toContain("Device code");
  expect(f.container.querySelector("a")).toBeNull();
});
it("drops late setup and login challenge responses after selecting another host", async () => {
  api.request.mockResolvedValue(status);
  const f = mount();
  await act(async () => f.root.render(<NativeRuntimeSetup kind="codex" hostId="host-a" />));
  await act(async () => f.button("Set up runtime").click());
  let complete: (value: unknown) => void = () => {};
  api.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => f.button("Prepare sign-in").click());
  await act(async () => f.root.render(<NativeRuntimeSetup kind="codex" hostId="host-b" />));
  await act(async () =>
    complete({
      ...status,
      session: {
        ...session,
        state: "running",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      },
    }),
  );
  expect(f.container.textContent).not.toContain("ABCD-EFGH");
  expect(f.container.textContent).not.toContain(session.localApproval);
});
