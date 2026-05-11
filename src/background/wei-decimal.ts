// Hex-wei → decimal-LYTH string conversion used by the SW's pending-row
// pre-prepend in service-worker.ts:persistPendingRowBackground.
//
// Lives in its own file so the byte-equality golden test
// (src/background/wei-decimal.test.ts) can import the helper without
// dragging in the SW's module-scope chrome.* references. The popup
// counterpart is weiToLythString in src/popup/pages/Send.tsx — both
// must produce byte-identical output across every wei value the
// wallet handles, or the shared/activity.ts reconcilePending heuristic
// match fails silently and pending rows stick to their PENDING_TTL_MS
// backstop.

/** Hex wei → decimal LYTH string (trimming trailing zeros, no decimal
 *  point when fractional part is zero). The string output is the
 *  `amountDecimal` field on PendingTxRow; it must match the indexer's
 *  `AddressActivityEntry.amount` byte-for-byte for reconcilePending
 *  in shared/activity.ts to fire. */
export function weiHexToLythDecimal(weiHex: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiHex);
  } catch {
    return "0";
  }
  if (wei < 0n) return "0";
  const intPart = wei / 10n ** 18n;
  const fracPart = wei % 10n ** 18n;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length === 0
    ? intPart.toString()
    : `${intPart.toString()}.${fracStr}`;
}
