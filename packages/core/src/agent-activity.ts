import type { AgentActivityEntry } from "@rakazo/contracts";
import { AGENT_ACTIVITY_LIMIT, AgentReasoningPayloadSchema } from "@rakazo/contracts";
import { humanizeToolName } from "./events.js";

export const AGENT_ACTIVITY_EVENT_TYPES = [
  "agent.tool.called",
  "agent.tool.completed",
  "agent.reasoning",
  "thread.meta",
  "thread.progress",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.waiting_input",
  "computer.takeover.requested",
] as const;

type ActivityEvent = {
  type: string;
  seq?: number;
  id?: string;
  runId?: string | null;
  botId?: string | null;
  payload?: unknown;
};

/** The same bounded projection drives snapshot replay and both live clients. */
export function reduceAgentActivity(
  previous: readonly AgentActivityEntry[],
  event: ActivityEvent,
): AgentActivityEntry[] {
  if (event.type === "thread.cleared") return [];
  const { runId, seq } = event;
  if (!runId || seq === undefined) return previous as AgentActivityEntry[];
  if (!AGENT_ACTIVITY_EVENT_TYPES.some((type) => type === event.type))
    return previous as AgentActivityEntry[];
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  let rows = previous as AgentActivityEntry[];
  const settle = (status: AgentActivityEntry["status"], tools: boolean) => {
    rows = rows.map((row) =>
      row.runId === runId &&
      row.status === "running" &&
      row.updatedSeq < seq &&
      (tools || row.kind !== "tool")
        ? { ...row, status, updatedSeq: seq }
        : row,
    );
  };
  const upsert = (entry: AgentActivityEntry) => {
    const old = rows.find((row) => row.id === entry.id);
    if (old && old.updatedSeq >= seq) return;
    rows = old
      ? rows.map((row) => (row.id === entry.id ? { ...entry, seq: old.seq } : row))
      : [...rows, entry];
  };
  const base = { runId, botId: event.botId ?? undefined, seq, updatedSeq: seq };
  if (["run.completed", "run.failed", "run.cancelled", "run.started"].includes(event.type)) {
    // A completed run is not proof that an unfinished tool succeeded.
    settle("stopped", true);
  } else if (["run.waiting_input", "computer.takeover.requested"].includes(event.type)) {
    settle("paused", true);
  } else if (event.type === "agent.tool.called" || event.type === "agent.tool.completed") {
    if (typeof payload.executionId !== "string" || typeof payload.name !== "string") return rows;
    const id = JSON.stringify([runId, "tool", payload.executionId]);
    const old = rows.find((row) => row.id === id);
    if (event.type === "agent.tool.called") {
      if (old) return rows; // A delayed start never revives a completed call.
      settle("completed", false);
      upsert({
        ...base,
        id,
        kind: "tool",
        label: humanizeToolName(payload.name),
        status: "running",
      });
    } else {
      const status =
        payload.outcome === "succeeded"
          ? "completed"
          : payload.outcome === "error"
            ? "error"
            : payload.outcome === "paused"
              ? "paused"
              : "stopped";
      upsert({
        ...base,
        id,
        kind: "tool",
        label: humanizeToolName(payload.name),
        status,
        ...(typeof payload.error === "string" ? { text: payload.error.slice(0, 4096) } : {}),
        ...(typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
          ? { durationMs: Math.max(0, payload.durationMs) }
          : {}),
      });
    }
  } else if (event.type === "agent.reasoning") {
    const parsed = AgentReasoningPayloadSchema.safeParse(payload);
    if (!parsed.success) return rows;
    const { id, text, done } = parsed.data;
    upsert({
      ...base,
      id: JSON.stringify([runId, "reasoning", id]),
      kind: "reasoning",
      label: "Reasoning summary",
      text,
      status: done ? "completed" : "running",
    });
  } else if (event.type === "thread.meta") {
    const activity = payload.activity as { thinking?: unknown } | undefined;
    if (typeof activity?.thinking !== "boolean") return rows;
    if (!activity.thinking) settle("completed", false);
    else if (
      !rows.some(
        (row) => row.runId === runId && row.kind === "thinking" && row.status === "running",
      )
    ) {
      upsert({
        ...base,
        id: JSON.stringify([runId, "thinking", seq]),
        kind: "thinking",
        label: "Thinking",
        status: "running",
      });
    }
  } else if (
    event.type === "thread.progress" &&
    payload.activity === true &&
    typeof payload.text === "string"
  ) {
    settle("completed", false);
    upsert({
      ...base,
      id: JSON.stringify([runId, "progress", seq]),
      kind: "progress",
      label: payload.text.slice(0, 2000),
      status: "running",
    });
  }
  return rows.slice(-AGENT_ACTIVITY_LIMIT);
}

/** Reconcile missing terminal events (bounded history, pause cleanup, older workers). */
export function settleAgentActivity(
  rows: AgentActivityEntry[],
  runs: readonly { id: string; status: string }[],
): AgentActivityEntry[] {
  const statuses = new Map(runs.map((run) => [run.id, run.status]));
  return rows.map((row) => {
    const status = statuses.get(row.runId);
    if (
      row.status !== "running" ||
      status === "running" ||
      status === "leased" ||
      status === "queued"
    )
      return row;
    return { ...row, status: status?.startsWith("waiting_") ? "paused" : "stopped" };
  });
}
