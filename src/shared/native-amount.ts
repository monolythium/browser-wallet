export const LYTHOSHI_PER_LYTH = 100_000_000n;

export function parseHexQuantity(hex: string | null | undefined): bigint | null {
  if (!hex) return null;
  try {
    return BigInt(hex.startsWith("0x") || hex.startsWith("0X") ? hex : "0x" + hex);
  } catch {
    return null;
  }
}

export function lythoshiToLythDecimal(lythoshi: bigint, decimals = 8): string {
  if (lythoshi <= 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const fraction = lythoshi % LYTHOSHI_PER_LYTH;
  const clampedDecimals = Math.max(0, Math.min(8, Math.trunc(decimals)));
  if (fraction === 0n || clampedDecimals === 0) return whole.toString();
  const fractionText = fraction
    .toString()
    .padStart(8, "0")
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
