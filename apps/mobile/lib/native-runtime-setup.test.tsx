// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rpc: vi.fn(), generation: 1, spaceId: "space" }));
vi.mock("./api", () => ({
  rpc: api.rpc,
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: api.generation,
  }),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => api.spaceId,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => api.generation }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Linking: { openURL: vi.fn() },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));

import { NativeRuntimeSetup } from "../components/native-runtime-setup";

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
  api.generation = 1;
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
it("prepares the same host-specific sign-in plan on mobile", async () => {
  api.rpc.mockResolvedValue(status);
  const f = mount();
  await act(async () =>
    f.root.render(<NativeRuntimeSetup spaceId="space" kind="codex" hostId="host-a" />),
  );
  expect(api.rpc).not.toHaveBeenCalled();
  await act(async () => f.button("Set up runtime").click());
  api.rpc.mockResolvedValue({ ...status, session });
  await act(async () => f.button("Prepare sign-in").click());
  expect(api.rpc).toHaveBeenLastCalledWith(
    "nativeSetup/request",
    { hostId: "host-a", kind: "codex", action: "login" },
    expect.objectContaining({ requestContext: expect.anything() }),
  );
  expect(f.container.textContent).toContain("Approve in the host terminal");
  expect(f.container.textContent).toContain(session.localApproval);
});
it("never shows a late device challenge after the authenticated session changes", async () => {
  api.rpc.mockResolvedValue(status);
  const f = mount();
  await act(async () =>
    f.root.render(<NativeRuntimeSetup spaceId="space" kind="codex" hostId="host-a" />),
  );
  await act(async () => f.button("Set up runtime").click());
  let complete: (value: unknown) => void = () => {};
  api.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => f.button("Prepare sign-in").click());
  api.generation++;
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
});
it("refreshes and permits new actions after closing and reopening during a pending action", async () => {
  api.rpc.mockResolvedValue(status);
  const f = mount();
  await act(async () =>
    f.root.render(<NativeRuntimeSetup spaceId="space" kind="codex" hostId="host-a" />),
  );
  await act(async () => f.button("Set up runtime").click());
  let completeOld: (value: unknown) => void = () => {};
  let completeNew: (value: unknown) => void = () => {};
  api.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeOld = resolve;
      }),
  );
  await act(async () => f.button("Prepare sign-in").click());
  expect(f.button("Prepare sign-in").disabled).toBe(true);
  await act(async () => f.button("Set up runtime").click());
  await act(async () => f.button("Set up runtime").click());
  expect(f.container.textContent).toContain("Sign-in required");
  expect(f.button("Prepare sign-in").disabled).toBe(false);
  api.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeNew = resolve;
      }),
  );
  await act(async () => f.button("Prepare sign-in").click());
  await act(async () =>
    completeOld({ ...status, session: { ...session, state: "running", userCode: "ABCD-EFGH" } }),
  );
  expect(f.container.textContent).not.toContain("ABCD-EFGH");
  expect(f.button("Prepare sign-in").disabled).toBe(true);
  await act(async () => completeNew({ ...status, session }));
  expect(f.container.textContent).toContain("Approve in the host terminal");
  expect(f.button("Cancel setup").disabled).toBe(false);
});
