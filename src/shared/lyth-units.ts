// Canonical lythoshi (10^18 per LYTH) → decimal-LYTH string formatting.
//
// Lives in `shared/` (no `background/` import) so BOTH the background
// pending-row writer (via wei-decimal.ts) and the popup-facing activity
// mapper (shared/activity.ts) produce byte-identical amount strings. The
// reconcilePending exact-string-equality match (shared/activity.ts) depends
// on the two sides agreeing to the byte.

// Native LYTH precision sourced from the SDK (single source of truth) so the
// wallet and chain never drift. Chain migrated 8 → 18 decimals
// (1 lythoshi == 1 wei); SDK 0.3.15 carries `LYTHOSHI_PER_LYTH = 10^18`.
import {
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
} from "@monolythium/core-sdk";

export { LYTHOSHI_PER_LYTH };
const LYTHOSHI_DECIMALS = NATIVE_LYTH_DECIMALS;

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

/** Truncate a decimal-LYTH string (e.g. "0.980035894719687092") to at most
 *  `decimals` fractional digits for DISPLAY — TRUNCATION (not rounding) +
 *  trailing-zero trim, matching `lythoshiToLyth(x, decimals)`. The canonical
 *  full-precision value stays in the store; this is display-only. A string with
 *  no fraction (or a malformed one) passes through unchanged. */
export function formatLythDecimalDisplay(s: string, decimals = 4): string {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return s;
  const dot = s.indexOf(".");
  if (dot < 0) return s;
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1, dot + 1 + decimals).replace(/0+$/, "");
  return frac.length === 0 ? intPart : `${intPart}.${frac}`;
}
