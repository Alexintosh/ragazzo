import { describe, expect, it } from "vitest";
import * as z from "zod";
import { ThreadQueueSchema, WaitingDetailSchema } from "./thread-queue.js";
import { WorkflowNodeStateSchema } from "./workflow.js";

const queue = { revision: 1, entries: [], canSteer: false, waitingReason: "approval" };
const node = {
  nodeId: "draft",
  status: "waiting_approval",
  taskId: "task",
  runId: "run",
  error: null,
};
const detail = { reason: "question", runId: "run", messageId: "message", action: "answer" };

describe("additive waiting detail contract", () => {
  it("accepts older server payloads without detail", () => {
    expect(ThreadQueueSchema.parse(queue)).toEqual(queue);
    expect(WorkflowNodeStateSchema.parse(node)).toEqual(node);
  });
  it("preserves legacy enums while carrying the actual reason", () => {
    expect(ThreadQueueSchema.parse({ ...queue, waitingDetail: detail })).toEqual({
      ...queue,
      waitingDetail: detail,
    });
    expect(WorkflowNodeStateSchema.parse({ ...node, waitingDetail: detail })).toEqual({
      ...node,
      waitingDetail: detail,
    });
  });
  it("lets older schema readers ignore the additive detail", () => {
    const oldQueue = ThreadQueueSchema.omit({ waitingDetail: true });
    const oldNode = WorkflowNodeStateSchema.omit({ waitingDetail: true });
    expect(oldQueue.parse({ ...queue, waitingDetail: detail })).toEqual(queue);
    expect(oldNode.parse({ ...node, waitingDetail: detail })).toEqual(node);
  });
  it("rejects mismatched reasons/actions and strips non-contract content", () => {
    expect(WaitingDetailSchema.safeParse({ ...detail, action: "takeover" }).success).toBe(false);
    expect(
      WaitingDetailSchema.parse({ reason: "waiting", runId: "run", action: "answer" }),
    ).toEqual({ reason: "waiting", runId: "run" });
    expect(WaitingDetailSchema.parse({ ...detail, secret: "synthetic-secret" })).toEqual(detail);
    expect(z.object({ waitingDetail: WaitingDetailSchema.optional() }).parse({})).toEqual({});
  });
});
