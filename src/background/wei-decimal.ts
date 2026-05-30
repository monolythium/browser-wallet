// Hex-lythoshi → decimal-LYTH string conversion used by the SW's pending-row
// pre-prepend in service-worker.ts:persistPendingRowBackground.
//
// Lives in its own file so the byte-equality golden test
// (src/background/wei-decimal.test.ts) can import the helper without
// dragging in the SW's module-scope chrome.* references.

import { formatLythoshiToLythDecimal } from "../shared/lyth-units.js";

/** Hex lythoshi → decimal LYTH string (trimming trailing zeros, no decimal
 *  point when fractional part is zero). The string output is the
 *  `amountDecimal` field on PendingTxRow; it must match the confirmed-side
 *  amount the activity mapper produces byte-for-byte — both convert via
 *  shared/lyth-units.ts:formatLythoshiToLythDecimal — for reconcilePending
 *  in shared/activity.ts to fire. */
export function lythoshiHexToLythDecimal(lythoshiHex: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(lythoshiHex)) return "0";
  let lythoshi: bigint;
  try {
    lythoshi = BigInt(lythoshiHex);
  } catch {
    return "0";
  }
  return formatLythoshiToLythDecimal(lythoshi);
}

/** @deprecated Compatibility export for the service-worker IPC field
 *  `valueWeiHex`, which now carries native lythoshi for LYTH sends. */
export function weiHexToLythDecimal(valueWeiHex: string): string {
  return lythoshiHexToLythDecimal(valueWeiHex);
}
