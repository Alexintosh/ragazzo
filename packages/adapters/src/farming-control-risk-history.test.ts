import { describe, expect, it, vi } from "vitest";
import { readFarmingControlRiskHistory } from "./farming-control-risk-history.js";

const episode = {
  policyKey: "policy:a",
  subjectKey: "subject:a",
  openedAtMs: 1000,
  severity: "critical",
};
const row = (kind: "opened" | "resolved", time: number) => ({
  kind: "transition",
  id: kind,
  runtimeInstanceId: "generation-a",
  monitorKey: "monitor-a",
  subjectKey: "subject:a",
  occurredAtMs: time,
  recordedAtMs: time + 100,
  transitionKind: kind,
  finality: "finalized",
  blockNumberDecimal: "42",
  blockHash: "0x1234",
  payload: {
    kind,
    episode: kind === "opened" ? episode : null,
    previous: kind === "resolved" ? episode : null,
  },
});
const page = (items: unknown[], nextCursor: string | null = null) => ({
  schemaVersion: "hot-monitoring-history-read.v1",
  monitorKey: "monitor-a",
  status: "ready",
  items,
  nextCursor,
});
function fixture(pages: unknown[]) {
  const read = vi.fn(async (_path, schema) => {
    const parsed = schema.safeParse(pages.shift());
    return parsed.success
      ? { data: parsed.data, issue: null }
      : { data: null, issue: "unsupported" };
  });
  return {
    read,
    input: { monitorKey: "monitor-a", fromMs: 0, throughMs: 10_000, enabled: true, read },
  };
}
describe("selected Risk dated history", () => {
  it("orders retained open and resolution by occurrence and preserves separate recording/finality/lineage", async () => {
    const { input, read } = fixture([page([row("resolved", 8000), row("opened", 1000)])]);
    const result = await readFarmingControlRiskHistory(input);
    expect(result.transitions.map((row) => row.transition)).toEqual(["opened", "resolved"]);
    expect(result.transitions[1]).toMatchObject({
      occurredAtMs: 8000,
      recordedAtMs: 8100,
      episodeOpenedAtMs: 1000,
      policyKey: "policy:a",
      finality: "finalized",
      runtimeInstanceId: "generation-a",
    });
    expect(result.coverage).toBe("unknown");
    expect(result.state).toBe("partial");
    expect(read.mock.calls[0]?.[0]).toBe("/monitoring/hot/monitors/monitor-a/history?limit=200");
  });
  it("never fills missing episode identity or an omitted opening from a resolution", async () => {
    const sparse = { ...row("resolved", 8000), payload: { severity: "info", status: "healthy" } };
    const result = await readFarmingControlRiskHistory(fixture([page([sparse])]).input);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({
      policyKey: null,
      episodeOpenedAtMs: null,
      severity: null,
    });
    expect(result.coverage).toBe("unknown");
  });
  it("respects disabled history and rejects other monitor pages/rows", async () => {
    const f = fixture([]);
    expect((await readFarmingControlRiskHistory({ ...f.input, enabled: false })).state).toBe(
      "disabled",
    );
    expect(f.read).not.toHaveBeenCalled();
    const other = fixture([{ ...page([]), monitorKey: "other" }]);
    expect((await readFarmingControlRiskHistory(other.input)).state).toBe("unavailable");
    const mixed = fixture([page([{ ...row("opened", 1000), monitorKey: "other" }])]);
    expect((await readFarmingControlRiskHistory(mixed.input)).transitions).toEqual([]);
  });
  it("bounds pages, retains partial evidence on later failure, and never treats an empty page as continuous coverage", async () => {
    const f = fixture([page([row("opened", 1000)], "cursor"), null]);
    const result = await readFarmingControlRiskHistory(f.input);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(result.transitions).toHaveLength(1);
    expect(result.truncated).toBe(true);
    const dense = fixture([
      page(
        Array.from({ length: 200 }, (_, i) => ({ ...row("opened", 1000), id: String(i) })),
        "a",
      ),
      page([], "b"),
    ]);
    const bound = await readFarmingControlRiskHistory(dense.input);
    expect(bound.transitions).toHaveLength(200);
    expect(bound.truncated).toBe(true);
    expect(dense.read).toHaveBeenCalledTimes(2);
    expect((await readFarmingControlRiskHistory(fixture([page([])]).input)).coverage).toBe(
      "unknown",
    );
  });
});
