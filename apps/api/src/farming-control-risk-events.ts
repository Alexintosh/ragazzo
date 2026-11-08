import { routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  createFarmingControlRiskRun,
  FC_RISK_AUTOMATIONS,
  FarmingControlRiskEventSchema,
  FarmingControlRiskTriggerSchema,
  farmingControlRiskAutomaticPrompt,
  farmingControlRiskRoutineId,
} from "@rakazo/adapters";
import type { FarmingControlService } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  farmingControlBotId,
  farmingControlRole,
  hasValidBearerToken,
  nextCronDateAcrossStrict,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

type Dependencies = { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents };
/** Idempotent opt-in provisioning uses the ordinary routine scheduler and worker recovery. */
export async function ensureFarmingControlRiskAutomation(deps: Dependencies, actor: Actor) {
  const bot = await deps.prisma.bot.findFirst({
    where: {
      id: farmingControlBotId(actor.spaceId, "risk"),
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    include: { thread: true },
  });
  if (!bot?.thread || farmingControlRole(bot) !== "risk")
    throw new Error("Risk specialist is unavailable.");
  for (const definition of FC_RISK_AUTOMATIONS) {
    const id = farmingControlRiskRoutineId(actor.spaceId, definition.kind);
    const row = await deps.prisma.routine.upsert({
      where: { id },
      update: {},
      create: {
        id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        threadId: bot.thread.id,
        name: definition.name,
        prompt: farmingControlRiskAutomaticPrompt(definition.kind),
        crons: [...definition.crons],
        timezone: "UTC",
        active: true,
        notify: true,
        webhookEnabled: false,
        githubEnabled: false,
        nextRunAt: nextCronDateAcrossStrict([...definition.crons], new Date(), "UTC"),
      },
    });
    // Reopening the team preserves a deliberate pause or edited configuration.
    if (row.active && row.nextRunAt)
      await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
  }
}

/** Dedicated bearer authenticates one fixed Risk capability; ordinary webhook credentials never reach it. */
export function mountFarmingControlRiskEvents(
  app: Hono,
  deps: Dependencies & {
    farmingControl: FarmingControlService;
    ownerId: string | undefined;
    token: string | undefined;
  },
) {
  app.post("/api/v1/farming-control/risk-events", async (c) => {
    if (
      !deps.token ||
      deps.token.length < 32 ||
      !deps.ownerId ||
      !deps.farmingControl.configured ||
      !hasValidBearerToken(c.req.header("authorization"), deps.token)
    )
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 8192);
    if (body === null) return c.json({ error: "Payload too large" }, 413);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return c.json({ error: "Invalid event" }, 400);
    }
    const parsed = FarmingControlRiskEventSchema.safeParse(json);
    if (!parsed.success || parsed.data.occurredAtMs > Date.now() + 60_000)
      return c.json({ error: "Invalid event" }, 400);
    const event = parsed.data;
    const bot = await deps.prisma.bot.findFirst({
      where: {
        id: { startsWith: "fc-specialist:", endsWith: ":risk" },
        userId: deps.ownerId,
        archivedAt: null,
      },
      include: { thread: true },
    });
    if (
      !bot?.thread ||
      farmingControlRole(bot) !== "risk" ||
      bot.thread.externalConversationId ||
      bot.thread.groupId ||
      bot.thread.userId !== deps.ownerId ||
      bot.thread.spaceId !== bot.spaceId
    )
      return c.json({ error: "Risk specialist unavailable" }, 503);
    const user = await deps.prisma.user.findUnique({
      where: { id: deps.ownerId },
      select: { email: true },
    });
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const actor: Actor = {
      userId: deps.ownerId,
      spaceId: bot.spaceId,
      email: user.email,
      isDeploymentOwner: false,
    };
    try {
      await deps.farmingControl.authorize(actor);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const run = await deps.prisma.$transaction(async (tx) => {
      // A bot-local Postgres claim serializes duplicate and out-of-order deliveries across API instances.
      const claimed = await tx.bot.updateMany({
        where: {
          id: bot.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          spawnKey: bot.spawnKey,
          archivedAt: null,
        },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const replay = await tx.run.findUnique({
        where: {
          spaceId_clientNonce: {
            spaceId: actor.spaceId,
            clientNonce: `fc-risk:v1:emergency:${event.eventId}`,
          },
        },
        select: { id: true },
      });
      if (replay) return replay;
      const prior = await tx.event.findFirst({
        where: {
          botId: bot.id,
          spaceId: actor.spaceId,
          threadId: bot.thread!.id,
          type: "routine.fired",
          AND: [
            {
              payload: {
                path: ["farmingControlRiskTrigger", "monitorKey"],
                equals: event.monitorKey,
              },
            },
            {
              payload: {
                path: ["farmingControlRiskTrigger", "event", "subjectKey"],
                equals: event.subjectKey,
              },
            },
            {
              payload: {
                path: ["farmingControlRiskTrigger", "event", "policyKey"],
                equals: event.policyKey,
              },
            },
          ],
        },
        orderBy: { seq: "desc" },
        select: { payload: true, runId: true },
      });
      const proof = FarmingControlRiskTriggerSchema.safeParse(
        (prior?.payload as { farmingControlRiskTrigger?: unknown } | null)
          ?.farmingControlRiskTrigger,
      );
      if (proof.success && proof.data.event) {
        const last = proof.data.event;
        if (last.eventId === event.eventId) return prior?.runId ? { id: prior.runId } : null;
        const phase = { opened: 0, updated: 1, resolved: 2 };
        const severityPhase = { critical: 0, warning: 1, info: 2 };
        const order =
          event.episodeOpenedAtMs - last.episodeOpenedAtMs ||
          event.occurredAtMs - last.occurredAtMs ||
          phase[event.transition] - phase[last.transition] ||
          severityPhase[event.severity] - severityPhase[last.severity] ||
          event.eventId.localeCompare(last.eventId);
        if (
          order <= 0 ||
          (event.transition === "resolved" && event.episodeOpenedAtMs !== last.episodeOpenedAtMs)
        )
          return null;
      }
      return createFarmingControlRiskRun(
        tx,
        actor,
        { id: bot.id, threadId: bot.thread!.id },
        {
          schemaVersion: "fc-risk-trigger.v1",
          kind: "emergency",
          eventId: event.eventId,
          monitorKey: event.monitorKey,
          event,
        },
      );
    });
    if (run)
      await deps.jobs
        .enqueue(runContinueJob(run.id))
        .catch((error) => getLogger().error("FC emergency run wake", error));
    return c.json({ accepted: true, runId: run?.id ?? null }, 202);
  });
}
