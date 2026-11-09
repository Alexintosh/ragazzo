import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { FarmingControlService } from "@rakazo/adapters";
import {
  createFarmingControlRiskRun,
  FarmingControlRiskEventSchema,
  FarmingControlRiskTriggerSchema,
  FC_RISK_AUTOMATIONS,
  farmingControlRiskAutomaticPrompt,
  farmingControlRiskRoutineId,
} from "@rakazo/adapters";
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
import {
  riskAdmissionReceipt,
  riskRunObservation,
  wantsRiskReceiptV2,
} from "./farming-control-risk-receipt.js";
import { readBoundedBody } from "./http-body.js";

type Dependencies = { prisma: PrismaClient; jobs: JobPublisher; events: ThreadEvents };
type RiskScope = {
  actor: Actor;
  bot: { id: string; spawnKey: string | null };
  thread: { id: string };
};
type IntakeOutcome =
  | { reception: "created" | "replayed"; runId: string }
  | { reception: "ignored_stale" | "ignored_unmatched_resolution" | "unavailable"; runId: null };

/** A nonce alone is insufficient: retained trigger and current private scope must agree. */
async function readRiskAdmission(prisma: PrismaClient, scope: RiskScope, eventId: string) {
  const { actor, bot, thread } = scope;
  const run = await prisma.run.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: bot.id,
      threadId: thread.id,
      trigger: "routine",
      clientNonce: `fc-risk:v1:emergency:${eventId}`,
      bot: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        spawnKey: bot.spawnKey,
        archivedAt: null,
      },
      thread: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
        groupId: null,
        externalConversationId: null,
      },
    },
    select: { id: true, status: true },
  });
  if (!run) return null;
  const trigger = await prisma.event.findFirst({
    where: {
      spaceId: actor.spaceId,
      botId: bot.id,
      threadId: thread.id,
      runId: run.id,
      type: "routine.fired",
      payload: { path: ["farmingControlRiskTrigger", "eventId"], equals: eventId },
    },
    select: { payload: true },
  });
  const proof = FarmingControlRiskTriggerSchema.safeParse(
    (trigger?.payload as { farmingControlRiskTrigger?: unknown } | null)?.farmingControlRiskTrigger,
  );
  if (
    !proof.success ||
    proof.data.kind !== "emergency" ||
    proof.data.eventId !== eventId ||
    proof.data.event?.eventId !== eventId ||
    proof.data.monitorKey !== proof.data.event.monitorKey
  )
    return null;
  return run;
}
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
  const trusted = (authorization: string | undefined) =>
    Boolean(
      deps.token &&
        deps.token.length >= 32 &&
        deps.ownerId &&
        deps.farmingControl.configured &&
        hasValidBearerToken(authorization, deps.token),
    );
  async function resolveScope() {
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
      return { error: "Risk specialist unavailable", status: 503 as const };
    const user = await deps.prisma.user.findUnique({
      where: { id: deps.ownerId },
      select: { email: true },
    });
    if (!user) return { error: "Unauthorized", status: 401 as const };
    const actor: Actor = {
      userId: deps.ownerId!,
      spaceId: bot.spaceId,
      email: user.email,
      isDeploymentOwner: false,
    };
    try {
      await deps.farmingControl.authorize(actor);
    } catch {
      return { error: "Unauthorized", status: 401 as const };
    }
    return { actor, bot, thread: bot.thread };
  }

  app.get("/api/v1/farming-control/risk-events/:eventId", async (c) => {
    c.header("cache-control", "no-store");
    if (!trusted(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    const eventId = c.req.param("eventId");
    if (!/^[a-f0-9]{64}$/.test(eventId)) return c.json({ error: "Not found" }, 404);
    const scope = await resolveScope();
    if ("error" in scope) return c.json({ error: scope.error }, scope.status);
    const run = await readRiskAdmission(deps.prisma, scope, eventId);
    if (!run) return c.json({ error: "Not found" }, 404);
    const observation = riskRunObservation(run.status);
    return c.json({
      schemaVersion: "fc-risk-status.v2",
      eventId,
      asOfMs: Date.now(),
      run: { id: run.id, status: observation.status },
      analysis: observation.analysis,
    });
  });

  app.post("/api/v1/farming-control/risk-events", async (c) => {
    c.header("cache-control", "no-store");
    c.header("vary", "Accept");
    if (!trusted(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
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
    const scope = await resolveScope();
    if ("error" in scope) return c.json({ error: scope.error }, scope.status);
    const { actor, bot, thread } = scope;
    const outcome = await deps.prisma.$transaction(async (tx): Promise<IntakeOutcome> => {
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
      if (claimed.count !== 1) return { reception: "unavailable", runId: null };
      const replay = await tx.run.findUnique({
        where: {
          spaceId_clientNonce: {
            spaceId: actor.spaceId,
            clientNonce: `fc-risk:v1:emergency:${event.eventId}`,
          },
        },
        select: { id: true },
      });
      if (replay) return { reception: "replayed", runId: replay.id };
      const prior = await tx.event.findFirst({
        where: {
          botId: bot.id,
          spaceId: actor.spaceId,
          threadId: thread.id,
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
        if (last.eventId === event.eventId)
          return prior?.runId
            ? { reception: "replayed", runId: prior.runId }
            : { reception: "unavailable", runId: null };
        const phase = { opened: 0, updated: 1, resolved: 2 };
        const severityPhase = { critical: 0, warning: 1, info: 2 };
        const order =
          event.episodeOpenedAtMs - last.episodeOpenedAtMs ||
          event.occurredAtMs - last.occurredAtMs ||
          phase[event.transition] - phase[last.transition] ||
          severityPhase[event.severity] - severityPhase[last.severity] ||
          event.eventId.localeCompare(last.eventId);
        if (event.transition === "resolved" && event.episodeOpenedAtMs !== last.episodeOpenedAtMs)
          return { reception: "ignored_unmatched_resolution", runId: null };
        if (order <= 0) return { reception: "ignored_stale", runId: null };
      }
      const run = await createFarmingControlRiskRun(
        tx,
        actor,
        { id: bot.id, threadId: thread.id },
        {
          schemaVersion: "fc-risk-trigger.v1",
          kind: "emergency",
          eventId: event.eventId,
          monitorKey: event.monitorKey,
          event,
        },
      );
      return { reception: "created", runId: run.id };
    });
    let wake: "requested" | "recovery_required" = "requested";
    if (outcome.runId) {
      try {
        await deps.jobs.enqueue(runContinueJob(outcome.runId));
      } catch {
        wake = "recovery_required";
        getLogger().error("FC emergency run wake failed; durable run requires recovery");
      }
    }
    if (!wantsRiskReceiptV2(c.req.header("accept")))
      return c.json({ accepted: true, runId: outcome.runId }, 202);
    if (outcome.reception === "unavailable")
      return c.json({ error: "Risk specialist unavailable" }, 503);
    if (outcome.runId === null)
      return c.json(
        riskAdmissionReceipt(event.eventId, {
          reception: outcome.reception,
          run: null,
          wake: "not_applicable",
        }),
        202,
      );
    const run = await readRiskAdmission(deps.prisma, scope, event.eventId);
    if (!run || run.id !== outcome.runId)
      return c.json({ error: "Risk specialist unavailable" }, 503);
    return c.json(
      riskAdmissionReceipt(event.eventId, { reception: outcome.reception, run, wake }),
      202,
    );
  });
}
