import type { Actor, FarmingControlRiskInterpretations } from "@rakazo/contracts";
import { RunStatus } from "@rakazo/contracts";
import { farmingControlBotId, farmingControlRole } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { FarmingControlRiskTriggerSchema } from "./farming-control-risk-automation.js";

export type RiskInterpretationDb = Pick<PrismaClient, "bot" | "run" | "event">;

/** Same fixed private Run/trigger repositories as R3; no content or final-output inference. */
export async function readFarmingControlRiskInterpretations(
  prisma: RiskInterpretationDb,
  actor: Actor,
  monitorKey: string,
  fromMs: number,
  throughMs: number,
): Promise<FarmingControlRiskInterpretations> {
  const output: FarmingControlRiskInterpretations = {
    state: "partial",
    asOfMs: Date.now(),
    truncated: false,
    runs: [],
    limitations: [
      "Only surviving correlated Risk runs in this bounded read are shown; absence does not prove no analysis or no incident.",
      "Completed runs lack a verified final-output reference and remain indeterminate. No message link or content is exposed.",
    ],
  };
  try {
    const bot = await prisma.bot.findFirst({
      where: {
        id: farmingControlBotId(actor.spaceId, "risk"),
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        spawnKey: true,
        archivedAt: true,
        thread: {
          select: {
            id: true,
            botId: true,
            userId: true,
            spaceId: true,
            groupId: true,
            externalConversationId: true,
          },
        },
      },
    });
    const thread = bot?.thread;
    if (
      !bot ||
      bot.archivedAt ||
      farmingControlRole(bot) !== "risk" ||
      bot.userId !== actor.userId ||
      bot.spaceId !== actor.spaceId ||
      !thread ||
      thread.botId !== bot.id ||
      thread.userId !== actor.userId ||
      thread.spaceId !== actor.spaceId ||
      thread.groupId ||
      thread.externalConversationId
    ) {
      output.state = "unavailable";
      return output;
    }
    const runs = await prisma.run.findMany({
      where: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        trigger: "routine",
        clientNonce: { startsWith: "fc-risk:v1:" },
        createdAt: { gte: new Date(fromMs), lte: new Date(throughMs) },
        bot: {
          archivedAt: null,
          spawnKey: bot.spawnKey,
          userId: actor.userId,
          spaceId: actor.spaceId,
        },
        thread: {
          botId: bot.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          groupId: null,
          externalConversationId: null,
        },
      },
      select: { id: true, status: true, clientNonce: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 41,
    });
    output.truncated = runs.length > 40;
    const admitted = runs.slice(0, 40);
    if (!admitted.length) return output;
    const triggers = await prisma.event.findMany({
      where: {
        spaceId: actor.spaceId,
        botId: bot.id,
        threadId: thread.id,
        runId: { in: admitted.map((run) => run.id) },
        type: "routine.fired",
      },
      select: { runId: true, payload: true },
      take: 81,
    });
    if (triggers.length > 80) output.truncated = true;
    for (const run of admitted) {
      const proofs = triggers
        .filter((trigger) => trigger.runId === run.id)
        .map((trigger) =>
          FarmingControlRiskTriggerSchema.safeParse(
            (trigger.payload as { farmingControlRiskTrigger?: unknown } | null)
              ?.farmingControlRiskTrigger,
          ),
        );
      if (proofs.length !== 1 || !proofs[0]?.success) continue;
      const proof = proofs[0].data;
      if (run.clientNonce !== `fc-risk:v1:${proof.kind}:${proof.eventId}`) continue;
      const e = proof.event;
      if (
        proof.kind === "emergency" &&
        (!e || e.eventId !== proof.eventId || proof.monitorKey !== e.monitorKey)
      )
        continue;
      const weekly = proof.kind === "weekly_review" && proof.monitorKey === null;
      const matches =
        proof.monitorKey === monitorKey ||
        proof.subjects?.some((subject) => subject.monitorKey === monitorKey);
      if (!matches && !weekly) continue;
      const parsed = RunStatus.safeParse(run.status);
      const status = parsed.success ? parsed.data : null;
      output.runs.push({
        runId: run.id,
        eventId: proof.eventId,
        kind: proof.kind,
        scope: matches ? "selected_monitor" : "monitoring_universe",
        triggeredAtMs: run.createdAt.getTime(),
        occurredAtMs: e?.occurredAtMs ?? null,
        episodeOpenedAtMs: e?.episodeOpenedAtMs ?? null,
        subjectKey: e?.subjectKey ?? null,
        policyKey: e?.policyKey ?? null,
        transition: e?.transition ?? null,
        runStatus: status,
        analysisStatus:
          status === null || status === "completed"
            ? "indeterminate"
            : status === "failed" || status === "cancelled"
              ? "failed"
              : "pending",
        messageId: null,
      });
    }
    return output;
  } catch {
    return { ...output, state: "unavailable", runs: [], truncated: true };
  }
}
