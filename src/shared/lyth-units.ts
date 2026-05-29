// Canonical lythoshi (10^8 per LYTH) → decimal-LYTH string formatting.
//
// Lives in `shared/` (no `background/` import) so BOTH the background
// pending-row writer (via wei-decimal.ts) and the popup-facing activity
// mapper (shared/activity.ts) produce byte-identical amount strings. The
// reconcilePending exact-string-equality match (shared/activity.ts) depends
// on the two sides agreeing to the byte.

export const LYTHOSHI_PER_LYTH = 100_000_000n;
const LYTHOSHI_DECIMALS = 8;

/** Non-negative lythoshi bigint → decimal LYTH string. Trailing zeros are
 *  trimmed and the decimal point is omitted when the fractional part is zero.
 *  Negative input clamps to "0". */
export function formatLythoshiToLythDecimal(lythoshi: bigint): string {
  if (lythoshi < 0n) return "0";
  const intPart = lythoshi / LYTHOSHI_PER_LYTH;
  const fracPart = lythoshi % LYTHOSHI_PER_LYTH;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart
    .toString()
    .padStart(LYTHOSHI_DECIMALS, "0")
    .replace(/0+$/, "");
  return fracStr.length === 0
    ? intPart.toString()
    : `${intPart.toString()}.${fracStr}`;
}

/** Decimal lythoshi string (e.g. the indexer's `"1000000"`) → decimal LYTH
 *  (`"0.01"`). Returns "0" for malformed input. Output is byte-identical to
 *  `lythoshiHexToLythDecimal` for the same magnitude. */
export function lythoshiDecimalToLythDecimal(lythoshiDec: string): string {
  if (!/^[0-9]+$/.test(lythoshiDec)) return "0";
  return formatLythoshiToLythDecimal(BigInt(lythoshiDec));
}
