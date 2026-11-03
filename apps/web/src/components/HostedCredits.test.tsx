// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  status: vi.fn(),
  tariffs: vi.fn(),
  billing: vi.fn(),
  selectFunding: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    hostedCredits: { status: api.status, tariffs: api.tariffs },
    billing: { status: api.billing, selectFunding: api.selectFunding },
  },
}));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({ billing: { selectFunding: api.selectFunding } }),
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    me: { key: () => ["me"], queryOptions: () => ({ queryKey: ["me"], queryFn: api.me }) },
    bootstrap: { key: () => ["bootstrap"] },
    models: { key: () => ["models"] },
    billing: {
      key: () => ["billing"],
      status: { queryOptions: () => ({ queryKey: ["billing", "status"], queryFn: api.billing }) },
    },
    hostedCredits: {
      key: () => ["hosted"],
      status: { queryOptions: () => ({ queryKey: ["hosted", "status"], queryFn: api.status }) },
      tariffs: { queryOptions: () => ({ queryKey: ["hosted", "tariffs"], queryFn: api.tariffs }) },
    },
  }),
}));
vi.mock("./ModelCredits", () => ({ ModelCreditsSettings: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
    i18n: { locale: "en-US" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: () => null,
}));

import { BillingSettingsPanel } from "../pages/BillingSettingsPanel";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.me.mockResolvedValue({ hostedCreditsEnabled: true, billingEnabled: false, isAdmin: false });
  api.status.mockResolvedValue({
    enabled: true,
    available: true,
    balanceMicros: "12345",
    dailyAllowanceMicros: "5000",
    dailyGrantedMicros: "5000",
    nextGrantAt: "2026-11-03T00:00:00.000Z",
  });
  api.billing.mockResolvedValue({ funding: "credits", canManage: true });
  api.selectFunding.mockResolvedValue({ url: null });
  api.tariffs.mockResolvedValue([
    { provider: "example", model: "example-model", multiplierBps: 15000 },
  ]);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <BillingSettingsPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.textContent).toContain("12.345");
    },
    { timeout: 10_000 },
  );
}
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find((row) => row.textContent === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
it("shows exact hosted balance and daily renewal without Stripe purchases or operator controls", async () => {
  await render();
  expect(host.textContent).toContain("5 credits daily");
  expect(host.textContent).toContain("Renews");
  expect(host.textContent).not.toContain("Add credits");
  expect(host.querySelector('a[href="/admin/credits"]')).toBeNull();
  expect(api.billing).toHaveBeenCalled();
  const rates = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Model rates",
  );
  expect(rates).toBeDefined();
  await act(async () => rates!.click());
  expect(host.textContent).toContain("1.5×");
});

it("lets an owner switch from BYOK to credits and refreshes account, billing and model caches", async () => {
  api.status.mockResolvedValue({
    available: true,
    enabled: false,
    balanceMicros: "12345",
    dailyAllowanceMicros: "5000",
    dailyGrantedMicros: "0",
    nextGrantAt: null,
  });
  api.billing.mockResolvedValue({ funding: "byok", canManage: true });
  await render();
  const invalidation = vi.spyOn(cache, "invalidateQueries");
  api.selectFunding.mockImplementationOnce(async () => {
    api.billing.mockResolvedValue({ funding: "credits", canManage: true });
    api.status.mockResolvedValue({
      available: true,
      enabled: true,
      balanceMicros: "17345",
      dailyAllowanceMicros: "5000",
      dailyGrantedMicros: "5000",
      nextGrantAt: "2026-11-03T00:00:00Z",
    });
    return { url: null };
  });
  expect(button("Use Rakazo credits").disabled).toBe(false);
  await act(async () => button("Use Rakazo credits").click());
  expect(api.selectFunding).toHaveBeenCalledWith({ funding: "credits" });
  expect(invalidation.mock.calls.map(([input]) => input?.queryKey)).toEqual(
    expect.arrayContaining([["me"], ["bootstrap"], ["models"], ["billing"], ["hosted"]]),
  );
  expect(host.textContent).toContain("17.345");
  expect(button("Use my subscription or API key")).toBeDefined();
});
it("keeps a BYOK balance visible while paused and disables selecting hosted credits", async () => {
  api.status.mockResolvedValue({
    available: false,
    enabled: false,
    balanceMicros: "12345",
    dailyAllowanceMicros: "5000",
    dailyGrantedMicros: "0",
    nextGrantAt: null,
  });
  api.billing.mockResolvedValue({ funding: "byok", canManage: true });
  await render();
  expect(host.textContent).toContain("Hosted models are paused");
  expect(button("Use Rakazo credits").disabled).toBe(true);
  expect(api.selectFunding).not.toHaveBeenCalled();
});
it("hides funding changes from members without management permission", async () => {
  api.billing.mockResolvedValue({ funding: "byok", canManage: false });
  await render();
  expect(host.textContent).not.toContain("Use Rakazo credits");
  expect(host.textContent).not.toContain("Use my subscription or API key");
});
it("prevents duplicate funding submissions and reports a failed change", async () => {
  api.billing.mockResolvedValue({ funding: "byok", canManage: true });
  let fail!: (error: Error) => void;
  api.selectFunding.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await render();
  const select = button("Use Rakazo credits");
  await act(async () => {
    select.click();
    select.click();
  });
  expect(api.selectFunding).toHaveBeenCalledTimes(1);
  expect(select.disabled).toBe(true);
  await act(async () => fail(new Error("Funding change unavailable")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Funding change unavailable");
  expect(select.disabled).toBe(false);
});
