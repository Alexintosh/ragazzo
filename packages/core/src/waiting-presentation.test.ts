import type { ThreadQueue, WaitingDetail, WorkflowNodeState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { queueWaiting, workflowWaiting } from "./waiting-presentation.js";

const queue: ThreadQueue = { revision: 3, entries: [], canSteer: false, waitingReason: "approval" };
const node: WorkflowNodeState = {
  nodeId: "a",
  runId: "run-a",
  taskId: "task-a",
  status: "waiting_approval",
  error: null,
};

describe("waiting presentation compatibility", () => {
  it.each(["ready", "running", "approval", "computer"] as const)(
    "keeps old-server %s without inventing an action",
    (waitingReason) => {
      expect(queueWaiting({ ...queue, waitingReason })).toEqual({ reason: waitingReason });
    },
  );
  it.each([
    ["question", "answer"],
    ["approval", "review_approval"],
    ["secret", "provide_secret"],
    ["takeover", "takeover"],
  ] as const)("uses %s detail across queue and workflow scheduling states", (reason, action) => {
    const waitingDetail = {
      reason,
      action,
      runId: "run-a",
      messageId: "request-a",
    } as WaitingDetail;
    const expected = { reason, action, messageId: "request-a" };
    expect(queueWaiting({ ...queue, waitingDetail })).toEqual(expected);
    for (const status of ["queued", "running", "waiting_approval"] as const)
      expect(workflowWaiting({ ...node, status, waitingDetail })).toEqual(expected);
  });
  it("does not inherit an approval action from the legacy field for generic detail", () => {
    expect(
      queueWaiting({ ...queue, waitingDetail: { reason: "waiting", runId: "run-a" } }),
    ).toEqual({ reason: "waiting" });
    expect(workflowWaiting(node)).toEqual({ reason: "waiting" });
  });
  it("keeps an unavailable takeover non-actionable", () => {
    expect(
      queueWaiting({
        ...queue,
        waitingDetail: { reason: "takeover", runId: "run-a", messageId: "request-a" },
      }),
    ).toEqual({ reason: "takeover" });
  });
  it("cannot attach another run's action to a node", () => {
    expect(
      workflowWaiting({
        ...node,
        waitingDetail: {
          reason: "question",
          runId: "other-run",
          messageId: "other-request",
          action: "answer",
        },
      }),
    ).toEqual({ reason: "waiting" });
  });
  it.each(["succeeded", "failed", "cancelled", "pending"] as const)(
    "does not revive a %s node's old action",
    (status) => {
      expect(
        workflowWaiting({
          ...node,
          status,
          waitingDetail: {
            reason: "question",
            runId: "run-a",
            messageId: "request-a",
            action: "answer",
          },
        }),
      ).toBeUndefined();
    },
  );
});
