// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  overview: vi.fn(),
  policy: vi.fn(),
  tariffs: vi.fn(),
  accounts: vi.fn(),
  journal: vi.fn(),
  costReport: vi.fn(),
  adjustment: vi.fn(),
  updateAllowance: vi.fn(),
  updatePolicy: vi.fn(),
  updateTariff: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { creditAdmin: api } }));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({ me: { queryOptions: () => ({ queryKey: ["me"], queryFn: api.me }) } }),
}));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => <p>Loading</p> }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
    i18n: { locale: "en-US" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Switch: ({
      checked,
      onCheckedChange,
      disabled,
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      disabled: boolean;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        disabled={disabled}
      />
    ),
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    buttonVariants: () => "",
  };
});

import { AdminCreditsPage } from "./AdminCreditsPage";

const account = {
  organizationId: "org-1",
  name: "Sample workspace",
  mode: "managed",
  balanceMicros: "120000",
  dailyAllowanceMicros: null,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.me.mockResolvedValue({ isAdmin: true });
  api.overview.mockResolvedValue({
    accountCount: 2,
    balanceMicros: "120000",
    pendingCount: 1,
    pendingMicros: "2000",
  });
  api.policy.mockResolvedValue({
    enabled: true,
    defaultDailyAllowanceMicros: "10000",
    dailyGrantBudgetMicros: "100000",
  });
  api.tariffs.mockResolvedValue([
    { provider: "example", model: "example-model", multiplierBps: 15000 },
  ]);
  api.accounts.mockResolvedValue({ accounts: [account], nextCursor: "org-1" });
  api.journal.mockResolvedValue({
    events: [
      {
        id: "event-1",
        kind: "adjustment",
        organizationId: "org-1",
        amountMicros: "120000",
        provider: null,
        model: null,
        actorId: "admin-1",
        reason: "Support adjustment",
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  });
  api.costReport.mockResolvedValue({
    from: "2026-11-01",
    to: "2026-11-02",
    rows: [
      {
        provider: "example",
        model: "example-model",
        providerCostUsd: 0.01,
        chargedMicros: "15000",
        pendingMicros: "2000",
        knownCostCount: 1,
        unknownCostCount: 2,
        pendingCount: 1,
      },
    ],
  });
  api.adjustment.mockResolvedValue({ ok: true });
  api.updateAllowance.mockResolvedValue({ ok: true });
  api.updatePolicy.mockImplementation(async (input) => input);
  api.updateTariff.mockImplementation(async (input) => input);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/admin/credits"]}>
          <Routes>
            <Route path="/admin/credits" element={<AdminCreditsPage />} />
            <Route path="/app" element={<p>Home</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.textContent === "Home" || container.textContent?.includes("Known provider cost"),
    ).toBe(true);
  });
}
function button(name: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
function field(label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("label")]
    .find((node) => node.textContent?.trim() === label)
    ?.querySelector("input, textarea");
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement))
    throw new Error(`Missing field ${label}`);
  return found;
}
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("never requests deployment credit data for a non-admin", async () => {
  api.me.mockResolvedValue({ isAdmin: false });
  await render();
  expect(container.textContent).toBe("Home");
  expect(api.accounts).not.toHaveBeenCalled();
  expect(api.policy).not.toHaveBeenCalled();
});
it("shows cost uncertainty separately from charged and pending credits and paginates accounts", async () => {
  await render();
  expect(container.textContent).toContain("Known provider cost");
  expect(container.textContent).toContain("Unknown cost");
  expect(container.textContent).toContain("Pending credits");
  expect(container.textContent).toContain("Support adjustment");
  await act(async () => button("Next page").click());
  expect(api.accounts).toHaveBeenLastCalledWith({ query: undefined, cursor: "org-1", limit: 25 });
});
it("requires explicit revocation confirmation and reuses its key after an uncertain result", async () => {
  api.adjustment.mockRejectedValueOnce(new Error("Network interrupted"));
  await render();
  await act(async () => button("Manage").click());
  const dialog = container.querySelector('[role="dialog"]')!;
  await fill(field("Credit adjustment", dialog), "-12.345");
  await fill(field("Reason", dialog), "Duplicate grant");
  await act(async () => button("Review revocation", dialog).click());
  expect(api.adjustment).not.toHaveBeenCalled();
  await act(async () => button("Confirm revocation", dialog).click());
  expect(dialog.textContent).toContain("Network interrupted");
  await act(async () => button("Confirm revocation", dialog).click());
  expect(api.adjustment).toHaveBeenCalledTimes(2);
  const [first, retry] = api.adjustment.mock.calls.map(([input]) => input);
  expect(first).toEqual({
    organizationId: "org-1",
    amountMicros: "-12345",
    reason: "Duplicate grant",
    idempotencyKey: expect.any(String),
  });
  expect(retry).toEqual(first);
  expect(dialog.textContent).toContain("Adjustment recorded");
});
it("blocks duplicate submits while a grant is pending and rejects fractional micros", async () => {
  let finish!: (value: { ok: true }) => void;
  api.adjustment.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("Manage").click());
  const dialog = container.querySelector('[role="dialog"]')!;
  await fill(field("Credit adjustment", dialog), "1.0001");
  await fill(field("Reason", dialog), "Support grant");
  expect(button("Grant credits", dialog).disabled).toBe(true);
  await fill(field("Credit adjustment", dialog), "1.001");
  const form = button("Grant credits", dialog).form!;
  await act(async () => {
    form.requestSubmit();
    form.requestSubmit();
  });
  expect(api.adjustment).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true }));
});
it("saves daily allowance defaults and audited tariffs in exact units", async () => {
  await render();
  const tariff = [...container.querySelectorAll("section")].find((section) =>
    section.textContent?.includes("Save tariff"),
  )!;
  await fill(field("Provider", tariff), "example");
  await fill(field("Model", tariff), "new-model");
  await fill(field("Cost multiplier", tariff), "1.2345");
  await fill(field("Reason", tariff), "Pricing update");
  await act(async () => button("Save tariff", tariff).click());
  expect(api.updateTariff).toHaveBeenCalledWith({
    provider: "example",
    model: "new-model",
    multiplierBps: 12345,
    reason: "Pricing update",
    idempotencyKey: expect.any(String),
  });
  await act(async () => button("Manage").click());
  const dialog = container.querySelector('[role="dialog"]')!;
  const form = button("Save allowance", dialog).form!;
  await fill(field("Reason", form), "Use deployment allowance");
  await act(async () => button("Save allowance", dialog).click());
  expect(api.updateAllowance).toHaveBeenCalledWith({
    organizationId: "org-1",
    dailyAllowanceMicros: null,
    reason: "Use deployment allowance",
    idempotencyKey: expect.any(String),
  });
});
