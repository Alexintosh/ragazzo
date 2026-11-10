import { expect, it } from "vitest";
import {
  RISK_RECEIPT_MEDIA_TYPE,
  riskRunObservation,
  wantsRiskReceiptV2,
} from "./farming-control-risk-receipt.js";

it("requires an explicit acceptable v2 media type", () => {
  for (const accept of [
    undefined,
    "",
    "*/*",
    "application/json",
    `${RISK_RECEIPT_MEDIA_TYPE};q=0`,
    `${RISK_RECEIPT_MEDIA_TYPE};q=invalid`,
  ])
    expect(wantsRiskReceiptV2(accept)).toBe(false);
  for (const accept of [
    RISK_RECEIPT_MEDIA_TYPE,
    RISK_RECEIPT_MEDIA_TYPE.toUpperCase(),
    `application/json, ${RISK_RECEIPT_MEDIA_TYPE}; q=0.8`,
  ])
    expect(wantsRiskReceiptV2(accept)).toBe(true);
});

it("uses only known run status evidence and exposes no final message reference", () => {
  for (const status of ["queued", "leased", "running", "waiting_input", "waiting_takeover"])
    expect(riskRunObservation(status)).toEqual({
      status,
      analysis: { status: "pending", messageId: null },
    });
  for (const status of ["failed", "cancelled"])
    expect(riskRunObservation(status).analysis).toEqual({ status: "failed", messageId: null });
  expect(riskRunObservation("completed")).toEqual({
    status: "completed",
    analysis: { status: "indeterminate", messageId: null },
  });
  expect(riskRunObservation("future-status")).toEqual({
    status: null,
    analysis: { status: "indeterminate", messageId: null },
  });
});
