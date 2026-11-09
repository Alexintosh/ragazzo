import type { FarmingControlRisk, FarmingControlRiskReview } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: () => null,
}));

import { RiskCards, RiskReviewEvidence } from "./risk-cards";

const now = 1_794_219_300_000;
const review: FarmingControlRiskReview = {
  state: "partial",
  fetchedAtMs: now,
  asOfMs: now,
  sources: ["/monitoring/hot/evidence"],
  issues: [],
  selectionStatus: "matched",
  exposureAssociationStatus: "unproven",
  linkedExposure: null,
  currentFinality: "not_exposed",
  evidence: {
    schemaVersion: "hot-monitoring-evidence.v1",
    asOfMs: now,
    requestedFromMs: now - 604800000,
    window: "7d",
    executionEligible: false,
    population: {
      configuredCount: 1,
      runningDesiredCount: 1,
      excludedStoppedCount: 0,
      basis: "all_desired_running_monitors",
    },
    items: [
      {
        monitorKey: "monitor-a",
        label: "Example pool",
        exposureRole: "not_evaluated",
        current: {
          status: "unavailable",
          observedAtMs: null,
          collectedAtMs: null,
          assessments: [],
        },
        emergency: { status: "unknown" },
        history: {
          status: "ready",
          recordsRead: 2,
          truncated: false,
          oldestObservedAtMs: now - 900000,
          newestObservedAtMs: now - 420000,
          sampleCount: 0,
          transitionCount: 2,
        },
        trend: { status: "insufficient_evidence", materialSignals: [], families: [] },
        limitations: [],
      },
    ],
  },
  episodeHistory: {
    state: "partial",
    coverage: "unknown",
    fromMs: now - 604800000,
    throughMs: now,
    recordsRead: 2,
    truncated: false,
    limitations: [],
    transitions: [
      {
        id: "open",
        monitorKey: "monitor-a",
        runtimeInstanceId: "generation-a",
        subjectKey: "subject-a",
        policyKey: "policy-a",
        episodeOpenedAtMs: now - 900000,
        occurredAtMs: now - 900000,
        recordedAtMs: now - 899000,
        transition: "opened",
        severity: "critical",
        finality: "finalized",
        blockNumber: "42",
        blockHash: "hash",
      },
      {
        id: "resolve",
        monitorKey: "monitor-a",
        runtimeInstanceId: "generation-a",
        subjectKey: "subject-a",
        policyKey: "policy-a",
        episodeOpenedAtMs: now - 900000,
        occurredAtMs: now - 420000,
        recordedAtMs: now - 419000,
        transition: "resolved",
        severity: "info",
        finality: "finalized",
        blockNumber: "43",
        blockHash: "hash",
      },
    ],
  },
  interpretations: {
    state: "partial",
    asOfMs: now,
    truncated: false,
    limitations: [],
    runs: [
      {
        runId: "run-a",
        eventId: "event-a",
        kind: "emergency",
        scope: "selected_monitor",
        triggeredAtMs: now,
        occurredAtMs: now - 900000,
        episodeOpenedAtMs: now - 900000,
        subjectKey: "subject-a",
        policyKey: "policy-a",
        transition: "opened",
        runStatus: "completed",
        analysisStatus: "indeterminate",
        messageId: null,
      },
    ],
  },
};
function render(value = review) {
  return renderToStaticMarkup(
    <RiskReviewEvidence review={value} onSelect={() => {}} onMention={() => {}} />,
  );
}
describe("Risk review disclosure", () => {
  it("keeps historical open/resolved dated beside unknown current health and independent indeterminate interpretation", () => {
    const html = render();
    expect(html).toContain("Current FC state");
    expect(html).toContain("No current observation");
    expect(html).toContain("Not exposed by this evidence read");
    expect(html).toContain("Opened");
    expect(html).toContain("Resolved");
    expect(html).toContain(new Date(now - 900000).toISOString());
    expect(html).toContain(new Date(now - 420000).toISOString());
    expect(html).toContain("Indeterminate");
    expect(html).not.toContain("href=");
    expect(html).toContain("Exposure not established");
    expect(html).not.toContain("Matched visible holding");
  });
  it("supports older review contracts and empty history without fabricating safety or result links", () => {
    const {
      episodeHistory: _history,
      interpretations: _runs,
      currentFinality: _finality,
      ...legacy
    } = review;
    const html = render(legacy);
    expect(html).toContain("past incidents remain unknown");
    expect(html).toContain("Analysis availability is unknown");
    expect(html).not.toContain("href=");
  });
  it("includes monitors without claiming position exposure and distinguishes weekly research", () => {
    const html = render({ ...review, selectionStatus: "all_subjects" });
    expect(html).toContain("Includes monitors without proven holdings");
    expect(html).toContain("Example pool");
    const weekly = structuredClone(review);
    weekly.interpretations!.runs[0]!.kind = "weekly_review";
    weekly.interpretations!.runs[0]!.scope = "monitoring_universe";
    expect(render(weekly)).toContain("Monitoring-wide research; not a selected episode result.");
  });
});

it("conceals amount signals in Risk demo presentation without mutating query data", () => {
  const availability = {
    state: "available" as const,
    asOfMs: now,
    returnedCount: 1,
    truncated: false,
  };
  const data: FarmingControlRisk = {
    state: "available",
    fetchedAtMs: now,
    asOfMs: now,
    sources: [],
    issues: [],
    complete: false,
    exposureScope: {
      discovery: "complete",
      walletVisibilityRevision: 1,
      activePositionCount: 1,
      coveredPositionCount: 1,
      uncoveredPositionCount: 0,
    },
    alerts: [],
    assessments: [],
    monitors: [],
    sourceAvailability: {
      morpho: availability,
      curve: availability,
      alerts: availability,
      assessments: availability,
      monitors: availability,
    },
    exposures: [
      {
        id: "monitor-a",
        monitorKey: "monitor-a",
        protocol: "Morpho Blue",
        kind: "market",
        label: "Example",
        chainId: 1,
        subject: { kind: "market", id: "market-a", address: null },
        positions: [{ id: "position-a", label: "Example holding", association: "active_exposure" }],
        dataStatus: "live",
        observedAtMs: now,
        collectedAtMs: now,
        blockNumber: "42",
        blockHash: null,
        maxSeverity: "warning",
        coverage: "partial",
        limitations: [],
        signals: [
          {
            key: "capacity",
            label: "Capacity",
            status: "attention",
            severity: "warning",
            sourceSeverity: "warning",
            coverage: "current",
            value: "987654321.12",
            format: "amount",
            unit: "USD",
            summary: "Private amount 987654321.12",
          },
        ],
      },
    ],
  };
  const normal = renderToStaticMarkup(<RiskCards data={data} onMention={async () => {}} />);
  const demo = renderToStaticMarkup(<RiskCards data={data} demoMode onMention={async () => {}} />);
  expect(normal).toContain("987,654,321.12");
  expect(demo).not.toContain("987,654,321.12");
  expect(demo).not.toContain("987654321.12");
  expect(data.exposures[0]?.signals[0]?.value).toBe("987654321.12");
});
