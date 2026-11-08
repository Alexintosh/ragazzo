/** Bounded exact decimal arithmetic shared by observed financial and rate summaries. */
const MAX_SCALE = 10_000;
function sumParts(values: readonly string[]): { coefficient: bigint; scale: number } {
  if (values.length > 256_000) throw new RangeError("Decimal input budget exceeded");
  const parts = values.map((value) => {
    if (value.length > 12_000) throw new RangeError("Decimal length budget exceeded");
    const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match) throw new RangeError("Invalid decimal");
    const exponent = Number(match[3] ?? "0");
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_SCALE)
      throw new RangeError("Decimal exponent budget exceeded");
    const [whole = "", fraction = ""] = (match[2] ?? "").split(".");
    let coefficient = BigInt(`${whole}${fraction}`);
    if (match[1] === "-") coefficient = -coefficient;
    const scale = fraction.length - exponent;
    if (Math.abs(scale) > MAX_SCALE) throw new RangeError("Decimal scale budget exceeded");
    return { coefficient, scale };
  });
  let scale = 0;
  for (const part of parts) scale = Math.max(scale, part.scale);
  let coefficient = 0n;
  for (const part of parts) coefficient += part.coefficient * 10n ** BigInt(scale - part.scale);
  return { coefficient, scale };
}
function format(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? "-" : "";
  const digits = (coefficient < 0n ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  if (scale === 0) {
    if (digits.length + sign.length > 12_000)
      throw new RangeError("Decimal output budget exceeded");
    return `${sign}${digits}`;
  }
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  const result = `${sign}${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ""}`;
  if (result.length > 12_000) throw new RangeError("Decimal output budget exceeded");
  return result;
}
export function exactSum(values: readonly string[]): string {
  const { coefficient, scale } = sumParts(values);
  return format(coefficient, scale);
}
/** Equal-weight arithmetic mean, truncated toward zero at at most fractionalDigits places. */
export function exactMean(values: readonly string[], fractionalDigits = 18): string {
  if (
    !values.length ||
    !Number.isSafeInteger(fractionalDigits) ||
    fractionalDigits < 0 ||
    fractionalDigits > MAX_SCALE
  )
    throw new RangeError("Invalid decimal mean size or precision");
  const { coefficient, scale } = sumParts(values);
  const scaled =
    scale <= fractionalDigits
      ? (coefficient * 10n ** BigInt(fractionalDigits - scale)) / BigInt(values.length)
      : coefficient / (BigInt(values.length) * 10n ** BigInt(scale - fractionalDigits));
  return format(scaled, fractionalDigits);
}
