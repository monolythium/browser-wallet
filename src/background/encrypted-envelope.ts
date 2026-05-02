// Monolythium Wallet — encrypted-mempool envelope wrapper.
//
// Sprintnet's mempool admission gate (`encrypted_mempool_required`,
// genesis-default `true` per Law §4.5 / Q2) refuses plaintext signed
// txs at admission. Wallets must wrap a signed inner tx in an
// `EncryptedEnvelope` and submit via the `lyth_submitEncrypted` RPC.
//
// Wire shape (mirrors `protocore_mempool::envelope::EncryptedEnvelope`
// in `crates/mempool/src/envelope.rs`; field order is part of the
// wire contract):
//
//   bincode {
//     nonce_aad:        NonceAad,
//     ciphertext:       Vec<u8>,           // 8-byte LE length + bytes
//     decryption_hint:  DecryptHint,
//     sender_pubkey:    PublicKey,         // enum, MlDsa65 variant
//     outer_signature:  Signature,         // enum, MlDsa65 variant
//     sender:           Address,           // length-prefixed 20 bytes
//   }
//
// Inner ciphertext layout (lives in the `ciphertext` field above —
// see `crates/mempool/src/decryptor.rs::EncryptedTxEnvelope::encode_wire`):
//
//   kem_ct[1088]   ML-KEM-768 ciphertext (FIPS-203 §8)
//   nonce[12]      random ChaCha20-Poly1305 nonce (RFC 8439)
//   aead_ct[..]    ChaCha20-Poly1305 ciphertext with appended 16-byte tag
//
// AAD for the AEAD step is `domain_tag || bincode(nonce_aad)` where
// `domain_tag = b"protocore/v2/mempool/dkg-mlkem768/1"` — the value the
// chain's `MlKemSingleKeyDecryptor::aad_for` mixes in.
//
// Outer signature is ML-DSA-65 over `keccak256(preimage)` where
//   preimage = bincode(nonce_aad)
//           || ciphertext_bytes
//           || bincode(decryption_hint)
//           || sender_pubkey.canonical_address_bytes()  (raw 1952-byte mldsa pk)
// matching `EncryptedEnvelope::signed_preimage` in the chain.
//
// This module is intentionally state-less — no keystore reference, no
// chrome.storage. Inputs go in, bytes come out. Outer-signing is done
// by the caller via a callback so the unlocked v3 backend stays in
// `keystore-mldsa.ts` and never crosses module boundaries with secret
// material.

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  BincodeWriter,
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
} from "@monolythium/core-sdk/crypto";

// ---- Wire constants pinned by the chain ----

/** Domain-separation tag for the in-transit ML-KEM-768 + AEAD AAD.
 *
 * Verbatim from `crates/mempool/src/decryptor.rs`:
 *   `const DKG_AEAD_DOMAIN_TAG: &[u8] = b"protocore/v2/mempool/dkg-mlkem768/1";`
 * Bumping the trailing digit is a wire-format break.
 */
const DKG_AEAD_DOMAIN_TAG = new TextEncoder().encode(
  "protocore/v2/mempool/dkg-mlkem768/1",
);

/** ML-KEM-768 ciphertext byte length (FIPS-203 Table 3). */
export const ML_KEM_768_CIPHERTEXT_LEN = 1088;
/** ML-KEM-768 encapsulation key byte length (FIPS-203 Table 3). */
export const ML_KEM_768_ENCAPSULATION_KEY_LEN = 1184;
/** ML-KEM-768 shared-secret byte length (FIPS-203 Table 3). */
export const ML_KEM_768_SHARED_SECRET_LEN = 32;

/** ChaCha20-Poly1305 nonce length (RFC 8439). */
export const DKG_NONCE_LEN = 12;
/** ChaCha20-Poly1305 Poly1305 tag length (RFC 8439). */
export const DKG_AEAD_TAG_LEN = 16;

/**
 * `Signature::MlDsa65` / `PublicKey::MlDsa65` enum variant index in the
 * chain's actual build. Same value the SDK's tx-encode.ts uses (see
 * `ENUM_VARIANT_INDEX_ML_DSA_65 = 5`) — empirically confirmed against
 * Sprintnet, where `wallet-side-classical` is enabled to support the
 * Mesh boundary, pushing classical variants ahead of MlDsa65.
 */
