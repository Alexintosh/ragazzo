import { RunStatus } from "@rakazo/contracts";

export const RISK_RECEIPT_MEDIA_TYPE = "application/vnd.fc-risk-receipt.v2+json";

/** Wildcards and absent negotiation retain the exact legacy response. */
export function wantsRiskReceiptV2(accept: string | undefined): boolean {
  return Boolean(
    accept?.split(",").some((entry) => {
      const [media, ...parameters] = entry.trim().toLowerCase().split(";");
      if (media?.trim() !== RISK_RECEIPT_MEDIA_TYPE) return false;
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      if (quality === undefined) return true;
      const value = Number(quality.trim().slice(2));
      return Number.isFinite(value) && value > 0 && value <= 1;
    }),
  );
}

export function riskRunObservation(status: string | null) {
  const parsed = RunStatus.safeParse(status);
  const observed = parsed.success ? parsed.data : null;
  // Existing completion events have no final-output reference. Neither a completed
  // run nor firstResponseAt nor a message in its thread proves a final analysis.
  const analysis =
    observed === "failed" || observed === "cancelled"
      ? ("failed" as const)
      : observed === null || observed === "completed"
        ? ("indeterminate" as const)
        : ("pending" as const);
  return { status: observed, analysis: { status: analysis, messageId: null } };
}

type ReceiptInput =
  | {
      reception: "created" | "replayed";
      run: { id: string; status: string | null };
      wake: "requested" | "recovery_required";
    }
  | {
      reception: "ignored_stale" | "ignored_unmatched_resolution";
      run: null;
      wake: "not_applicable";
    };

export function riskAdmissionReceipt(eventId: string, input: ReceiptInput) {
  const observation = input.run ? riskRunObservation(input.run.status) : null;
  return {
    accepted: true as const,
    runId: input.run?.id ?? null,
    receipt: {
      schemaVersion: "fc-risk-receipt.v2" as const,
      eventId,
      reception: input.reception,
      run: { id: input.run?.id ?? null, status: observation?.status ?? null, wake: input.wake },
      analysis: observation?.analysis ?? { status: "not_requested" as const, messageId: null },
    },
  };
}
