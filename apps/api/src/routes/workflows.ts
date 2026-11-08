import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import { finishWorkflowCancellation } from "@rakazo/adapters";
import type { Actor, WorkflowGraph } from "@rakazo/contracts";
import {
  attachWorkflowRecoveryInTransaction,
  getWorkflow,
  getWorkflowRun,
  reconcileWorkflow,
  requestWorkflowCancellation,
  saveWorkflow,
  startWorkflow,
  WorkflowConflictError,
  workflowRunView,
  workflowView,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { recoverConversationRun } from "../conversation-tasks.js";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import type { RouterContext } from "./context.js";
import { modelSetup } from "./shared.js";

export function workflowsRoutes({ deps, authed }: RouterContext) {
  const checked = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WorkflowConflictError)
        throw new ORPCError("CONFLICT", { message: error.message });
      throw error;
    }
  };
  const allowed = async (actor: Actor, graph: WorkflowGraph) => {
    const ids = [...new Set(graph.nodes.map((node) => node.botId))];
    const bots = await deps.prisma.bot.findMany({
      where: { id: { in: ids }, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    });
    if (bots.length !== ids.length) throw new ORPCError("NOT_FOUND");
    for (const bot of bots) await assertTeachingSendAllowed(deps.prisma, actor.spaceId, bot.id);
    if (bots.some((bot) => bot.runtimeKind === "pi") && (await modelSetup(deps, actor)).needsModel)
      throw new ORPCError("BAD_REQUEST", {
        message: "Choose a model before starting this workflow.",
      });
  };
  const wake = async (actor: Actor, id: string) => {
    for (const runId of await reconcileWorkflow(deps.prisma, actor, id))
      await deps.jobs
        .enqueue(runContinueJob(runId))
        .catch((error) => getLogger().error("workflow wake", error));
    return getWorkflowRun(deps.prisma, actor, id);
  };
  return {
    workflows: {
      list: authed.workflows.list.handler(async ({ context }) => ({
        workflows: (
          await deps.prisma.workflow.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 100,
          })
        ).map(workflowView),
      })),
      get: authed.workflows.get.handler(({ context, input }) =>
        getWorkflow(deps.prisma, context.actor, input.workflowId),
      ),
      save: authed.workflows.save.handler(({ context, input }) =>
        checked(() => saveWorkflow(deps.prisma, context.actor, input)),
      ),
      start: authed.workflows.start.handler(({ context, input }) =>
        checked(async () => {
          const definition = await getWorkflow(deps.prisma, context.actor, input.workflowId);
          await allowed(context.actor, definition.graph);
          const run = await startWorkflow(deps.prisma, context.actor, input);
          return wake(context.actor, run.id);
        }),
      ),
      runs: authed.workflows.runs.handler(async ({ context, input }) => {
        await getWorkflow(deps.prisma, context.actor, input.workflowId);
        return {
          runs: (
            await deps.prisma.workflowRun.findMany({
              where: {
                workflowId: input.workflowId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 50,
            })
          ).map(workflowRunView),
        };
      }),
      run: authed.workflows.run.handler(({ context, input }) =>
        getWorkflowRun(deps.prisma, context.actor, input.runId),
      ),
      cancel: authed.workflows.cancel.handler(({ context, input }) =>
        checked(async () => {
          await requestWorkflowCancellation(deps.prisma, context.actor, input);
          await finishWorkflowCancellation(deps, context.actor, input.runId).catch((error) =>
            getLogger().error("workflow stop pending", error),
          );
          return getWorkflowRun(deps.prisma, context.actor, input.runId);
        }),
      ),
      recover: authed.workflows.recover.handler(({ context, input }) =>
        checked(async () => {
          const workflow = await getWorkflowRun(deps.prisma, context.actor, input.runId);
          const node = workflow.nodes.find((item) => item.nodeId === input.nodeId);
          const receipt = await deps.prisma.task.findUnique({
            where: {
              spaceId_clientNonce: {
                spaceId: context.actor.spaceId,
                clientNonce: `recovery:workflow:${workflow.id}:${input.nodeId}:${input.clientNonce}`,
              },
            },
            select: { id: true, userId: true },
          });
          if (receipt && receipt.userId === context.actor.userId && node?.taskId === receipt.id)
            return workflow;
          const definition = workflow.graph.nodes.find((item) => item.id === input.nodeId);
          if (!node?.runId || !definition || !["failed", "cancelled"].includes(node.status))
            throw new WorkflowConflictError();
          await allowed(context.actor, workflow.graph);
          const sourceRunId = node.runId;
          const recovery = await recoverConversationRun(
            deps.prisma,
            context.actor,
            {
              runId: sourceRunId,
              botId: definition.botId,
              clientNonce: `workflow:${workflow.id}:${input.nodeId}:${input.clientNonce}`,
              text: input.text,
            },
            deps.sandbox,
            async (tx, task) => {
              await attachWorkflowRecoveryInTransaction(tx, context.actor, {
                ...input,
                sourceRunId,
                taskId: task.id,
                taskRunId: task.runId,
              });
            },
          );
          await deps.jobs
            .enqueue(runContinueJob(recovery.task.runId))
            .catch((error) => getLogger().error("workflow recovery wake", error));
          return getWorkflowRun(deps.prisma, context.actor, input.runId);
        }),
      ),
    },
  };
}