const ENUM_VARIANT_INDEX_ML_DSA_65 = 5;

/** ML-DSA-65 standard algorithm number per `protocore_types::StandardAlgo`. */
const STANDARD_ALGO_NUMBER_ML_DSA_65 = 1001;

// ---- TypeScript shapes mirroring the Rust structs ----

/**
 * Mempool priority class — bincode-encoded as a 4-byte LE u32 of the
 * variant index. Order matches `crates/mempool/src/classes.rs::Class`.
 *
 * Plain object (not `const enum`) so the runtime values survive Node's
 * TS-strip mode used by the smoke script.
 */
export const MempoolClass = {
  Transfer: 0,
  ContractCall: 1,
  PrivacyOp: 2,
  CLOBOp: 3,
  AgentOp: 4,
  GovernanceOp: 5,
  RWAOp: 6,
} as const;
export type MempoolClass = (typeof MempoolClass)[keyof typeof MempoolClass];

/**
 * Authenticated plaintext header (R3-H08 / Law §3.6 binding).
 * The `gas_limit`, `max_fee_per_gas`, and `max_priority_fee_per_gas`
 * fields MUST equal the inner SignedTransaction's matching fields
 * exactly — the chain enforces this on reveal and mismatches are
 * slashable evidence.
 */
export interface NonceAad {
  /** 20-byte sender address. */
  sender: Uint8Array;
  /** Sender's nonce. */
  nonce: bigint;
  /** Chain id. */
  chainId: bigint;
  /** Priority class hint. */
  class: MempoolClass;
  /** Must equal inner tx `max_fee_per_gas` (u128). */
  maxFeePerGas: bigint;
  /** Must equal inner tx `max_priority_fee_per_gas` (u128). */
  maxPriorityFeePerGas: bigint;
  /** Must equal inner tx `gas_limit` (u64). */
  gasLimit: bigint;
}

/** Decrypt epoch + scheme selector. */
export interface DecryptHint {
  /** Decrypt epoch id — read from `lyth_getEncryptionKey().epoch`. */
  epoch: bigint;
  /** Opaque scheme selector. Phase-5 callers send 0. */
  scheme: number;
}

/** Built encrypted envelope, ready for `lyth_submitEncrypted`. */
export interface EncryptedEnvelope {
  nonceAad: NonceAad;
  /** `kem_ct(1088) || nonce(12) || aead_ct||tag` concatenation. */
  ciphertext: Uint8Array;
  decryptionHint: DecryptHint;
  /** Raw 1952-byte ML-DSA-65 public key. */
  senderPubkey: Uint8Array;
  /** 3309-byte ML-DSA-65 signature over the canonical preimage digest. */
  outerSignature: Uint8Array;
  /** 20-byte sender address (must equal `keccak256(senderPubkey)[12..32]`). */
  sender: Uint8Array;
}

// ---- Bincode helpers ----

/**
 * Bincode `u128` as 16-byte little-endian. The SDK's `BincodeWriter`
 * doesn't expose this directly — `NonceAad`'s fee fields are the only
 * u128s the wallet has to encode, so the helper lives here.
 */
function bincodeU128Le(w: BincodeWriter, value: bigint): void {
  if (value < 0n || value >= 1n << 128n) {
    throw new Error(`u128 out of range: ${value}`);
  }
  const lo = value & 0xffff_ffff_ffff_ffffn;
  const hi = (value >> 64n) & 0xffff_ffff_ffff_ffffn;
  w.u64(lo);
  w.u64(hi);
}

/**
 * Bincode-encode `NonceAad` per the chain's `serde::Serialize` impl.
 * Field order matches `crates/mempool/src/envelope.rs::NonceAad`.
 *
 * Notable: `sender` is `Address`, which alloy_primitives serializes as a
 * length-prefixed `Vec<u8>` (NOT a fixed `[u8; 20]`) — see the SDK's
 * `bincodeTransaction` for the same quirk.
 */
