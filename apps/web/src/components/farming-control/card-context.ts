import type { FarmingControlRiskExposure, FarmingControlRiskSignal } from "@rakazo/contracts";
import type { ComposerMentionBinding, FarmingControlRole } from "@rakazo/core";
import type { ChatTarget } from "../../lib/query";

/** Card owners select a specialist by stable role; labels never select a chat identity. */
export type FarmingControlAskContext = {
  owner?: FarmingControlRole;
  entityType?: string;
  entityId?: string;
  exposureId?: string;
  label?: string;
  positionId?: string;
  subject?: { kind: string; id: string; address?: string | null };
  protocol?: string;
  chainId?: number;
  positionIds?: string[];
  observedAtMs?: number | null;
  collectedAtMs?: number | null;
  signal?: {
    key: string;
    label: string;
    status: string;
    coverage: string;
    value: string | null;
    format: string;
    unit: string | null;
    threshold?: string | null;
  };
};

/** The shell stages this in the ordinary editable composer. It never submits the message. */
export type FarmingControlChatDraft = {
  target: ChatTarget;
  text: string;
  bindings?: ComposerMentionBinding[];
};

export function riskCardContext(
  card: FarmingControlRiskExposure,
  signal?: FarmingControlRiskSignal,
): FarmingControlAskContext {
  return {
    owner: "risk",
    exposureId: card.id,
    label: card.label,
    subject: card.subject,
    protocol: card.protocol,
    chainId: card.chainId,
    positionIds: card.positions.map((position) => position.id),
    observedAtMs: card.observedAtMs,
    collectedAtMs: card.collectedAtMs,
    ...(signal
      ? {
          signal: {
            key: signal.key,
            label: signal.label,
            status: signal.status,
            coverage: signal.coverage,
            value: signal.value,
            format: signal.format,
            unit: signal.unit,
          },
        }
      : {}),
  };
}
