// @vitest-environment jsdom
import type { FarmingControlRiskReview } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../lib/rpc";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: () => null,
}));
vi.mock("../components/farming-control/navigation", () => ({ useFarmingChatSearch: () => "" }));
vi.mock("../components/farming-control/position-detail", () => ({ PositionDetail: () => null }));

import { FarmingControlPage } from "./FarmingControl";

const now = Date.UTC(2026, 10, 9, 10, 15);
const review: FarmingControlRiskReview = {
  state: "partial",
  fetchedAtMs: now,
  asOfMs: now,
  sources: [],
  issues: [],
  selectionStatus: "all_subjects",
  exposureAssociationStatus: "unproven",
  linkedExposure: null,
  evidence: {
    schemaVersion: "hot-monitoring-evidence.v1",
    asOfMs: now,
    window: "7d",
    requestedFromMs: now - 604800000,
    executionEligible: false,
    population: {
      configuredCount: 1,
      runningDesiredCount: 1,
      excludedStoppedCount: 0,
      basis: "all_desired_running_monitors",
    },
    items: [
      {
        monitorKey: "monitor-only",
        label: "Synthetic observed pool",
        exposureRole: "not_evaluated",
        current: {
          status: "unavailable",
          observedAtMs: null,
          collectedAtMs: null,
          assessments: [],
        },
        emergency: { status: "unknown" },
        history: {
          status: "disabled",
          recordsRead: 0,
          truncated: false,
          oldestObservedAtMs: null,
          newestObservedAtMs: null,
          sampleCount: 0,
          transitionCount: 0,
        },
        trend: { status: "insufficient_evidence", materialSignals: [], families: [] },
        limitations: [],
      },
    ],
  },
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

it.each(["rejected", "pending"])(
  "keeps Monitoring review and its selector usable while exposure discovery is %s",
  async (exposureState) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const risk = vi.fn(() =>
      exposureState === "rejected"
        ? Promise.reject(new Error("Synthetic exposure lookup failed"))
        : new Promise<never>(() => {}),
    );
    const riskReview = vi.fn(async (input: { monitorKey?: string }) => ({
      ...review,
      selectionStatus: input.monitorKey ? ("matched" as const) : ("all_subjects" as const),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => {
      act(() => root.unmount());
      client.clear();
      container.remove();
    });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <FarmingControlPage
              view="risk"
              portfolioDemo={{ seed: null, toggle: () => {} }}
              rpc={{ farmingControl: { risk, riskReview } } as unknown as RpcClient}
              queryScope="synthetic-owner-scope"
              onOpenNavigation={() => {}}
              openChat={async () => {}}
            />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.textContent).toContain("Synthetic observed pool");
    expect(container.textContent).toContain("Monitoring history and interpretation");
    if (exposureState === "rejected")
      expect(container.textContent).toContain("Synthetic exposure lookup failed");
    else expect(container.querySelector('[aria-label="Loading Farming Control"]')).not.toBeNull();
    const select = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Synthetic observed pool"),
    );
    expect(select).toBeDefined();
    await act(async () => {
      select!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(riskReview).toHaveBeenLastCalledWith({ monitorKey: "monitor-only" }, expect.anything());
    expect(container.textContent).toContain("Current FC state");
    expect(container.textContent).toContain("Exposure not established");
    expect(risk).toHaveBeenCalledTimes(1);
  },
);
