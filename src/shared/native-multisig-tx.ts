// Native `0x40` multisig SIGNED-TRANSACTION assembly — Phase 9 commit 3/5.
//
// The fund-critical core: a SEPARATE builder that turns a tx + roster + threshold
// + collected member signatures + an outer signature into a chain-acceptable
// `SignedTransaction` wire, WITHOUT ever touching the single-key plaintext path
// (`buildPlaintextSubmission`/`submitTrackedTx`, which the commit-1 guard refuses
// for `0x40`). Pure — the signatures are INPUTS; no keystore, no RPC, no I/O — so
// it is fully offline-testable against the chain's own acceptance rules.
//
// The chain's rules (mono-core `execution/tx`, re-verified at v0.4.0-testnet):
//   base = base_sighash(fields) = keccak(encode(fields, TAG_SIGHASH)) with the
//          0x40 witness extension stripped (`envelope.rs:284-297`).
//   (a) each of ≥threshold DISTINCT roster members signs `base` (`verify_quorum`,
//       `multisig.rs:261`);
//   (b) the OUTER envelope signature is ALSO over `base` (`signed.rs:198,214-215`);
//   (c) the outer signer MUST be a roster member (`contains_member` → else
//       `MultisigOuterSignerNotMember`, `signed.rs:188-193`);
//   (d) the witness-derived address MUST equal the tx sender (`derived==sender()`
//       → else `MultisigAddressMismatch`, `signed.rs:184-187`); sender()=the monom.
//   tx_hash = keccak(encode(fields, TAG_TX_HASH) || outerSig || outerPubkey)
//            (`signed.rs:57`; matches the SDK `signEvmTx` formula byte-for-byte).
//
// FAIL-CLOSED: this refuses to build a tx the chain would reject — fewer than
// `threshold` verifying member sigs, a non-member outer signer, a signature over
// the wrong digest (e.g. the FULL sighash), or a roster that doesn't derive to the
// expected monom. A wrong monom derivation is already impossible (commit-1 KAT);
// every remaining failure here is chain-REJECT (fail-safe: fee wasted, funds stay).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  bincodeSignedTransaction,
  encodeTransactionForHash,
  bytesToHex,
  concatBytes,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";

import {
  deriveNativeMultisigAddress,
  nativeMultisigBaseSighash,
  buildNativeMultisigWitness,
  attachNativeMultisigWitness,
  nativeMultisigMemberIndex,
  type MultisigWitness,
  type MultisigMemberSignature,
} from "./native-multisig.js";

const TAG_TX_HASH = 2;

/** One collected member signature over the base sighash, tagged by the signer's
 *  roster pubkey (used to locate its sorted-roster index). */
export interface CollectedMemberSignature {
  /** The signing member's 1952-byte ML-DSA-65 public key. */
  pubkey: Uint8Array;
  /** The member's 3309-byte ML-DSA-65 signature over the BASE sighash. */
  signature: Uint8Array;
}

export interface AssembleNativeMultisigArgs {
  /** Tx fields WITH the monom account's nonce and WITHOUT a `0x40` extension. */
  fields: NativeEvmTxFields;
  threshold: number;
  /** The full roster (raw 1952-byte member pubkeys; any order — sorted inside). */
  members: readonly Uint8Array[];
  /** Collected member signatures over the base sighash (self + imported). */
  memberSignatures: readonly CollectedMemberSignature[];
  /** The outer envelope signer's pubkey — MUST be a roster member. */
  outerPubkey: Uint8Array;
  /** The outer signer's signature over the base sighash. */
  outerSignature: Uint8Array;
  /** Optional fund-safety belt: the monom the wallet believes it is spending
   *  from. When provided, the derived address must equal it or we refuse. */
  expectedMonom?: string;
}

export interface AssembledNativeMultisigTx {
  /** `0x`-prefixed bincode `SignedTransaction` wire bytes for `mesh_submitTx`. */
  wireHex: string;
  /** `0x`-prefixed canonical native tx hash (for the fan-out echo check). */
  txHashHex: string;
  /** The derived monom sender address. */
  monomAddress: string;
  /** `0x`-prefixed base sighash every signature was verified against. */
  baseSighashHex: string;
  witness: MultisigWitness;
}

function verifyOverBase(sig: Uint8Array, base: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    // Wallet-wide arg order (mirrors shared/multisig.ts): (signature, message, publicKey).
    return ml_dsa65.verify(sig, base, pubkey);
  } catch {
    return false;
  }
}

