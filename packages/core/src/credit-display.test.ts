import { expect, it } from "vitest";
import { creditAmountInput, formatCreditAmount, parseCreditAmount } from "./credit-display.js";

it("parses exact signed credit deltas and rejects rounding or exponent input", () => {
  expect(parseCreditAmount(" -12.345 ")).toBe("-12345");
  expect(parseCreditAmount("0.001")).toBe("1");
  expect(parseCreditAmount("1.0001")).toBeNull();
  expect(parseCreditAmount("1e3")).toBeNull();
  expect(parseCreditAmount("9000000000000")).toBe("9000000000000000");
  expect(parseCreditAmount("9000000000000.001")).toBeNull();
  expect(parseCreditAmount("1000000000000000")).toBeNull();
});
it("formats large balances exactly and respects decimal locale", () => {
  expect(formatCreditAmount("999999999999999999", "en-US")).toBe("999,999,999,999,999.999");
  expect(formatCreditAmount("-1", "de-DE")).toBe("-0,001");
  expect(creditAmountInput("12000")).toBe("12");
  expect(creditAmountInput("-12345")).toBe("-12.345");
});
