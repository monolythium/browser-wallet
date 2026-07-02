import {
  checkMrvFeeDisplayConformance,
  checkMrvStructuredFeeConformance,
  formatLyth,
  formatNativeReceiptFeeDisplay,
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
  type NativeReceiptFee,
} from "@monolythium/core-sdk";
import { MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI } from "./operator-bounds";

// Native LYTH precision sourced from the SDK (single source of truth) so the
// wallet and chain can never drift on the decimal count. The chain migrated
// 8 → 18 decimals (1 lythoshi == 1 wei); SDK 0.3.15 carries
// `NATIVE_LYTH_DECIMALS = 18` and `LYTHOSHI_PER_LYTH = 10^18`. The wallet
// re-exports them so existing call sites (Send.tsx etc.) keep importing them
// from here.
export { NATIVE_LYTH_DECIMALS, LYTHOSHI_PER_LYTH };
export const FEE_MULTIPLIER_BPS_BASE = 10_000n;

export type NativeFeeDisplaySource = "legacy-compat" | "structured";

export interface NativeFeeDisplay {
  source: NativeFeeDisplaySource;
  totalLythoshi: bigint;
  totalLythoshiDecimal: string;
  lythAmountText: string;
  defaultText: string;
  detailTexts: string[];
}

export type NativeFeeDisplayResult =
  | { ok: true; display: NativeFeeDisplay }
  | { ok: false; reason: string; failures: string[] };

export interface NativeFeeFromBaseAndPriorityInput {
  executionUnitLimitHex: string | null | undefined;
  fallbackExecutionUnitLimitHex?: string;
  basePricePerExecutionUnitLythoshiHex: string | null | undefined;
  priorityPricePerExecutionUnitLythoshiHex: string | null | undefined;
  priorityMultiplierBps?: bigint;
  structuredFee?: unknown;
}

export interface NativeFeeFromPriceInput {
  executionUnitLimitHex: string | null | undefined;
  pricePerExecutionUnitLythoshiHex: string | null | undefined;
  priceMultiplierBps?: bigint;
  structuredFee?: unknown;
}

export interface NativeExecutionFeeSuggestion {
  executionUnitLimitHex: string | null;
  basePricePerExecutionUnitLythoshiHex: string;
  priorityPricePerExecutionUnitLythoshiHex: string;
  structuredFee?: unknown;
}

