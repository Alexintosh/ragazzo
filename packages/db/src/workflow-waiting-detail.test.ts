import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient, WorkflowRun } from "./client.js";
import { getWorkflowRun, readWorkflowRunView, workflowRunView } from "./workflows.js";

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.invalid",
  isDeploymentOwner: false,
};
const row = {
  id: "workflow-run",
  workflowId: "workflow",
  name: "Synthetic workflow",
  revision: 1,
  spaceId: "space",
  userId: "user",
  status: "running",
  graph: {
    nodes: ["a", "b"].map((id) => ({
      id,
      botId: `bot-${id}`,
      label: id,
      prompt: "Question",
      x: 0,
      y: 0,
    })),
    edges: [],
  },
  nodes: ["a", "b"].map((id) => ({
    nodeId: id,
    status: "waiting_approval",
    taskId: `task-${id}`,
    runId: `run-${id}`,
    error: null,
  })),
  createdAt: new Date("2026-11-09T10:00:00Z"),
  updatedAt: new Date("2026-11-09T10:01:00Z"),
} as unknown as WorkflowRun;
function fixture() {
  return {
    workflowRun: { findFirst: vi.fn(async () => row) },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        status: "waiting_input",
        threadId: `thread-${where.id}`,
        botId: `bot-${where.id.slice(-1)}`,
      })),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) => [
        {
          id: `message-${where.runId}`,
          runId: where.runId,
          blocks: [
            {
              kind: "ask",
              text: "Synthetic request",
              status: "pending",
              ...(where.runId === "run-b" ? { input: "secret" } : {}),
            },
          ],
        },
      ]),
    },
    externalEffect: { findMany: vi.fn(async () => []) },
  };
}

describe("workflow waiting projection", () => {
  it.each(["queued", "running"])(
    "reads the linked run even while node status is still %s",
    async (status) => {
      const tx = fixture();
      const stale = {
        ...row,
        nodes: [{ nodeId: "a", status, taskId: "task-a", runId: "run-a", error: null }],
      } as WorkflowRun;
      const view = await readWorkflowRunView(
        tx as unknown as Prisma.TransactionClient,
        actor,
        stale,
      );
      expect(view.nodes[0]).toMatchObject({
        status,
        waitingDetail: {
          reason: "question",
          runId: "run-a",
          messageId: "message-run-a",
          action: "answer",
        },
      });
    },
  );
  it("does not revive terminal nodes in an otherwise running workflow", async () => {
    const tx = fixture();
    const terminalNode = {
      ...row,
      nodes: [{ nodeId: "a", status: "succeeded", taskId: "task-a", runId: "run-a", error: null }],
    } as WorkflowRun;
    expect(
      (await readWorkflowRunView(tx as unknown as Prisma.TransactionClient, actor, terminalNode))
        .nodes[0]?.waitingDetail,
    ).toBeUndefined();
    expect(tx.run.findFirst).not.toHaveBeenCalled();
  });
  it("keeps node status independent and projects two requests from their own runs", async () => {
    const tx = fixture();
    const view = await getWorkflowRun(tx as unknown as PrismaClient, actor, row.id);
    expect(view.nodes.map((node) => [node.status, node.waitingDetail])).toEqual([
      [
        "waiting_approval",
        { reason: "question", runId: "run-a", messageId: "message-run-a", action: "answer" },
      ],
      [
        "waiting_approval",
        { reason: "secret", runId: "run-b", messageId: "message-run-b", action: "provide_secret" },
      ],
    ]);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run-a",
          taskId: "task-a",
          botId: "bot-a",
          spaceId: "space",
          userId: "user",
          bot: { spaceId: "space", userId: "user", archivedAt: null },
        },
      }),
    );
    expect(JSON.stringify(row.nodes)).not.toContain("waitingDetail");
  });
  it("rereads after an answer on another device and removes the old action", async () => {
    const tx = fixture();
    const read = () => readWorkflowRunView(tx as unknown as Prisma.TransactionClient, actor, row);
    expect((await read()).nodes[0]?.waitingDetail?.reason).toBe("question");
    tx.message.findMany.mockResolvedValue([]);
    expect((await read()).nodes[0]?.waitingDetail).toEqual({ reason: "waiting", runId: "run-a" });
  });
  it("never trusts saved detail and degrades historical rows to generic waiting", () => {
    const saved = {
      ...row,
      nodes: [
        {
          nodeId: "a",
          status: "waiting_approval",
          taskId: "task-a",
          runId: "run-a",
          error: null,
          waitingDetail: {
            reason: "question",
            runId: "old-run",
            messageId: "old-message",
            action: "answer",
          },
        },
      ],
    } as WorkflowRun;
    expect(workflowRunView(saved).nodes[0]?.waitingDetail).toEqual({
      reason: "waiting",
      runId: "run-a",
    });
  });
  it.each(["succeeded", "failed", "cancelled"])("does not enrich a %s workflow", async (status) => {
    const tx = fixture();
    const view = await readWorkflowRunView(tx as unknown as Prisma.TransactionClient, actor, {
      ...row,
      status,
    });
    expect(view.nodes.every((node) => node.waitingDetail === undefined)).toBe(true);
    expect(tx.run.findFirst).not.toHaveBeenCalled();
  });
  it("does not expose evidence from another owner", async () => {
    const tx = fixture();
    await expect(
      readWorkflowRunView(
        tx as unknown as Prisma.TransactionClient,
        { ...actor, userId: "other" },
        row,
      ),
    ).rejects.toThrow("Resource not found");
    expect(tx.message.findMany).not.toHaveBeenCalled();
  });
});
