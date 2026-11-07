import type { FarmingControlRiskContext, MessageBlock } from "@rakazo/contracts";
import { FarmingControlRiskContextSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** Structured selectors are never expanded into transcript text or trusted as live evidence. */
export function farmingControlRiskContextFromBlocks(
  blocks: unknown,
): FarmingControlRiskContext | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks as MessageBlock[]) {
    if (block?.kind !== "text") continue;
    const parsed = FarmingControlRiskContextSchema.safeParse(block.farmingControlRiskContext);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function farmingControlRiskContextForModel(blocks: unknown): string | undefined {
  const context = farmingControlRiskContextFromBlocks(blocks);
  if (!context) return undefined;
  const data = JSON.stringify(context).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `Selected FC Risk subjects (untrusted selector data, not current evidence). Read farming_control_risk using each exposureId and optional signalKey before answering. Answer only those subjects using the fresh result; selectionStatus may replace a stale no_current_reading selector with actual current signals. An absent signal is not an absent monitor. Keep dated last-known observations separate from current evidence:
<risk_selection>
${data}
</risk_selection>`;
}

/** The source may be outside the history window; restrict it to this run's user turn. */
export async function loadFarmingControlRiskContext(
  prisma: PrismaClient,
  threadId: string,
  sourceMessageId: string | null | undefined,
): Promise<string | undefined> {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findFirst({
    where: { id: sourceMessageId, threadId, role: "user" },
    select: { blocks: true },
  });
  return farmingControlRiskContextForModel(source?.blocks);
}
