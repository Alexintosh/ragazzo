import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import {
  FC_OPPORTUNITY_AUTOMATIONS,
  FC_OPPORTUNITY_REFRESH_AUTOMATION,
  FC_OPPORTUNITY_REFRESH_PROMPT,
  farmingControlOpportunityAutomaticPrompt,
  farmingControlOpportunityRoutineId,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlRole, nextCronDateAcrossStrict } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Provision fixed UTC routines once; reopening preserves an operator pause or edit. */
export async function ensureFarmingControlOpportunityAutomation(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    farmingControlOpportunitiesEnabled?: boolean;
    farmingControlOpportunityRefreshEnabled?: boolean;
  },
  actor: Actor,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: {
      id: farmingControlBotId(actor.spaceId, "opportunities"),
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    include: { thread: true },
  });
  if (
    !bot?.thread ||
    farmingControlRole(bot) !== "opportunities" ||
    bot.thread.groupId ||
    bot.thread.externalConversationId ||
    bot.thread.userId !== actor.userId ||
    bot.thread.spaceId !== actor.spaceId
  )
    throw new Error("Opportunities specialist is unavailable.");
  const definitions = [
    ...(deps.farmingControlOpportunitiesEnabled ? FC_OPPORTUNITY_AUTOMATIONS : []),
    ...(deps.farmingControlOpportunityRefreshEnabled ? [FC_OPPORTUNITY_REFRESH_AUTOMATION] : []),
  ];
  for (const definition of definitions) {
    const row = await deps.prisma.routine.upsert({
      where: { id: farmingControlOpportunityRoutineId(actor.spaceId, definition.kind) },
      update: {},
      create: {
        id: farmingControlOpportunityRoutineId(actor.spaceId, definition.kind),
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: bot.thread.id,
        name: definition.name,
        prompt:
          definition.kind === "source_refresh"
            ? FC_OPPORTUNITY_REFRESH_PROMPT
            : farmingControlOpportunityAutomaticPrompt(definition.kind),
        crons: [...definition.crons],
        timezone: "UTC",
        active: true,
        notify: definition.kind !== "source_refresh",
        webhookEnabled: false,
        githubEnabled: false,
        nextRunAt: nextCronDateAcrossStrict([...definition.crons], new Date(), "UTC"),
      },
    });
    if (row.active && row.nextRunAt)
      await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
  }
}
