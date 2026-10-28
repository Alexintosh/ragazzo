import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const WORKFLOW_NODE_LIMIT = 32;
export const WorkflowNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(100),
  botId: Id,
  prompt: z.string().trim().min(1).max(16_000),
  x: z.number().finite().min(0).max(10_000),
  y: z.number().finite().min(0).max(10_000),
});
export const WorkflowGraphSchema = z
  .object({
    nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_NODE_LIMIT),
    edges: z.array(z.object({ from: z.string(), to: z.string() })).max(128),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    if (ids.size !== graph.nodes.length)
      ctx.addIssue({ code: "custom", message: "Node IDs must be unique" });
    const incoming = new Map([...ids].map((id) => [id, 0]));
    const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
    const edges = new Set<string>();
    for (const edge of graph.edges) {
      const key = `${edge.from}:${edge.to}`;
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || edges.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Edges must connect distinct existing nodes once",
        });
        continue;
      }
      edges.add(key);
      incoming.set(edge.to, incoming.get(edge.to)! + 1);
      outgoing.get(edge.from)!.push(edge.to);
    }
    const ready = [...ids].filter((id) => incoming.get(id) === 0);
    let visited = 0;
    while (ready.length) {
      const id = ready.pop()!;
      visited++;
      for (const next of outgoing.get(id)!) {
        incoming.set(next, incoming.get(next)! - 1);
        if (incoming.get(next) === 0) ready.push(next);
      }
    }
    if (visited !== ids.size)
      ctx.addIssue({ code: "custom", message: "Workflows cannot contain cycles" });
  });
export const WorkflowSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(100),
  revision: z.number().int().positive(),
  graph: WorkflowGraphSchema,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export const WorkflowNodeStateSchema = z.object({
  nodeId: z.string(),
  status: z.enum([
    "pending",
    "queued",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  taskId: Id.nullable(),
  runId: Id.nullable(),
  error: z.string().nullable(),
});
export const WorkflowRunSchema = z.object({
  id: Id,
  workflowId: Id,
  name: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  graph: WorkflowGraphSchema,
  nodes: z.array(WorkflowNodeStateSchema),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export const SaveWorkflowInput = z
  .object({
    workflowId: Id.optional(),
    revision: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(100),
    graph: WorkflowGraphSchema,
  })
  .refine(
    (input) => Boolean(input.workflowId) === Boolean(input.revision),
    "Provide the current revision when editing",
  );
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowNodeState = z.infer<typeof WorkflowNodeStateSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/** Only an existing stopped execution can become a deliberate recovery task. */
export function canRecoverWorkflowNode(node: WorkflowNodeState): boolean {
  return Boolean(
    node.taskId && node.runId && (node.status === "failed" || node.status === "cancelled"),
  );
}
