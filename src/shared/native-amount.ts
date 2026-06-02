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

export function hexLythoshiToLythNumber(hex: string | null | undefined): number | null {
  const lythoshi = parseHexQuantity(hex);
  return lythoshi == null ? null : lythoshiToLythNumber(lythoshi);
}
