import type { AgentActivityEntry } from "@rakazo/contracts";
import {
  AGENT_ACTIVITY_EVENT_TYPES,
  BACKGROUND_RUN_TRIGGERS,
  reduceAgentActivity,
  settleAgentActivity,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/** Called only within the authorized thread snapshot transaction. No raw tool payloads. */
export async function loadThreadAgentActivity(
  tx: Prisma.TransactionClient,
  threadId: string,
  activeRuns: readonly { id: string; status: string; trigger: string }[] = [],
) {
  const recentRuns = await tx.run.findMany({
    where: { threadId, trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
    select: { id: true, status: true },
  });
  const runs = [
    ...new Map(
      [
        ...recentRuns,
        ...activeRuns.filter(
          (run) =>
            run.trigger !== "bot_message" &&
            !BACKGROUND_RUN_TRIGGERS.some((trigger) => trigger === run.trigger),
        ),
      ].map((run) => [run.id, run]),
    ).values(),
  ];
  if (!runs.length) return [];
  const events = await tx.event.findMany({
    where: {
      threadId,
      runId: { in: runs.map((run) => run.id) },
      type: { in: [...AGENT_ACTIVITY_EVENT_TYPES] },
    },
    orderBy: { seq: "desc" },
    take: 400,
    select: { id: true, runId: true, botId: true, seq: true, type: true, payload: true },
  });
  return settleAgentActivity(
    events.reverse().reduce<AgentActivityEntry[]>(reduceAgentActivity, []),
    runs,
  );
}
