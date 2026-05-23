// Hex-lythoshi → decimal-LYTH string conversion used by the SW's pending-row
// pre-prepend in service-worker.ts:persistPendingRowBackground.
//
// Lives in its own file so the byte-equality golden test
// (src/background/wei-decimal.test.ts) can import the helper without
// dragging in the SW's module-scope chrome.* references.

const LYTHOSHI_PER_LYTH = 100_000_000n;
const LYTHOSHI_DECIMALS = 8;

/** Hex lythoshi → decimal LYTH string (trimming trailing zeros, no decimal
 *  point when fractional part is zero). The string output is the
 *  `amountDecimal` field on PendingTxRow; it must match the indexer's
 *  native `AddressActivityEntry.amount` byte-for-byte for reconcilePending
 *  in shared/activity.ts to fire. */
export function lythoshiHexToLythDecimal(lythoshiHex: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(lythoshiHex)) return "0";
  let lythoshi: bigint;
  try {
    lythoshi = BigInt(lythoshiHex);
  } catch {
    return "0";
  }
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

/** @deprecated Compatibility export for the service-worker IPC field
 *  `valueWeiHex`, which now carries native lythoshi for LYTH sends. */
export function weiHexToLythDecimal(valueWeiHex: string): string {
  return lythoshiHexToLythDecimal(valueWeiHex);
}
