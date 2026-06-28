// Native LYTH precision is sourced from the SDK so the wallet and chain can
// never drift on the decimal count. The chain migrated 8 → 18 decimals
// (1 lythoshi == 1 wei); SDK 0.3.15 carries `LYTHOSHI_PER_LYTH = 10^18` and
// `NATIVE_LYTH_DECIMALS = 18`.
import {
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
} from "@monolythium/core-sdk";

export { LYTHOSHI_PER_LYTH, NATIVE_LYTH_DECIMALS };

export function parseHexQuantity(hex: string | null | undefined): bigint | null {
  if (!hex) return null;
  try {
    return BigInt(hex.startsWith("0x") || hex.startsWith("0X") ? hex : "0x" + hex);
  } catch {
    return null;
  }
}

export function lythoshiToLythDecimal(
  lythoshi: bigint,
  decimals: number = NATIVE_LYTH_DECIMALS,
): string {
  if (lythoshi <= 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const fraction = lythoshi % LYTHOSHI_PER_LYTH;
  const clampedDecimals = Math.max(0, Math.min(NATIVE_LYTH_DECIMALS, Math.trunc(decimals)));
  if (fraction === 0n || clampedDecimals === 0) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, clampedDecimals)
    .replace(/0+$/, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

export function lythoshiToLythNumber(lythoshi: bigint): number {
  return Number(lythoshi) / Number(LYTHOSHI_PER_LYTH);
}

/** Exact LYTH display from a balance lythoshi, TRUNCATED (never rounded — the
 *  BPS-cap-safe direction) to `dp` fractional digits and ZERO-PADDED to exactly
 *  `dp` (e.g. 2 → "99.99" / "100.00" / "0.00"). Bigint math throughout — no lossy
 *  `Number(lythoshi)/Number(1e18)` float. The integer part is grouped via
 *  toLocaleString (matching the prior `fmt` hero); the decimal separator is
 *  always ".". Display-only. Differs from `lythoshiToLythDecimal` only in that it
 *  pads (not strips) trailing zeros, so the hero stays a clean fixed-`dp` figure. */
export function lythoshiToLythFixed(lythoshi: bigint, dp = 2): string {
  const places = Math.max(0, Math.min(NATIVE_LYTH_DECIMALS, Math.trunc(dp)));
  const neg = lythoshi < 0n;
  const abs = neg ? -lythoshi : lythoshi;
  const whole = abs / LYTHOSHI_PER_LYTH;
  const frac = (abs % LYTHOSHI_PER_LYTH)
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, places);
  const body = places > 0 ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
  return neg ? `-${body}` : body;
}

/** Home "Available" display: the exact spendable balance, truncated to `dp`. */
export function homeAvailableDisplay(balanceLythoshi: bigint, dp = 2): string {
  return lythoshiToLythFixed(balanceLythoshi, dp);
}

/** Home Rewards-chip / hero display value, NO-MOCK gated. Returns the 2dp-truncated
 *  LYTH string ONLY for a LIVE read — a present `totalAmountLythoshi` from a
 *  non-mock fetch — INCLUDING a live zero ("0.00"). Returns `null` (→ render a
 *  muted "—", and hide the fiat) for a mock / error / absent read; the illustrative
 *  mock fallback figure is NEVER shown. */
export function rewardsHeroValue(
  totalAmountLythoshi: string | null | undefined,
  isMock: boolean,
  dp = 2,
): string | null {
  if (totalAmountLythoshi == null || isMock) return null;
  try {
    return lythoshiToLythFixed(BigInt(totalAmountLythoshi), dp);
  } catch {
    return null;
  }
}

/** Home "Delegated" display: the exact delegated effective weight
 *  (balance × totalBps/10000, bigint math), truncated to `dp`. Non-custodial —
 *  the LYTH stays spendable; this is the weighted contribution, not an escrow. */
export function homeDelegatedDisplay(
  balanceLythoshi: bigint,
  totalBps: number,
  dp = 2,
): string {
  const delegated = (balanceLythoshi * BigInt(totalBps)) / 10_000n;
  return lythoshiToLythFixed(delegated, dp);
}

export function hexLythoshiToLythNumber(hex: string | null | undefined): number | null {
  const lythoshi = parseHexQuantity(hex);
  return lythoshi == null ? null : lythoshiToLythNumber(lythoshi);
}
