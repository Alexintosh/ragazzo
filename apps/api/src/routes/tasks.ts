import { ORPCError } from "@orpc/server";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  createConversationTask,
  getConversationTask,
  listConversationTasks,
  recoverConversationRun,
  startQueuedConversationTask,
  stoppedConversationRuns,
} from "../conversation-tasks.js";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import { resolveQueueTarget } from "../thread-queue.js";
import { resolveThreadTarget } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { modelSetup } from "./shared.js";

export function tasksRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const allowed = async (actor: Actor, botId: string) => {
    const target = await resolveThreadTarget(deps.prisma, actor, { botId });
    if (target.kind !== "bot") throw new IsolationError();
    await assertTeachingSendAllowed(deps.prisma, actor.spaceId, botId);
    if (
      !["codex", "claude", "acp"].includes(target.bot.runtimeKind ?? "pi") &&
      (await modelSetup(deps, actor)).needsModel
    )
      throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
    return target;
  };
  const publish = async (result: Awaited<ReturnType<typeof createConversationTask>>) => {
    if (result.eventSeq !== null)
      await deps.events
        .notify(result.task.threadId, result.eventSeq)
        .catch((error) => getLogger().error("task notification", error));
    if (result.originEventSeq !== null && result.task.originThreadId)
      await deps.events
        .notify(result.task.originThreadId, result.originEventSeq)
        .catch((error) => getLogger().error("task origin notification", error));
    await deps.jobs
      .enqueue(runContinueJob(result.task.runId))
      .catch((error) => getLogger().error("task wake", error));
    if (result.continuationRunId)
      await deps.jobs
        .enqueue(runContinueJob(result.continuationRunId))
        .catch((error) => getLogger().error("queue wake after task", error));
    return result.task;
  };
  const createTask = async (
    actor: Actor,
    input: {
      botId: string;
      text: string;
      clientNonce: string;
      originBotId?: string;
      originGroupId?: string;
      writeSubdirectory?: string;
    },
  ) => {
    const bot = await allowed(actor, input.botId);
    const origin = input.originGroupId
      ? await resolveThreadTarget(deps.prisma, actor, { groupId: input.originGroupId })
      : input.originBotId
        ? await resolveThreadTarget(deps.prisma, actor, { botId: input.originBotId })
        : bot;
    if (origin.kind === "group" && !origin.memberBotIds.includes(input.botId))
      throw new IsolationError();
    return publish(
      await createConversationTask(deps.prisma, actor, {
        ...input,
        originThreadId: origin.threadId,
      }),
    );
  };
  return {
    tasks: {
      get: authed.tasks.get.handler(({ context, input }) =>
        getConversationTask(deps.prisma, context.actor, input.taskId),
      ),
      list: authed.tasks.list.handler(async ({ context, input }) => {
        const bot = input.botId
          ? await resolveThreadTarget(deps.prisma, context.actor, { botId: input.botId })
          : null;
        const origin = input.groupId
          ? await resolveThreadTarget(deps.prisma, context.actor, { groupId: input.groupId })
          : null;
        return listConversationTasks(deps.prisma, context.actor, {
          botId: input.botId,
          botThreadId: bot?.threadId,
          originThreadId: origin?.threadId,
          cursor: input.cursor,
        });
      }),
      stopped: authed.tasks.stopped.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return { runs: await stoppedConversationRuns(deps.prisma, context.actor, target.threadId) };
      }),
      create: authed.tasks.create.handler(({ context, input }) => createTask(context.actor, input)),
      createScoped: authed.tasks.createScoped.handler(({ context, input }) =>
        createTask(context.actor, input),
      ),
      recover: authed.tasks.recover.handler(async ({ context, input }) => {
        await allowed(context.actor, input.botId);
        return publish(
          await recoverConversationRun(deps.prisma, context.actor, input, deps.sandbox),
        );
      }),
      startQueued: authed.tasks.startQueued.handler(async ({ context, input }) => {
        const target = await resolveQueueTarget(
          deps.prisma,
          context.actor,
          await resolveThreadTarget(deps.prisma, context.actor, input),
          input.recipientBotId,
        );
        await allowed(context.actor, target.botId);
        return publish(
          await startQueuedConversationTask(deps.prisma, context.actor, target, input),
        );
      }),
    },
  };
}