export function bincodeNonceAad(aad: NonceAad): Uint8Array {
  if (aad.sender.length !== 20) {
    throw new Error(`NonceAad.sender must be 20 bytes, got ${aad.sender.length}`);
  }
  const w = new BincodeWriter();
  w.bytes(aad.sender); // length-prefixed
  w.u64(aad.nonce); // Nonce(u64) newtype
  w.u64(aad.chainId); // ChainId(u64) newtype
  w.enumVariant(aad.class); // Class enum — 4-byte LE u32 variant index
  bincodeU128Le(w, aad.maxFeePerGas);
  bincodeU128Le(w, aad.maxPriorityFeePerGas);
  w.u64(aad.gasLimit); // Gas(u64) newtype isn't used here — `gas_limit` is plain u64 on AAD
  return w.toBytes();
}

/**
 * Bincode-encode `DecryptHint` per the chain's `serde::Serialize` impl.
 * Field order matches `crates/mempool/src/envelope.rs::DecryptHint`.
 */
export function bincodeDecryptHint(hint: DecryptHint): Uint8Array {
  const w = new BincodeWriter();
  w.u64(hint.epoch);
  w.u16(hint.scheme);
  return w.toBytes();
}

/**
 * Bincode the `Signature::MlDsa65` / `PublicKey::MlDsa65` enum variants.
 * Wire layout (matches the SDK's `bincodeMlDsa65Signature`):
 *   `u32 LE variant_index || u16 LE algo_number || u64 LE bytes_len || raw bytes`
 */
function bincodeMlDsa65Opaque(w: BincodeWriter, raw: Uint8Array): void {
  w.enumVariant(ENUM_VARIANT_INDEX_ML_DSA_65);
  w.u16(STANDARD_ALGO_NUMBER_ML_DSA_65);
  w.bytes(raw);
}

/**
 * Bincode the full `EncryptedEnvelope` for the `lyth_submitEncrypted`
 * RPC. Field order: `nonce_aad, ciphertext, decryption_hint,
 * sender_pubkey, outer_signature, sender`. Re-ordering is a wire-break
 * per the chain's wire contract.
 */
export function bincodeEncryptedEnvelope(env: EncryptedEnvelope): Uint8Array {
  if (env.senderPubkey.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
    throw new Error(
      `senderPubkey must be ${ML_DSA_65_PUBLIC_KEY_LEN} bytes, got ${env.senderPubkey.length}`,
    );
  }
  if (env.outerSignature.length !== ML_DSA_65_SIGNATURE_LEN) {
    throw new Error(
      `outerSignature must be ${ML_DSA_65_SIGNATURE_LEN} bytes, got ${env.outerSignature.length}`,
    );
  }
  if (env.sender.length !== 20) {
    throw new Error(`sender must be 20 bytes, got ${env.sender.length}`);
  }
  const w = new BincodeWriter();
  // nonce_aad — embed bytes directly so we don't double-allocate; bincode
  // composes structs by concatenating their field bytes in order, so the
  // already-encoded AAD slots in unchanged.
  w.rawBytes(bincodeNonceAad(env.nonceAad));
  w.bytes(env.ciphertext); // Vec<u8> = `Bytes` — 8-byte LE length + bytes
  w.rawBytes(bincodeDecryptHint(env.decryptionHint));
  bincodeMlDsa65Opaque(w, env.senderPubkey);
  bincodeMlDsa65Opaque(w, env.outerSignature);
  w.bytes(env.sender); // Address — length-prefixed Vec<u8> of 20 bytes
  return w.toBytes();
}

// ---- Encrypt + decrypt the inner ciphertext field ----

/**
 * Encrypt a bincode-encoded `SignedTransaction` for the cluster.
 *
 * Pipeline (matches `MlKemSingleKeyDecryptor::encrypt`):
 *   1. ML-KEM-768 encapsulate to `kemEncapsulationKey` →
 *      `(kem_ct[1088], shared_secret[32])`.
 *   2. Draw a fresh 12-byte ChaCha20-Poly1305 nonce.
 *   3. AEAD-encrypt the inner bytes with key = shared_secret,
 *      nonce, AAD = `domain_tag || bincode(nonce_aad)`.
 *   4. Concatenate `kem_ct || nonce || aead_ct||tag` into the
 *      EncryptedEnvelope.ciphertext bytes.
 *
 * Caller is responsible for keeping `nonceAad` in sync with the
 * inner tx's `chain_id`, `nonce`, sender, gas fields, and fee fields
 * (the chain checks all six on reveal — mismatch is slashable).
 */
