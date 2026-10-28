import { describe, expect, it } from "vitest";
import { canRecoverWorkflowNode, SaveWorkflowInput, WorkflowGraphSchema } from "./workflow.js";

const node = (id: string) => ({ id, label: id, botId: "bot", prompt: "Do this step", x: 0, y: 0 });
describe("bounded executable workflow graphs", () => {
  it("accepts disconnected roots, fan-out and joins", () => {
    expect(
      WorkflowGraphSchema.parse({
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [
          { from: "a", to: "c" },
          { from: "b", to: "c" },
          { from: "c", to: "d" },
        ],
      }).nodes,
    ).toHaveLength(4);
  });
  it.each([
    { nodes: [node("a"), node("a")], edges: [] },
    { nodes: [node("a")], edges: [{ from: "a", to: "a" }] },
    { nodes: [node("a")], edges: [{ from: "a", to: "missing" }] },
    {
      nodes: [node("a"), node("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    },
    {
      nodes: [node("a"), node("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    },
    { nodes: Array.from({ length: 33 }, (_, index) => node(String(index))), edges: [] },
    { nodes: [{ ...node("a"), x: Infinity }], edges: [] },
  ])("rejects invalid graph %#", (graph) => {
    expect(WorkflowGraphSchema.safeParse(graph).success).toBe(false);
  });
  it("requires optimistic revision for editing", () => {
    const input = { name: "Workflow", graph: { nodes: [node("a")], edges: [] } };
    expect(SaveWorkflowInput.safeParse(input).success).toBe(true);
    expect(SaveWorkflowInput.safeParse({ ...input, workflowId: "existing" }).success).toBe(false);
    expect(
      SaveWorkflowInput.safeParse({ ...input, workflowId: "existing", revision: 1 }).success,
    ).toBe(true);
  });
});

it.each([
  { status: "cancelled", taskId: null, runId: null, expected: false },
  { status: "cancelled", taskId: "task", runId: null, expected: false },
  { status: "failed", taskId: "task", runId: "run", expected: true },
  { status: "cancelled", taskId: "task", runId: "run", expected: true },
  { status: "pending", taskId: null, runId: null, expected: false },
  { status: "succeeded", taskId: "task", runId: "run", expected: false },
] as const)(
  "offers recovery only for stopped executions %#",
  ({ status, taskId, runId, expected }) => {
    expect(canRecoverWorkflowNode({ nodeId: "step", status, taskId, runId, error: null })).toBe(
      expected,
    );
  },
);
