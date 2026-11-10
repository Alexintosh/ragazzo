import { describe, expect, it } from "vitest";
import type { AgentActivityEntry } from "@rakazo/contracts";
import { AGENT_ACTIVITY_LIMIT } from "@rakazo/contracts";
import { reduceAgentActivity, settleAgentActivity } from "./agent-activity.js";
const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  runId = "run-1",
) => ({ seq, type, payload, runId, botId: "bot-1" });
const call = { name: "read_file", executionId: "call-1" };

describe("agent activity shared projection", () => {
  it("tracks overlapping calls individually and reports actual failures", () => {
    let rows = reduceAgentActivity([], event(1, "agent.tool.called", call));
    rows = reduceAgentActivity(
      rows,
      event(2, "agent.tool.called", { ...call, executionId: "call-2" }),
    );
    rows = reduceAgentActivity(
      rows,
      event(3, "agent.tool.completed", {
        ...call,
        outcome: "error",
        error: "File missing",
        durationMs: 21,
      }),
    );
    expect(rows.map((row) => row.status)).toEqual(["error", "running"]);
    expect(rows[0]).toMatchObject({ text: "File missing", durationMs: 21, seq: 1, updatedSeq: 3 });
    rows = reduceAgentActivity(rows, event(4, "run.completed"));
    expect(rows.map((row) => row.status)).toEqual(["error", "stopped"]);
  });
  it("deduplicates updates, never revives completed calls, and isolates runs", () => {
    const done = event(3, "agent.tool.completed", { ...call, outcome: "succeeded" });
    let rows = reduceAgentActivity([], done);
    rows = reduceAgentActivity(rows, done);
    rows = reduceAgentActivity(rows, event(1, "agent.tool.called", call));
    rows = reduceAgentActivity(rows, event(4, "agent.tool.called", call, "run-2"));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(["completed", "running"]);
    expect(reduceAgentActivity(rows, event(5, "run.failed"))[1]?.status).toBe("running");
  });
  it("replays cumulative summaries without duplication and rejects opaque extra fields", () => {
    let rows = reduceAgentActivity(
      [],
      event(1, "agent.reasoning", { id: "summary", text: "Checking", done: false }),
    );
    rows = reduceAgentActivity(
      rows,
      event(2, "agent.reasoning", { id: "summary", text: "Checking files", done: true }),
    );
    rows = reduceAgentActivity(
      rows,
      event(1, "agent.reasoning", { id: "summary", text: "Old", done: false }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "Checking files", status: "completed", seq: 1 });
    expect(
      reduceAgentActivity(
        rows,
        event(3, "agent.reasoning", { id: "bad", text: "no", done: true, encrypted: "opaque" }),
      ),
    ).toEqual(rows);
  });
  it("settles thinking and pauses tools without inventing a successful outcome", () => {
    let rows = reduceAgentActivity([], event(1, "thread.meta", { activity: { thinking: true } }));
    rows = reduceAgentActivity(rows, event(2, "agent.tool.called", call));
    rows = reduceAgentActivity(rows, event(3, "run.waiting_input"));
    expect(rows.map((row) => row.status)).toEqual(["completed", "paused"]);
    expect(reduceAgentActivity(rows, event(4, "thread.cleared"))).toEqual([]);
  });
  it("bounds long runs and reconciles missing terminal history", () => {
    let rows: AgentActivityEntry[] = [];
    for (let seq = 0; seq < AGENT_ACTIVITY_LIMIT + 12; seq++)
      rows = reduceAgentActivity(
        rows,
        event(seq, "agent.tool.called", { ...call, executionId: String(seq) }),
      );
    expect(rows).toHaveLength(AGENT_ACTIVITY_LIMIT);
    expect(rows[0]?.seq).toBe(12);
    expect(
      settleAgentActivity(rows, [{ id: "run-1", status: "failed" }]).every(
        (row) => row.status === "stopped",
      ),
    ).toBe(true);
  });
});
