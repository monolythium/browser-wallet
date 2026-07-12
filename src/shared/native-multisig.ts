// Native `0x40` multisig primitives — Phase 9 commit 1/5.
//
// PURE wrappers around the SDK's native multisig surface: address derivation,
// the base (witness-stripped) sighash, and witness assembly. There is NO
// signing, NO submission, and NO key-material handling here — those belong to
// the later, gated commits (the native submit path is commit 3, behind a flag +
// a live-testnet e2e gate). We WRAP the SDK — we never hand-roll the crypto.
//
// Import split (SDK 0.6.7, verified): the multisig HELPERS + constants live at
// the package ROOT (`@monolythium/core-sdk`); `NativeEvmTxFields` (the base-
// sighash input type) is `/crypto`-only.
//
// Chain rule (mono-core `execution/tx`, read-only, re-verified):
//   - Every key signs the SAME BASE sighash — each of ≥threshold roster members
//     (`verify_quorum`, `multisig.rs:261`) AND the outer envelope signature
//     (`signed.rs:198`), which must itself be a roster member (`contains_member`).
//   - Address = BLAKE3("MONO_MULTISIG_BLAKE3_20_V1" || threshold_be16 ||
//     (len_be8 || pubkey_1952B)*sorted)[..20], rendered `monom…` bech32m; the SDK
//     `deriveMultisigAddress` mirrors the chain `address_from_multisig_members`
//     byte-for-byte. A WRONG derivation = unrecoverable fund loss → pinned by a
//     genesis-derived known-answer test in native-multisig.test.ts.

import {
  deriveMultisigAddress,
  deriveMultisigAddressBytes,
  multisigBaseSighash,
  assembleMultisigWitness,
  assembleMultisigSigned,
  encodeMultisigWitnessBody,
  sortMultisigMembers,
  validateMultisigRoster,
  multisigMemberIndex,
  TX_EXTENSION_KIND_MULTISIG,
  MIN_MULTISIG_MEMBERS,
  MAX_MULTISIG_MEMBERS,
  MULTISIG_ADDRESS_DERIVATION_DOMAIN,
  type MultisigWitness,
  type MultisigMember,
  type MultisigMemberSignature,
} from "@monolythium/core-sdk";
import type { NativeEvmTxFields } from "@monolythium/core-sdk/crypto";

/** A member pubkey as raw bytes (the canonical 1952-byte ML-DSA-65 public key).
 *  Mirrors the SDK `MemberPubkeyInput` without depending on its export. */
export type NativeMemberPubkey = Uint8Array | readonly number[];

export {
  TX_EXTENSION_KIND_MULTISIG,
  MIN_MULTISIG_MEMBERS,
  MAX_MULTISIG_MEMBERS,
  MULTISIG_ADDRESS_DERIVATION_DOMAIN,
};
export type { MultisigWitness, MultisigMember, MultisigMemberSignature };

/**
 * FUND-LOSS-CRITICAL. Derive the `monom…` bech32m multisig address for a roster
 * + threshold. Wraps the SDK `deriveMultisigAddress`, which reproduces the chain
 * derivation byte-for-byte. Members are the raw 1952-byte ML-DSA-65 public keys;
 * ordering is normalized (sorted ascending) inside, so the address is
 * order-insensitive and threshold-bound. A wrong result sends funds to an
 * unspendable address — verified against a genesis-pinned mono-core vector (KAT).
 */
export function deriveNativeMultisigAddress(
  threshold: number,
  memberPubkeys: readonly NativeMemberPubkey[],
): string {
  return deriveMultisigAddress(threshold, memberPubkeys);
}

/** The raw 20 address bytes behind {@link deriveNativeMultisigAddress}. */
export function deriveNativeMultisigAddressBytes(
  threshold: number,
  memberPubkeys: readonly NativeMemberPubkey[],
): Uint8Array {
  return deriveMultisigAddressBytes(threshold, memberPubkeys);
}

/**
 * The BASE (witness-stripped) sighash that every roster member AND the outer
 * envelope signer sign. Wraps the SDK `multisigBaseSighash`, which strips any
 * `0x40` multisig extension then keccak-hashes with the sighash tag. It equals
 * the full single-key sighash only when no `0x40` extension is present.
 */
export function nativeMultisigBaseSighash(fields: NativeEvmTxFields): Uint8Array {
  return multisigBaseSighash(fields);
}

/**
 * Assemble a validated {@link MultisigWitness} from a roster + threshold +
 * already-collected member signatures (each over the base sighash). Wraps
 * `assembleMultisigWitness` — sorts the roster ascending and runs the chain's
 * roster-shape validation (1..=64 members, duplicate-free, 1 ≤ threshold ≤ N).
 * Callers key each `memberIndex` to the SORTED roster ({@link nativeMultisigMemberIndex}).
 * This does NOT sign anything — it packages signatures the caller already holds.
 */
export function buildNativeMultisigWitness(
  threshold: number,
  members: readonly NativeMemberPubkey[],
  signatures?: readonly MultisigMemberSignature[],
): MultisigWitness {
  return assembleMultisigWitness(threshold, members, signatures);
}

/**
 * Attach the `0x40` witness extension to a tx's fields (wraps
 * `assembleMultisigSigned`). The outer envelope signature and the final wire
 * encode are NOT done here — that is the gated submit path (commit 3).
 */
export function attachNativeMultisigWitness(
  fields: NativeEvmTxFields,
  witness: MultisigWitness,
): NativeEvmTxFields {
  return assembleMultisigSigned(fields, witness);
}

/** Canonical witness extension body bytes (`0x01 || "MONO_MULTISIG_WITNESS_V1"
 *  || bincode(witness)`). Wraps `encodeMultisigWitnessBody`. */
export function encodeNativeMultisigWitnessBody(witness: MultisigWitness): Uint8Array {
  return encodeMultisigWitnessBody(witness);
}

/** Index of `pubkey` in the canonically-sorted roster, or -1. Wraps
 *  `multisigMemberIndex`; use to key a {@link MultisigMemberSignature.memberIndex}. */
export function nativeMultisigMemberIndex(
  members: readonly NativeMemberPubkey[],
  pubkey: NativeMemberPubkey,
): number {
  return multisigMemberIndex(members, pubkey);
}

/** Sort a roster into canonical (ascending raw-byte) order. Wraps `sortMultisigMembers`. */
export function sortNativeMultisigMembers(
  members: readonly NativeMemberPubkey[],
): Uint8Array[] {
  return sortMultisigMembers(members);
}

/** Validate a witness's static roster shape (throws `MultisigError` on failure).
 *  Wraps `validateMultisigRoster`. */
export function validateNativeMultisigRoster(witness: MultisigWitness): void {
  validateMultisigRoster(witness);
}

/**
 * Chokepoint guard predicate: does this tx carry a native multisig (`0x40`)
 * extension? The single-key plaintext path signs the FULL sighash, but the chain
 * verifies a `0x40` tx's signatures over the BASE (witness-stripped) sighash — so
 * a `0x40`-bearing tx signed there would be chain-REJECTED. The submit chokepoint
 * calls this to refuse such a tx loudly (the genuine native path builds the
 * base-sighash witness envelope separately). Specific to kind `0x40`; other
 * extensions (e.g. MRV v1, kind `0x30`) pass through untouched.
 */
export function carriesMultisigExtension(
  extensions: readonly { kind: number }[] | undefined,
): boolean {
  return extensions?.some((e) => e.kind === TX_EXTENSION_KIND_MULTISIG) ?? false;
}