export function encryptInnerTx(
  signedInnerTxBincode: Uint8Array,
  nonceAad: NonceAad,
  kemEncapsulationKey: Uint8Array,
): Uint8Array {
  if (kemEncapsulationKey.length !== ML_KEM_768_ENCAPSULATION_KEY_LEN) {
    throw new Error(
      `kemEncapsulationKey must be ${ML_KEM_768_ENCAPSULATION_KEY_LEN} bytes, got ${kemEncapsulationKey.length}`,
    );
  }
  const { cipherText: kemCt, sharedSecret } =
    ml_kem768.encapsulate(kemEncapsulationKey);
  if (kemCt.length !== ML_KEM_768_CIPHERTEXT_LEN) {
    throw new Error(
      `ML-KEM-768 ciphertext length drift: ${kemCt.length} vs expected ${ML_KEM_768_CIPHERTEXT_LEN}`,
    );
  }
  if (sharedSecret.length !== ML_KEM_768_SHARED_SECRET_LEN) {
    throw new Error(
      `ML-KEM-768 shared secret length drift: ${sharedSecret.length} vs expected ${ML_KEM_768_SHARED_SECRET_LEN}`,
    );
  }

  const nonce = randomBytes(DKG_NONCE_LEN);
  const aadBytes = aadFor(nonceAad);
  const cipher = chacha20poly1305(sharedSecret, nonce, aadBytes);
  const aeadCt = cipher.encrypt(signedInnerTxBincode);

  // Wipe the shared secret as soon as we're done with it. JS doesn't
  // give us deterministic memory wiping, but releasing the buffer
  // contents makes a reused-buffer attack visibly less plausible.
  sharedSecret.fill(0);

  const out = new Uint8Array(kemCt.length + nonce.length + aeadCt.length);
  out.set(kemCt, 0);
  out.set(nonce, kemCt.length);
  out.set(aeadCt, kemCt.length + nonce.length);
  return out;
}

/**
 * Inverse of `encryptInnerTx` — only used in unit tests, not by the
 * wallet itself (the wallet never holds the cluster's decapsulation key).
 *
 * Throws on tampered ciphertext (FIPS-203 implicit rejection yields a
 * pseudo-random shared secret which fails the AEAD tag check) or
 * AAD mismatch.
 */
export function decryptInnerTx(
  ciphertext: Uint8Array,
  nonceAad: NonceAad,
  kemDecapsulationKey: Uint8Array,
): Uint8Array {
  if (ciphertext.length < ML_KEM_768_CIPHERTEXT_LEN + DKG_NONCE_LEN + DKG_AEAD_TAG_LEN) {
    throw new Error(
      `ciphertext too short: ${ciphertext.length} bytes (need ≥ ${
        ML_KEM_768_CIPHERTEXT_LEN + DKG_NONCE_LEN + DKG_AEAD_TAG_LEN
      })`,
    );
  }
  const kemCt = ciphertext.subarray(0, ML_KEM_768_CIPHERTEXT_LEN);
  const nonce = ciphertext.subarray(
    ML_KEM_768_CIPHERTEXT_LEN,
    ML_KEM_768_CIPHERTEXT_LEN + DKG_NONCE_LEN,
  );
  const aeadCt = ciphertext.subarray(ML_KEM_768_CIPHERTEXT_LEN + DKG_NONCE_LEN);
  const sharedSecret = ml_kem768.decapsulate(kemCt, kemDecapsulationKey);
  const aadBytes = aadFor(nonceAad);
  const cipher = chacha20poly1305(sharedSecret, nonce, aadBytes);
  const plaintext = cipher.decrypt(aeadCt);
  sharedSecret.fill(0);
  return plaintext;
}

/** AAD = `domain_tag || bincode(NonceAad)`. */
function aadFor(aad: NonceAad): Uint8Array {
  const aadBincode = bincodeNonceAad(aad);
  const out = new Uint8Array(DKG_AEAD_DOMAIN_TAG.length + aadBincode.length);
  out.set(DKG_AEAD_DOMAIN_TAG, 0);
  out.set(aadBincode, DKG_AEAD_DOMAIN_TAG.length);
  return out;
}

// ---- Outer-signature digest ----

