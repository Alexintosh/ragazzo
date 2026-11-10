import type { ThreadQueue, WaitingDetail, WorkflowNodeState } from "@rakazo/contracts";

export type WaitingPresentation = {
  reason: WaitingDetail["reason"] | "computer" | "running" | "ready";
  action?: Exclude<WaitingDetail, { reason: "waiting" }>["action"];
  messageId?: string;
};

function detailPresentation(detail: WaitingDetail): WaitingPresentation {
  return detail.reason === "waiting"
    ? { reason: "waiting" }
    : {
        reason: detail.reason,
        ...(detail.action ? { action: detail.action, messageId: detail.messageId } : {}),
      };
}

/** Legacy omission retains its old label, but cannot invent an actionable request. */
export function queueWaiting(queue: ThreadQueue): WaitingPresentation {
  return queue.waitingDetail
    ? detailPresentation(queue.waitingDetail)
    : { reason: queue.waitingReason };
}

/** Scheduling status and the linked run's request are independent. */
export function workflowWaiting(node: WorkflowNodeState): WaitingPresentation | undefined {
  if (!["queued", "running", "waiting_approval"].includes(node.status)) return undefined;
  if (node.waitingDetail)
    return node.waitingDetail.runId === node.runId
      ? detailPresentation(node.waitingDetail)
      : { reason: "waiting" };
  return node.status === "waiting_approval" ? { reason: "waiting" } : undefined;
}