export function parseNativeHexQuantity(hex: string | null | undefined): bigint | null {
  if (typeof hex !== "string" || hex.length === 0) return null;
  const raw = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (raw.length === 0 || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  try {
    return BigInt(`0x${raw}`);
  } catch {
    return null;
  }
}

export function lythoshiToLythString(lythoshi: bigint): string {
  return formatLyth(nonNegativeLythoshiDecimal(lythoshi), { includeUnit: false });
}

export function formatNativeLythAmount(lythoshi: bigint): string {
  return formatLyth(nonNegativeLythoshiDecimal(lythoshi));
}

export function formatLythoshiAmountHex(hex: string | null | undefined): string {
  const lythoshi = parseNativeHexQuantity(hex);
  return lythoshi === null ? "—" : lythoshiToLythString(lythoshi);
}

export function formatExecutionUnits(hex: string | null | undefined): string {
  const executionUnits = parseNativeHexQuantity(hex);
  return executionUnits === null ? "—" : executionUnits.toString(10);
}

export function formatLythoshiPerExecutionUnit(hex: string | null | undefined): string {
  const lythoshi = parseNativeHexQuantity(hex);
  return lythoshi === null ? "—" : lythoshi.toString(10);
}

export function scaleByBps(value: bigint, multiplierBps: bigint): bigint {
  if (value < 0n || multiplierBps < 0n) return 0n;
  return (value * multiplierBps) / FEE_MULTIPLIER_BPS_BASE;
}

export function nativeFeeDisplayFromExecutionFeeSuggestion(
  fee: NativeExecutionFeeSuggestion,
  options: {
    fallbackExecutionUnitLimitHex: string;
    priorityMultiplierBps?: bigint;
  },
): NativeFeeDisplayResult {
  return nativeFeeDisplayFromBaseAndPriority({
    executionUnitLimitHex: fee.executionUnitLimitHex,
    fallbackExecutionUnitLimitHex: options.fallbackExecutionUnitLimitHex,
    basePricePerExecutionUnitLythoshiHex: fee.basePricePerExecutionUnitLythoshiHex,
    priorityPricePerExecutionUnitLythoshiHex:
      fee.priorityPricePerExecutionUnitLythoshiHex,
    ...(options.priorityMultiplierBps !== undefined
      ? { priorityMultiplierBps: options.priorityMultiplierBps }
      : {}),
    ...(fee.structuredFee !== undefined ? { structuredFee: fee.structuredFee } : {}),
  });
}

export function nativeFeeDisplayFromBaseAndPriority(
  input: NativeFeeFromBaseAndPriorityInput,
): NativeFeeDisplayResult {
  if (input.structuredFee !== undefined) {
    return nativeFeeDisplayFromStructuredFee(input.structuredFee);
  }

  const executionUnits = parseNativeHexQuantity(
    input.executionUnitLimitHex ?? input.fallbackExecutionUnitLimitHex,
  );
  const basePrice = parseNativeHexQuantity(input.basePricePerExecutionUnitLythoshiHex);
  const priorityPrice = parseNativeHexQuantity(
    input.priorityPricePerExecutionUnitLythoshiHex,
  );
  if (executionUnits === null || basePrice === null || priorityPrice === null) {
    return invalidFeeResult("native execution fee fields are malformed");
  }

  const multiplierBps = input.priorityMultiplierBps ?? FEE_MULTIPLIER_BPS_BASE;
  // Match the submit path (Send.tsx): a tier multiplier (e.g. "Slow" 0.5x) must
  // never push the priority tip below the mempool floor. The submit path clamps
  // the SIGNED tip to the floor, so the displayed total (and the Max reservation
  // derived from it) must clamp identically or it under-reports vs the broadcast.
  const tieredPriorityPrice = scaleByBps(priorityPrice, multiplierBps);
  const scaledPriorityPrice =
    tieredPriorityPrice < MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI
      ? MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI
      : tieredPriorityPrice;
  const totalLythoshi = (basePrice + scaledPriorityPrice) * executionUnits;
  return makeNativeFeeDisplay(totalLythoshi, "legacy-compat", [
    `execution units ${executionUnits.toString(10)}`,
    `base price ${basePrice.toString(10)} lythoshi, priority price ${scaledPriorityPrice.toString(10)} lythoshi`,
  ]);
}

export function nativeFeeDisplayFromPrice(
  input: NativeFeeFromPriceInput,
): NativeFeeDisplayResult {
  if (input.structuredFee !== undefined) {
    return nativeFeeDisplayFromStructuredFee(input.structuredFee);
  }

  const executionUnits = parseNativeHexQuantity(input.executionUnitLimitHex);
  const price = parseNativeHexQuantity(input.pricePerExecutionUnitLythoshiHex);
  if (executionUnits === null || price === null) {
    return invalidFeeResult("native execution fee fields are malformed");
  }

  const multiplierBps = input.priceMultiplierBps ?? FEE_MULTIPLIER_BPS_BASE;
  const scaledPrice = scaleByBps(price, multiplierBps);
  return makeNativeFeeDisplay(
    executionUnits * scaledPrice,
    "legacy-compat",
    [
      `execution units ${executionUnits.toString(10)}`,
      `price ${scaledPrice.toString(10)} lythoshi per execution unit`,
    ],
  );
}

export function nativeFeeDisplayFromStructuredFee(
  structuredFee: unknown,
): NativeFeeDisplayResult {
  const structureReport = checkMrvStructuredFeeConformance(structuredFee, {
    label: "structuredFee",
  });
  if (!structureReport.passed) {
    return invalidFeeResult("structured fee object is malformed", structureReport.failures);
  }

  const sdkDisplay = formatNativeReceiptFeeDisplay(structuredFee as NativeReceiptFee);
  const display = makeNativeFeeDisplay(
    BigInt(sdkDisplay.totalLythoshi),
    "structured",
    sdkDisplay.detailTexts,
    structuredFee,
  );
  if (!display.ok) return display;
  return display;
}

export function computeNativeFeeFromPrice(
  input: NativeFeeFromPriceInput,
): bigint | null {
  const result = nativeFeeDisplayFromPrice(input);
  return result.ok ? result.display.totalLythoshi : null;
}

export function computeNativeFeeFromBaseAndPriority(
  input: NativeFeeFromBaseAndPriorityInput,
): bigint | null {
  const result = nativeFeeDisplayFromBaseAndPriority(input);
  return result.ok ? result.display.totalLythoshi : null;
}

function makeNativeFeeDisplay(
  totalLythoshi: bigint,
  source: NativeFeeDisplaySource,
  detailTexts: string[],
  structuredFee?: unknown,
): NativeFeeDisplayResult {
  const totalLythoshiDecimal = nonNegativeLythoshiDecimal(totalLythoshi);
  const defaultText = formatLyth(totalLythoshiDecimal);
  const report = checkMrvFeeDisplayConformance({
    expectedTotalLythoshi: totalLythoshiDecimal,
    defaultFeeText: defaultText,
    detailTexts,
    ...(structuredFee !== undefined ? { structuredFee } : {}),
  });
  if (!report.passed) {
    return invalidFeeResult("fee display failed ADR-0039 conformance", report.failures);
  }

  return {
    ok: true,
    display: {
      source,
      totalLythoshi: BigInt(totalLythoshiDecimal),
      totalLythoshiDecimal,
      lythAmountText: formatLyth(totalLythoshiDecimal, { includeUnit: false }),
      defaultText,
      detailTexts,
    },
  };
}

function invalidFeeResult(reason: string, failures: string[] = [reason]): NativeFeeDisplayResult {
  return { ok: false, reason, failures };
}

function nonNegativeLythoshiDecimal(lythoshi: bigint): string {
  return lythoshi <= 0n ? "0" : lythoshi.toString(10);
}