/**
 * Compute the 32-byte digest the outer ML-DSA-65 signature commits to.
 *
 * Layout — matches `EncryptedEnvelope::signed_preimage` exactly:
 *   keccak256(
 *     bincode(nonce_aad)
 *     || ciphertext
 *     || bincode(decryption_hint)
 *     || sender_pubkey.canonical_address_bytes()  // raw 1952 mldsa pk
 *   )
 *
 * The chain's `verify_outer` calls `pubkey.verify(digest_bytes, sig)`
 * with `digest_bytes` being this 32-byte hash; the SDK's ML-DSA-65
 * sign path treats the digest as the message, so signing this digest
 * produces a valid outer signature.
 */
export function outerSigDigest(
  nonceAad: NonceAad,
  ciphertext: Uint8Array,
  decryptionHint: DecryptHint,
  senderPubkey: Uint8Array,
): Uint8Array {
  if (senderPubkey.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
    throw new Error(
      `senderPubkey must be ${ML_DSA_65_PUBLIC_KEY_LEN} bytes, got ${senderPubkey.length}`,
    );
  }
  const aadBytes = bincodeNonceAad(nonceAad);
  const hintBytes = bincodeDecryptHint(decryptionHint);
  const preimage = new Uint8Array(
    aadBytes.length + ciphertext.length + hintBytes.length + senderPubkey.length,
  );
  let off = 0;
  preimage.set(aadBytes, off);
  off += aadBytes.length;
  preimage.set(ciphertext, off);
  off += ciphertext.length;
  preimage.set(hintBytes, off);
  off += hintBytes.length;
  preimage.set(senderPubkey, off);
  return keccak_256(preimage);
}

// ---- Top-level builder ----

/**
 * Wrap a signed inner tx in an `EncryptedEnvelope` ready to ship via
 * `lyth_submitEncrypted`. Caller passes a `signOuterDigest` callback so
 * the unlocked v3 keystore stays the only place the wallet's secret key
 * is dereferenced (see `signOuterDigestV3` in keystore-mldsa.ts).
 *
 * Returns the structured envelope (for diagnostics / testing) and the
 * bincode wire bytes (hex-encode + send to the RPC).
 */
export async function buildEncryptedEnvelope(args: {
  /** `bincode(SignedTransaction)` — produced by the SDK's `wireBytesEvm`. */
  signedInnerTxBincode: Uint8Array;
  /** AAD claims; gas/fee fields MUST mirror the inner tx (R3-H08). */
  nonceAad: NonceAad;
  /** Decrypt epoch + scheme — usually `{ epoch: getEncryptionKey.epoch, scheme: 0 }`. */
  decryptionHint: DecryptHint;
  /** Cluster's ML-KEM-768 encapsulation key from `lyth_getEncryptionKey`. */
  kemEncapsulationKey: Uint8Array;
  /** 20-byte sender address — must derive from `senderPubkey`. */
  senderAddress: Uint8Array;
  /** Raw 1952-byte ML-DSA-65 public key. */
  senderPubkey: Uint8Array;
  /** ML-DSA-65 sign of the 32-byte digest — usually `signOuterDigestV3`. */
  signOuterDigest: (digest: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}): Promise<{ envelope: EncryptedEnvelope; wireBytes: Uint8Array; wireHex: string }> {
  const ciphertext = encryptInnerTx(
    args.signedInnerTxBincode,
    args.nonceAad,
    args.kemEncapsulationKey,
  );
  const digest = outerSigDigest(
    args.nonceAad,
    ciphertext,
    args.decryptionHint,
    args.senderPubkey,
  );
  const outerSignature = await args.signOuterDigest(digest);
  if (outerSignature.length !== ML_DSA_65_SIGNATURE_LEN) {
    throw new Error(
      `outer signature length drift: got ${outerSignature.length}, expected ${ML_DSA_65_SIGNATURE_LEN}`,
    );
  }
  const envelope: EncryptedEnvelope = {
    nonceAad: args.nonceAad,
    ciphertext,
    decryptionHint: args.decryptionHint,
    senderPubkey: args.senderPubkey,
    outerSignature,
    sender: args.senderAddress,
  };
  const wireBytes = bincodeEncryptedEnvelope(envelope);
  let wireHex = "0x";
  for (let i = 0; i < wireBytes.length; i++) {
    wireHex += wireBytes[i]!.toString(16).padStart(2, "0");
  }
  return { envelope, wireBytes, wireHex };
}
