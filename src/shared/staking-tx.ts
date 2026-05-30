// staking-tx. Calldata encoders for the §23 delegation precompile
// (`0x100A`), plus LYTH/bps conversion helpers used by the stake forms.
//
// `bgWalletSendTx` takes the precompile address as `to`, the LYTH
// principal as `valueWeiHex`, and the calldata as `data`. The calldata
// encoding is delegated to the SDK 0.3.10 encoders
// (`encode{Delegate,Undelegate,Redelegate,Claim}Calldata`), which match
// the chain-canonical ABI signatures in mono-core
// `crates/precompiles/system/delegation/src/abi.rs`
// (delegate(uint32,uint16) 0x662337de, undelegate(uint32) 0x914f3ca8,
// redelegate(uint32,uint32,uint16) 0xa06ac18f, claim()). The wallet
// previously hand-rolled stale `uint256` signatures that the live
// precompile rejected as unknown-selector — R20 fixed that by routing
// through the SDK. staking-tx.test.ts pins the encoders to the SDK
// output + the chain selectors as golden vectors.
//
// The delegation precompile (`0x100A`) is live + enabled on testnet
// (`lyth_listActivePrecompiles`). `delegate` commits the LYTH principal
// via `msg.value` (the tx `value`); `weightBps` is the voting-power
// share (cap-bound, sum ≤10000 across ≤10 clusters).

import {
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
  encodeCompleteRedemptionCalldata,
} from "@monolythium/core-sdk";

/** Delegation precompile address — Whitepaper §5.4 / §7.6
 *  (mono-core `DELEGATION_ADDRESS`). */
export const DELEGATION_PRECOMPILE =
  "0x000000000000000000000000000000000000100A" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Method encoders (delegated to the chain-canonical SDK 0.3.10 encoders)
// ─────────────────────────────────────────────────────────────────────────────

/** `delegate(uint32 cluster, uint16 weightBps)` calldata via the SDK
 *  encoder (chain-canonical selector `0x662337de`; mono-core
 *  `crates/precompiles/system/delegation/src/abi.rs`). Returns a
 *  0x-prefixed hex string ready for `bgWalletSendTx({ data })`. The LYTH
 *  principal is sent separately as `msg.value` (tx `value`), NOT in the
 *  calldata — see `Stake.tsx`. */
export function encodeDelegate(clusterId: number, weightBps: number): string {
  return encodeDelegateCalldata(clusterId, weightBps);
}

/** `undelegate(uint32 cluster)` calldata via the SDK encoder
 *  (chain-canonical selector `0x914f3ca8`). Removes the wallet's ENTIRE
 *  row for `cluster` — there is no partial unstake on-chain; the
 *  principal is queued for redemption (`completeRedemption`). No
 *  weight/amount arg. */
export function encodeUndelegate(clusterId: number): string {
  return encodeUndelegateCalldata(clusterId);
}

/** `redelegate(uint32 fromCluster, uint32 toCluster, uint16 weightBps)`
 *  calldata via the SDK encoder (chain-canonical selector `0xa06ac18f`).
 *  Atomic weight move; no new principal is committed (no `msg.value`). */
export function encodeRedelegate(
  srcCluster: number,
  dstCluster: number,
  weightBps: number,
): string {
  return encodeRedelegateCalldata(srcCluster, dstCluster, weightBps);
}

/** `claim()` calldata via the SDK encoder (chain-canonical, selector-only)
 *  — settles + withdraws the caller's pending delegation rewards. */
export function encodeClaimRewards(): string {
  return encodeClaimCalldata();
}

/** `completeRedemption(uint64 index)` calldata via the SDK encoder
 *  (chain-canonical selector `0x26169d0a`). Settles the matured
 *  redemption ticket at `index`, returning the queued principal to the
 *  caller and pruning the ticket. With liquid bonding the ticket matures
 *  at the undelegate height, so this becomes claimable in the same/next
 *  anchor as the `undelegate` that created it. No `msg.value`. */
export function encodeCompleteRedemption(ticketIndex: number): string {
  return encodeCompleteRedemptionCalldata(ticketIndex);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversions used by the popup forms
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a LYTH amount + total balance to a delegation basis-point
 *  weight, rounded down to the nearest bp. Returns 0 when the total
 *  balance is zero (the form caller will reject the submission with a
 *  more user-friendly error before reaching the chain).
 *
 *  Example: stake 25 LYTH out of a 100 LYTH balance → 2500 bps (25%).
 *  Example: stake 33.34 LYTH out of 100 LYTH → 3334 bps (33.34%). */
export function lythAmountToBps(
  amountWei: bigint,
  totalBalanceWei: bigint,
): number {
  if (totalBalanceWei <= 0n) return 0;
  if (amountWei < 0n) return 0;
  if (amountWei >= totalBalanceWei) return 10_000;
  // 10000 bps = 100%; integer division floors per spec.
  const bps = (amountWei * 10_000n) / totalBalanceWei;
  return Number(bps);
}

/** Inverse of `lythAmountToBps`: convert a bp weight + balance back to
 *  a lythoshi amount. Used by the stake-form's preview card to render the
 *  exact LYTH amount the chain will record. Floors any truncation. */
export function bpsToLythAmountWei(
  bps: number,
  totalBalanceWei: bigint,
): bigint {
  if (totalBalanceWei <= 0n) return 0n;
  if (bps <= 0) return 0n;
  if (bps >= 10_000) return totalBalanceWei;
  return (totalBalanceWei * BigInt(bps)) / 10_000n;
}
