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
  signal?: {
    key: string;
    label: string;
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
    ...(signal
      ? {
          signal: {
            key: signal.key,
            label: signal.label,
          },
        }
      : {}),
  };
}