/**
 * Assemble a chain-acceptable native multisig `SignedTransaction` from collected
 * signatures. PURE + FAIL-CLOSED (see the module header). Throws on any condition
 * the chain would reject, so the caller never broadcasts a doomed tx.
 */
export function assembleNativeMultisigSignedTx(
  args: AssembleNativeMultisigArgs,
): AssembledNativeMultisigTx {
  const { fields, threshold, members, memberSignatures, outerPubkey, outerSignature } = args;

  if (fields.extensions !== undefined && fields.extensions.length > 0) {
    throw new Error("native multisig: fields must not already carry an extension");
  }

  // (base) the digest every signature must be over.
  const base = nativeMultisigBaseSighash(fields);

  // (a) verify each member signature over BASE; count DISTINCT verifying members
  // (mirrors verify_quorum's per-member dedup). A sig that doesn't verify, or
  // whose signer isn't in the roster, is a hard refusal — never silently dropped.
  const witnessSigs: MultisigMemberSignature[] = [];
  const countedIdx = new Set<number>();
  for (const ms of memberSignatures) {
    const idx = nativeMultisigMemberIndex(members, ms.pubkey);
    if (idx < 0) {
      throw new Error("native multisig: a member signature is from a key not in the roster");
    }
    if (!verifyOverBase(ms.signature, base, ms.pubkey)) {
      throw new Error(
        "native multisig: a member signature does not verify over the base sighash (wrong digest or key)",
      );
    }
    if (countedIdx.has(idx)) continue; // each member counts at most once
    countedIdx.add(idx);
    witnessSigs.push({ memberIndex: idx, signature: ms.signature });
  }
  if (countedIdx.size < threshold) {
    throw new Error(
      `native multisig: quorum unmet — ${countedIdx.size} verifying member signatures, need ${threshold}`,
    );
  }

  // (c) the outer signer must be a roster member, and (b) sign the SAME base.
  if (nativeMultisigMemberIndex(members, outerPubkey) < 0) {
    throw new Error("native multisig: the outer signer is not a roster member");
  }
  if (!verifyOverBase(outerSignature, base, outerPubkey)) {
    throw new Error(
      "native multisig: the outer signature does not verify over the base sighash (wrong digest or key)",
    );
  }

  // (d) the roster + threshold must derive to the expected spending address.
  const monomAddress = deriveNativeMultisigAddress(threshold, members);
  if (args.expectedMonom !== undefined && monomAddress !== args.expectedMonom) {
    throw new Error(
      `native multisig: derived address ${monomAddress} does not equal the expected ${args.expectedMonom}`,
    );
  }

  const witness = buildNativeMultisigWitness(threshold, members, witnessSigs);
  const fieldsWithWitness = attachNativeMultisigWitness(fields, witness);

  // Belt: attaching the 0x40 witness must not change the base sighash (the chain
  // strips it before verifying) — otherwise the collected sigs wouldn't verify.
  const baseAfter = nativeMultisigBaseSighash(fieldsWithWitness);
  if (bytesToHex(baseAfter) !== bytesToHex(base)) {
    throw new Error("native multisig: base sighash changed after attaching the witness");
  }

  const wireBytes = bincodeSignedTransaction(fieldsWithWitness, outerSignature, outerPubkey);
  const txHash = nativeMultisigTxHash(fieldsWithWitness, outerSignature, outerPubkey);

  return {
    wireHex: "0x" + bytesToHex(wireBytes).replace(/^0x/i, ""),
    txHashHex: "0x" + bytesToHex(txHash).replace(/^0x/i, ""),
    monomAddress,
    baseSighashHex: "0x" + bytesToHex(base).replace(/^0x/i, ""),
    witness,
  };
}

/**
 * The canonical native tx hash for a signed (witness-bearing) tx —
 * `keccak(encode(fields, TAG_TX_HASH) || outerSig || outerPubkey)` — reproducing
 * the chain's `SignedTransaction::tx_hash` and the SDK `signEvmTx` formula exactly
 * (raw sig + raw pubkey bytes; the fields include the 0x40 extension). Used for the
 * fan-out's expected-hash echo check.
 */
export function nativeMultisigTxHash(
  fieldsWithWitness: NativeEvmTxFields,
  outerSignature: Uint8Array,
  outerPubkey: Uint8Array,
): Uint8Array {
  return keccak_256(
    concatBytes(encodeTransactionForHash(fieldsWithWitness, TAG_TX_HASH), outerSignature, outerPubkey),
  );
}
