// staking-tx. Calldata encoders for the §23 delegation precompile
// (`0x100A`), plus the percent ⇄ bps + effective-weight helpers used by
// the stake forms.
//
// Delegation is NON-CUSTODIAL and balance-weighted: the wallet never
// escrows tokens. `delegate` records a `weightBps` fraction of the
// caller's LIVE balance; the contribution to a cluster is the effective
// weight `floor(balance × weightBps / 10000)`, re-evaluated each
// settlement. Tokens stay fully liquid and spendable. The delegate tx is
// therefore sent with `value = 0` — the chain reverts (UnexpectedValue,
// tag 0x020e) if any native value is attached.
//
// `bgWalletSendTx` takes the precompile address as `to`, `valueWeiHex`
// (always "0x0" for delegation), and the calldata as `data`. The calldata
// encoding is delegated to the SDK encoders
// (`encode{Delegate,Undelegate,Redelegate,Claim}Calldata`), which match
// the chain-canonical ABI signatures in mono-core
// `crates/precompiles/system/delegation/src/abi.rs`
// (delegate(uint32,uint16) 0x662337de, undelegate(uint32) 0x914f3ca8,
// redelegate(uint32,uint32,uint16) 0xa06ac18f, claim()). The wallet
// previously hand-rolled stale `uint256` signatures that the live
// precompile rejected as unknown-selector — this was fixed by routing
// through the SDK. staking-tx.test.ts pins the encoders to the SDK
// output + the chain selectors as golden vectors.
//
// The delegation precompile (`0x100A`) is live + enabled on testnet
// (`lyth_listActivePrecompiles`). `weightBps` is the voting-power /
// contribution share (cap-bound, sum ≤10000 across ≤10 clusters).

import {
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
  LYTHOSHI_PER_LYTH,
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
 *  0x-prefixed hex string ready for `bgWalletSendTx({ data })`. NON-CUSTODIAL:
 *  the tx MUST be sent with `value = 0` (the chain reverts with
 *  UnexpectedValue / tag 0x020e otherwise). `weightBps` is the fraction of
 *  the caller's live balance to contribute; no principal is escrowed. */
export function encodeDelegate(clusterId: number, weightBps: number): string {
  return encodeDelegateCalldata(clusterId, weightBps);
}

/** `undelegate(uint32 cluster)` calldata via the SDK encoder
 *  (chain-canonical selector `0x914f3ca8`). INSTANTLY removes the wallet's
 *  entire delegation row for `cluster`. There is no redemption queue or
 *  cooldown — nothing was escrowed, so there is nothing to redeem. No
 *  weight/amount arg. */
export function encodeUndelegate(clusterId: number): string {
  return encodeUndelegateCalldata(clusterId);
}

/** `redelegate(uint32 fromCluster, uint32 toCluster, uint16 weightBps)`
 *  calldata via the SDK encoder (chain-canonical selector `0xa06ac18f`).
 *  Atomic weight move; non-custodial (sent with `value = 0`). */
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

// ─────────────────────────────────────────────────────────────────────────────
// Conversions used by the popup forms
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp + normalize a percent value (0–100, one-or-more decimals) into a
 *  delegation basis-point weight (0–10000). Returns 0 for non-finite /
 *  negative input. Example: 25 → 2500 bps; 33.34 → 3334 bps; 100 → 10000. */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  const bps = Math.round(percent * 100);
  return bps > 10_000 ? 10_000 : bps;
}

/** Inverse of `percentToBps`: bps → percent number (0–100). */
export function bpsToPercent(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return (bps > 10_000 ? 10_000 : bps) / 100;
}

/** Effective weight (a.k.a. contribution) the chain records for a delegation:
 *  `floor(balance × weightBps / 10000)` of the wallet's LIVE balance. The
 *  tokens are NOT escrowed — they stay liquid and spendable, and the
 *  effective weight tracks the balance at the next settlement.
 *
 *  This is also the inverse of a percent/bps selection back to a lythoshi
 *  amount, used by the autovote preview to render the LYTH the chain will
 *  weight. */
export function effectiveWeightWei(
  bps: number,
  balanceWei: bigint,
): bigint {
  if (balanceWei <= 0n) return 0n;
  if (bps <= 0) return 0n;
  if (bps >= 10_000) return balanceWei;
  return (balanceWei * BigInt(bps)) / 10_000n;
}

/** Chain-EXACT effective weight: the wallet's effective weight floored to WHOLE
 *  LYTH, matching mono-core `effective_weight_whole_lyth`
 *  (`floor(balance · bps / (10000 · 1e18))`). Returned re-expressed in lythoshi
 *  as a whole multiple of 1 LYTH, so the standard lyth formatters render the
 *  whole number — e.g. 530.082 LYTH → "530 LYTH", and a sub-1-LYTH delegation →
 *  "0 LYTH". This is what the chain actually credits for rewards/voting, so use
 *  it for effective-weight DISPLAYS — NOT for the amount input (which keeps the
 *  user's precise value) and NOT for the tx (still bps). Equivalent to flooring
 *  `effectiveWeightWei` to whole LYTH: floor(floor(x/10000)/1e18) ==
 *  floor(x/(10000·1e18)). */
export function effectiveWeightWholeLythoshi(
  bps: number,
  balanceWei: bigint,
): bigint {
  const lythoshi = effectiveWeightWei(bps, balanceWei);
  return (lythoshi / LYTHOSHI_PER_LYTH) * LYTHOSHI_PER_LYTH;
}

/** True when a delegation with `bps` (>= 1, otherwise the chain reverts
 *  ZeroWeight) floors to **0 effective weight** at this balance: the chain
 *  ACCEPTS it (no revert) but it's inert — earns nothing and casts no vote
 *  until the balance grows. The real, balance-dependent "minimum" — see
 *  [`minNonInertBps`]. Shared by the % field and the amount field. */
export function isInertDelegation(bps: number, balanceWei: bigint): boolean {
  return (
    bps >= 1 && balanceWei > 0n && effectiveWeightWholeLythoshi(bps, balanceWei) === 0n
  );
}

/** Smallest `bps` that yields >= 1 whole-LYTH effective weight at this balance
 *  (`ceil(10000·1e18 / balance)`), i.e. the first non-inert weight. Returns null
 *  when the balance is unknown/zero OR is below 1 LYTH (no bps up to 10000 can
 *  reach 1 whole-LYTH effective — even 100% floors to 0). Used for the
 *  "minimum ≈ X%" warning copy. */
export function minNonInertBps(balanceWei: bigint): number | null {
  if (balanceWei <= 0n) return null;
  const num = 10_000n * LYTHOSHI_PER_LYTH;
  const ceilBps = (num + balanceWei - 1n) / balanceWei; // ceil(num / balance)
  return ceilBps > 10_000n ? null : Number(ceilBps);
}
