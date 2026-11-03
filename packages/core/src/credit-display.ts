import { CREDIT_MICROS_PER_CREDIT, MAX_CREDIT_MICROS } from "@rakazo/contracts";

const unit = BigInt(CREDIT_MICROS_PER_CREDIT);

/** Exact decimal credits; never round a user-entered adjustment. */
export function parseCreditAmount(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[2]!) * unit + BigInt((match[3] ?? "").padEnd(3, "0"));
  const result = `${match[1] === "-" && amount !== 0n ? "-" : ""}${amount}`;
  return amount <= MAX_CREDIT_MICROS ? result : null;
}

export function creditAmountInput(micros: string): string {
  const value = BigInt(micros);
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % unit)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / unit}${fraction ? `.${fraction}` : ""}`;
}

/** Locale-aware grouping and decimals without losing precision on large balances. */
export function formatCreditAmount(micros: string, locale: string): string {
  const value = BigInt(micros);
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % unit)
    .padStart(3, "0")
    .replace(/0+$/, "");
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 }).formatToParts(
    value < 0n ? -1 : 1,
  );
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const minus = parts.find((part) => part.type === "minusSign")?.value ?? "-";
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(absolute / unit);
  const digits = new Intl.NumberFormat(locale, { useGrouping: false });
  const localizedFraction = [...fraction].map((digit) => digits.format(Number(digit))).join("");
  return `${value < 0n ? minus : ""}${whole}${fraction ? decimal + localizedFraction : ""}`;
}
