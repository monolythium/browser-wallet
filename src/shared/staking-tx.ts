// Phase 7 — staking-tx. Calldata encoders for the §23 delegation
// precompile (`0x000000000000000000000000000000000000100A`).
//
// The wallet's existing `bgWalletSendTx` IPC takes the precompile
// address as `to`, value as `valueWeiHex`, and arbitrary calldata as
// `data`. This module owns the ABI encoding of each precompile method
// so both the popup-side stake/unstake forms and the autovote
// allocation flow speak one shape.
//
// Calldata format mirrors standard Solidity ABI encoding:
//   - 4-byte function selector (first 4 bytes of keccak256 over the
//     canonical method signature)
//   - 32-byte words for each argument (big-endian, left-padded for
//     uint256)
//
// Selectors are pinned as hex constants below; they were computed
// once via @noble/hashes keccak_256 over the canonical signatures
// and verified against the precompile spec. Tests in
// staking-tx.test.ts assert the selector value never drifts.
//
// Chain status: the delegation precompile is code-complete in
// mono-core but verified inactive on Sprintnet at Phase 7 phase-
// start (Nayiem's tracking). Submitting a delegate tx today routes
// the encoded calldata through the encrypted-mempool path and the
// chain rejects it at the precompile-gate; the wallet surfaces
// the typed error verbatim.

import {
  encodeDelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
} from "@monolythium/core-sdk";

/** Delegation precompile address — Whitepaper §5.4 / §7.6. */
export const DELEGATION_PRECOMPILE =
  "0x000000000000000000000000000000000000100A" as const;

/** Function selectors. Computed via:
 *    selector = keccak256(canonical_signature).slice(0, 4)
 *  Test fixture in staking-tx.test.ts pins each value. */
export const DELEGATION_SELECTORS = {
  /** `delegate(uint256 clusterId, uint256 weightBps)`. */
  delegate: "0xd9a34952",
  /** `undelegate(uint256 clusterId, uint256 weightBps)`. */
  undelegate: "0x634b91e3",
  /** `redelegate(uint256 srcCluster, uint256 dstCluster, uint256 weightBps)`. */
  redelegate: "0x0e184c84",
  /** `claimRewards()` — claims accrued rewards across every active delegation. */
  claimRewards: "0x372500ab",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// ABI encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Encode a non-negative integer as a 32-byte ABI word (big-endian,
 *  left-padded). Accepts plain number, bigint, or 0x-hex string. */
export function encodeUint256(value: number | bigint | string): string {
  let n: bigint;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`encodeUint256: not a non-negative finite number (${value})`);
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(`encodeUint256: not an integer (${value})`);
    }
    n = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.startsWith("0x") || value.startsWith("0X") ? value : `0x${value}`;
    n = BigInt(trimmed);
  } else {
    throw new TypeError(`encodeUint256: unsupported input type (${typeof value})`);
  }
  if (n < 0n) {
    throw new RangeError("encodeUint256: negative bigint");
  }
  if (n >= 1n << 256n) {
    throw new RangeError("encodeUint256: value overflows uint256");
  }
  return n.toString(16).padStart(64, "0");
}

/** Strip the `0x` prefix from a hex selector for concatenation. */
function selectorHex(selector: string): string {
  if (!selector.startsWith("0x") && !selector.startsWith("0X")) {
    throw new TypeError("selector must be 0x-prefixed");
  }
  if (selector.length !== 10) {
    throw new TypeError(`selector must be 4 bytes (10 chars including 0x), got ${selector.length}`);
  }
  return selector.slice(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Method encoders
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

/** `undelegate(uint256 clusterId, uint256 weightBps)` calldata. */
export function encodeUndelegate(clusterId: number, weightBps: number): string {
  const sig = selectorHex(DELEGATION_SELECTORS.undelegate);
  return "0x" + sig + encodeUint256(clusterId) + encodeUint256(weightBps);
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
