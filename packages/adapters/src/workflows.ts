import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { WorkflowNodeStateSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  expireComputerExecutionLeases,
  lockWorkflowRun,
  reconcileWorkflow,
  runAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun } from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";

/** A durable stop marker survives API/worker crashes; cleanup is retried before recovery is allowed. */
export async function finishWorkflowCancellation(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  actor: Actor,
  workflowRunId: string,
) {
  const snapshot = await deps.prisma.$transaction(async (tx) => {
    const workflow = await lockWorkflowRun(tx, actor, workflowRunId);
    if (!workflow.cancelPending || workflow.status !== "cancelled") return null;
    const nodes = WorkflowNodeStateSchema.array().parse(workflow.nodes);
    const tasks = await tx.task.findMany({
      where: {
        id: { in: nodes.flatMap((node) => (node.taskId ? [node.taskId] : [])) },
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
      select: { threadId: true },
    });
    // Match answer/finalization lock order: thread before run. Stable ordering also
    // permits multiple task conversations to be stopped by one transaction.
    for (const threadId of [...new Set(tasks.map((task) => task.threadId))].sort())
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    // Include continuations/answers created inside each node conversation.
    const runs = await tx.run.findMany({
      where: {
        threadId: { in: tasks.map((task) => task.threadId) },
        spaceId: actor.spaceId,
        userId: actor.userId,
        status: { not: "completed" },
      },
    });
    const leases = await tx.computerExecutionLease.findMany({
      where: { runId: { in: runs.map((run) => run.id) } },
    });
    const computers = await tx.computer.findMany({
      where: {
        id: {
          in: [
            ...leases.map((lease) => lease.computerId),
            ...runs.flatMap((run) => (run.nativeComputerId ? [run.nativeComputerId] : [])),
          ],
        },
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    await tx.steeringMessage.updateMany({
      where: {
        message: { threadId: { in: tasks.map((task) => task.threadId) } },
        claimedAt: null,
        cancelledAt: null,
      },
      data: { cancelledAt: new Date() },
    });
    const active = runs.filter((run) => !["failed", "cancelled"].includes(run.status));
    await cancelRunsInTransaction(tx, active, new Date());
    for (const run of active)
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "run.cancelled",
        payload: {},
      });
    return { nodes, runs, leases, computers };
  });
  if (!snapshot) return;
  for (const run of snapshot.runs) {
    const lease = snapshot.leases.find((item) => item.runId === run.id);
    const computerId = run.nativeComputerId ?? lease?.computerId;
    if (!computerId) continue;
    const computer = snapshot.computers.find((item) => item.id === computerId);
    if (
      !computer?.providerRef ||
      (run.nativeComputerKey && computer.homeKey !== run.nativeComputerKey)
    )
      throw new Error("Workflow execution host is unavailable");
    const nativeRunId = run.nativeExecutionRunId ?? run.id;
    const context = {
      operationId: `workflow-stop:${workflowRunId}:${run.id}`,
      traceId: `workflow-stop:${workflowRunId}`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: run.botId,
      runId: run.id,
      screenLeaseId: screenLeaseIdForRun(lease ?? null, run.id),
      cancelRunWork: true,
      requireRunCleanup: true,
      signal: AbortSignal.timeout(20_000),
    };
    await cancelComputerRunWork(
      deps.sandbox,
      toComputerRef(computer),
      computer.id,
      nativeRunId,
      context,
    );
    await deps.sandbox.releaseScreen?.(toComputerRef(computer), context);
    await expireComputerExecutionLeases(deps.prisma, { runId: run.id });
    await deps.prisma.computer.updateMany({
      where: { id: computer.id, executionRunId: run.id },
      data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
    });
  }
  await deps.prisma.$transaction(async (tx) => {
    const row = await lockWorkflowRun(tx, actor, workflowRunId);
    if (!row.cancelPending || row.status !== "cancelled") return;
    const nodes = WorkflowNodeStateSchema.array().parse(row.nodes);
    for (const node of nodes) {
      if (node.status === "succeeded") continue;
      const task = node.taskId
        ? await tx.task.findFirst({
            where: { id: node.taskId, spaceId: actor.spaceId, userId: actor.userId },
            select: {
              thread: {
                select: {
                  runs: {
                    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                    take: 1,
                    select: { id: true, status: true },
                  },
                },
              },
            },
          })
        : null;
      const run = task?.thread.runs[0];
      if (run) node.runId = run.id;
      node.status = run?.status === "completed" ? "succeeded" : "cancelled";
    }
    await tx.workflowRun.update({
      where: { id: row.id },
      data: { nodes, cancelPending: false, revision: { increment: 1 } },
    });
  });
}

export async function reconcileWorkflows(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
}) {
  const rows = await deps.prisma.workflowRun.findMany({
    where: { OR: [{ status: "running" }, { cancelPending: true }] },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, spaceId: true, userId: true, cancelPending: true },
  });
  for (const row of rows) {
    const actor: Actor = {
      spaceId: row.spaceId,
      userId: row.userId,
      email: "",
      isDeploymentOwner: false,
    };
    try {
      await runAsTenant(actor, async () => {
        if (row.cancelPending) await finishWorkflowCancellation(deps, actor, row.id);
        else
          for (const runId of await reconcileWorkflow(deps.prisma, actor, row.id))
            await deps.jobs.enqueue(runContinueJob(runId));
      });
    } catch (error) {
      // A disconnected host must move to the back of this bounded scan too.
      // Otherwise a full batch of failed stops can starve healthy workflow runs.
      await runAsTenant(actor, () =>
        deps.prisma.workflowRun.updateMany({
          where: { id: row.id, spaceId: actor.spaceId, userId: actor.userId },
          data: { updatedAt: new Date() },
        }),
      ).catch(() => undefined);
      getLogger().error("workflow reconciliation", error);
    }
  }
}
