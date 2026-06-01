// SLH-DSA-SHA2-128s key generation + cold-storage
// preparation.
//
// What this module owns
// =====================
// The keygen + VEK-wrap path for the §30.1 emergency-backup-key
// surface. Pure module — no `chrome.storage`, no IPC. The SW IPC
// handler (wiring inside service-worker.ts) calls
// `prepareSlhDsaBackup` with the vault's already-unwrapped VEK, then
// hands the returned `{ backup, mnemonic }` to:
//
//   1. `writeSlhDsaBackupV4(vaultId, backup)` — persists the
//      encrypted secret + pubkey + status fields (the backup CRUD seam).
//   2. The popup-side reveal modal, which shows the
//      24-word `mnemonic` for the user to write down. The SW NEVER
//      persists the mnemonic — only the user's cold-storage copy
//      survives a wallet wipe.
//
// Cryptographic design
// ====================
// Entropy → 32 bytes from `crypto.getRandomValues()` (CSPRNG quality
// is the OS's responsibility; both Chrome and Firefox ship a
// well-reviewed implementation here).
//
// Mnemonic encoding → BIP-39 24-word English wordlist via
// `@scure/bip39`. Same wordlist + same `entropyToMnemonic` path the
// primary PQM-1 mnemonic uses (whitepaper §21.2.1) so users see a
// familiar shape. 32-byte entropy = 256 bits = 24 words.
//
// Seed expansion → `SHAKE256(domain || entropy, 48)` where
// `domain = "monolythium.slh-dsa-backup.v1"`. The 48-byte output is
// fed directly to `slh_dsa_sha2_128s.keygen(seed)`. The domain
// separation:
//   - prevents collision with `PQM1_V1_MLDSA65_DOMAIN_TAG` (different
//     literal string → different SHAKE state)
//   - lets a future chain-canonicalized PQM-1 SLH-DSA branch land
//     under a different tag without invalidating existing on-chain
//     registrations
//   - is wallet-side ONLY; the chain has not pinned this derivation
//     (see CHAIN GAP TRACKER in `shared/slh-dsa-backup.ts`)
//
// Storage AEAD → XChaCha20-Poly1305 with a fresh 24-byte nonce per
// record, keyed by the vault's VEK (reused from the primary
// envelope, established by the v4-multi layer). The VEK never leaves this
// module's caller's stack — caller passes it in, this module never
// holds it past the function return.
//
// Secret-key handling → the 64-byte `slh_dsa_sha2_128s` secret key
// is zeroed in `finally` immediately after encryption. The mnemonic
// is returned by-value to the caller, which passes it to the popup
// for the reveal flow and lets it fall out of scope.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { shake256 } from "@noble/hashes/sha3.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist as ENGLISH_WORDLIST } from "@scure/bip39/wordlists/english.js";

import {
  SLH_DSA_BACKUP_DOMAIN_TAG,
  SLH_DSA_SHA2_128S_LENGTHS,
  type SlhDsaBackup,
} from "../shared/slh-dsa-backup.js";

/** Length, in bytes, of the BIP-39 entropy the wallet generates.
 *  32 bytes → 24 words → covers the 128-bit PQ security target with
 *  comfortable headroom. */
export const SLH_DSA_BACKUP_ENTROPY_BYTES = 32;

/** Length, in bytes, of the XChaCha20-Poly1305 nonce on every
 *  AEAD slot we open. Matches the primary envelope's nonce length. */
const XCHACHA_NONCE_LEN = 24;

/** Expected VEK length. Same per-vault encryption key the primary
 *  envelope uses; we don't HKDF-derive a sub-key because the AEAD
 *  scopes by nonce already + a sub-key adds no extra security
 *  property over a fresh nonce + random key. */
const VEK_LEN = 32;

/** Output of [`prepareSlhDsaBackup`]. The mnemonic is returned by
 *  value for the reveal-modal flow; everything else is the
 *  persistable record the SW writes to chrome.storage. */
export interface PreparedBackup {
  /** What the user writes down. 24 English words separated by single
   *  spaces, NFC-normalised by BIP-39's encoder. */
  mnemonic: string;
  /** What the SW persists into VaultRecordV4.slhDsaBackup. */
  backup: SlhDsaBackup;
}

// ────────────────────────────────────────────────────────────────────────────
// Base64 + hex helpers (no Buffer in service workers)
// ────────────────────────────────────────────────────────────────────────────

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Seed derivation
// ────────────────────────────────────────────────────────────────────────────

/** SHAKE256-expand 32 bytes of entropy into the 48-byte SLH-DSA-128s
 *  keygen seed, domain-separated by the wallet-side tag.
 *
 *  Exported for the test seam so a fixture-driven test can pin the
 *  derivation against a known entropy → expected-seed mapping. */
export function deriveSlhDsaSeed(entropy: Uint8Array): Uint8Array {
  if (entropy.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    throw new Error(
      `deriveSlhDsaSeed: entropy must be ${SLH_DSA_BACKUP_ENTROPY_BYTES} bytes`,
    );
  }
  const domain = new TextEncoder().encode(SLH_DSA_BACKUP_DOMAIN_TAG);
  const out = shake256
    .create({ dkLen: SLH_DSA_SHA2_128S_LENGTHS.seed })
    .update(domain)
    .update(entropy)
    .digest();
  if (out.length !== SLH_DSA_SHA2_128S_LENGTHS.seed) {
    throw new Error("shake256 returned unexpected length");
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Mnemonic ↔ entropy
// ────────────────────────────────────────────────────────────────────────────

/** Build a 24-word BIP-39 phrase from the supplied entropy. Exported
 *  for the test seam and for the re-export flow that
 *  re-derives the mnemonic from the stored encrypted secret. */
export function entropyToBackupMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    throw new Error(
      `entropyToBackupMnemonic: entropy must be ${SLH_DSA_BACKUP_ENTROPY_BYTES} bytes`,
    );
  }
  // `@scure/bip39` returns NFC-normalised mnemonic strings already.
  return entropyToMnemonic(entropy, ENGLISH_WORDLIST);
}

/** Inverse of [`entropyToBackupMnemonic`]. Used by the eventual G3
 *  rotation flow (deferred); exported here so the
 *  derivation seam is testable end-to-end today. Throws on bad
 *  mnemonic (wrong word count, unknown word, bad BIP-39 checksum). */
export function backupMnemonicToEntropy(mnemonic: string): Uint8Array {
  const ent = mnemonicToEntropy(mnemonic.trim(), ENGLISH_WORDLIST);
  if (ent.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    throw new Error(
      `backupMnemonicToEntropy: decoded entropy is ${ent.length} bytes, want ${SLH_DSA_BACKUP_ENTROPY_BYTES}`,
    );
  }
  return ent;
}

// ────────────────────────────────────────────────────────────────────────────
// AEAD wrap / unwrap
// ────────────────────────────────────────────────────────────────────────────

/** Generic XChaCha20-Poly1305 wrap over an arbitrary plaintext.
 *  Used for both the 64-byte SLH-DSA secret and the 32-byte BIP-39
 *  entropy slots — every call gets a fresh random nonce so the same
 *  VEK can safely seal multiple distinct payloads. */
function wrapUnderVek(
  vek: Uint8Array,
  plaintext: Uint8Array,
): { ciphertext: string; nonce: string } {
  if (vek.length !== VEK_LEN) {
    throw new Error(`wrapUnderVek: bad VEK length ${vek.length}`);
  }
  const nonce = randomBytes(XCHACHA_NONCE_LEN);
  const ct = xchacha20poly1305(vek, nonce).encrypt(plaintext);
  return {
    ciphertext: bytesToBase64(ct),
    nonce: bytesToBase64(nonce),
  };
}

/** Encrypt the 64-byte SLH-DSA secret key under the vault's VEK
 *  with XChaCha20-Poly1305. Returns the ciphertext + the random
 *  nonce, both base64-encoded for chrome.storage compatibility. The
 *  caller (this module's `prepareSlhDsaBackup`) zeroes the secret
 *  immediately after this returns. */
export function wrapSlhDsaSecret(
  vek: Uint8Array,
  secret: Uint8Array,
): { ciphertext: string; nonce: string } {
  if (secret.length !== SLH_DSA_SHA2_128S_LENGTHS.secretKey) {
    throw new Error(
      `wrapSlhDsaSecret: bad secret length ${secret.length}, want ${SLH_DSA_SHA2_128S_LENGTHS.secretKey}`,
    );
  }
  return wrapUnderVek(vek, secret);
}

/** Encrypt the 32-byte BIP-39 entropy under the vault's VEK. Only
 *  needed for the Re-export flow — without this slot the
 *  wallet would have to generate a fresh SLH-DSA keypair on every
 *  re-export, invalidating any prior on-chain registration. */
export function wrapBackupEntropy(
  vek: Uint8Array,
  entropy: Uint8Array,
): { ciphertext: string; nonce: string } {
  if (entropy.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    throw new Error(
      `wrapBackupEntropy: bad entropy length ${entropy.length}, want ${SLH_DSA_BACKUP_ENTROPY_BYTES}`,
    );
  }
  return wrapUnderVek(vek, entropy);
}

/** Inverse of [`wrapSlhDsaSecret`]. Throws on AEAD failure (wrong
 *  VEK, tampered ciphertext, mismatched nonce). The returned buffer
 *  MUST be zeroed by the caller after the rotation use is complete.
 *  Nothing invokes this on a routine path today — rotation is
 *  deferred — but the helper is here so the unit tests can pin a
 *  full encrypt/decrypt round-trip without waiting for the future
 *  rotation flow. */
export function unwrapSlhDsaSecret(
  vek: Uint8Array,
  ciphertext: string,
  nonce: string,
): Uint8Array {
  if (vek.length !== VEK_LEN) {
    throw new Error(`unwrapSlhDsaSecret: bad VEK length ${vek.length}`);
  }
  const ct = base64ToBytes(ciphertext);
  const n = base64ToBytes(nonce);
  // Throws an AEAD-tag failure on tamper / wrong key.
  return xchacha20poly1305(vek, n).decrypt(ct);
}

/** Inverse of [`wrapBackupEntropy`]. Used by the Settings → Security
 *  Re-export flow to recover the original 32-byte BIP-39
 *  entropy so the popup can re-derive the 24-word mnemonic without
 *  generating a new keypair. Throws on AEAD failure (wrong VEK,
 *  tampered ciphertext). */
export function unwrapBackupEntropy(
  vek: Uint8Array,
  ciphertext: string,
  nonce: string,
): Uint8Array {
  if (vek.length !== VEK_LEN) {
    throw new Error(`unwrapBackupEntropy: bad VEK length ${vek.length}`);
  }
  const out = xchacha20poly1305(vek, base64ToBytes(nonce)).decrypt(
    base64ToBytes(ciphertext),
  );
  if (out.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    out.fill(0);
    throw new Error(
      `unwrapBackupEntropy: decrypted entropy is ${out.length} bytes, want ${SLH_DSA_BACKUP_ENTROPY_BYTES}`,
    );
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level keygen entry point
// ────────────────────────────────────────────────────────────────────────────

/** Generate a fresh SLH-DSA-SHA2-128s backup keypair for the vault.
 *
 *  Returns:
 *   - `mnemonic` — 24-word BIP-39 phrase, for the popup reveal flow.
 *     Caller MUST pass this straight to the popup and not persist
 *     it; only the user's cold-storage copy survives a wallet wipe.
 *   - `backup` — the persistable [`SlhDsaBackup`] record with the
 *     VEK-wrapped secret + hex-encoded pubkey, ready to feed
 *     `writeSlhDsaBackupV4`.
 *
 *  Inputs:
 *   - `vek` — the vault's per-vault encryption key, already unwrapped
 *     by the caller from the cached MEK. This function does not
 *     hold the VEK past return.
 *   - `now` — `Date.now()` substitute for test determinism. Defaults
 *     to the live timestamp.
 *   - `entropy` — optional explicit entropy injection for fixture
 *     tests. Defaults to a freshly-generated 32-byte CSPRNG draw.
 *     **Production code MUST NOT pass this** — the SW IPC handler
 *     omits the field so live keygen always uses fresh CSPRNG entropy.
 */
export function prepareSlhDsaBackup(args: {
  vek: Uint8Array;
  now?: number;
  entropy?: Uint8Array;
}): PreparedBackup {
  const now = args.now ?? Date.now();
  const entropy = args.entropy ?? randomBytes(SLH_DSA_BACKUP_ENTROPY_BYTES);
  if (entropy.length !== SLH_DSA_BACKUP_ENTROPY_BYTES) {
    throw new Error(
      `prepareSlhDsaBackup: entropy must be ${SLH_DSA_BACKUP_ENTROPY_BYTES} bytes`,
    );
  }

  const mnemonic = entropyToBackupMnemonic(entropy);
  const seed = deriveSlhDsaSeed(entropy);

  let pubkey: Uint8Array;
  let secret: Uint8Array;
  try {
    const keypair = slh_dsa_sha2_128s.keygen(seed);
    pubkey = keypair.publicKey;
    secret = keypair.secretKey;
  } finally {
    seed.fill(0);
  }

  if (pubkey.length !== SLH_DSA_SHA2_128S_LENGTHS.publicKey) {
    secret.fill(0);
    throw new Error(
      `prepareSlhDsaBackup: pubkey length ${pubkey.length} != ${SLH_DSA_SHA2_128S_LENGTHS.publicKey}`,
    );
  }
  if (secret.length !== SLH_DSA_SHA2_128S_LENGTHS.secretKey) {
    secret.fill(0);
    throw new Error(
      `prepareSlhDsaBackup: secret length ${secret.length} != ${SLH_DSA_SHA2_128S_LENGTHS.secretKey}`,
    );
  }

  let secretWrapped: { ciphertext: string; nonce: string };
  try {
    secretWrapped = wrapSlhDsaSecret(args.vek, secret);
  } finally {
    // Zero the secret regardless of whether wrap succeeded — it has
    // served its purpose. The caller still holds the mnemonic, which
    // is the cold-storage path; the on-disk encrypted blob is only a
    // convenience for the rotation flow.
    secret.fill(0);
  }

  // Encrypt the entropy too so the Re-export flow can re-derive the
  // mnemonic on demand. The fresh nonce on this slot is independent
  // of the secret-key slot's nonce; nonce reuse across the two slots
  // would weaken the AEAD scheme.
  const entropyWrapped = wrapBackupEntropy(args.vek, entropy);
  // The caller-supplied entropy may be a long-lived buffer they
  // intend to reuse (tests do this) — only zero the working copy if
  // the caller did NOT pass it in.
  if (args.entropy === undefined) entropy.fill(0);

  const backup: SlhDsaBackup = {
    encryptedPrivateKey: secretWrapped.ciphertext,
    encryptedPrivateKeyNonce: secretWrapped.nonce,
    encryptedEntropy: entropyWrapped.ciphertext,
    encryptedEntropyNonce: entropyWrapped.nonce,
    publicKey: bytesToHex(pubkey),
    parameterSet: "slh_dsa_sha2_128s",
    chainRegistrationStatus: "not-registered",
    coldStorageConfirmed: false,
    createdAt: now,
  };

  return { mnemonic, backup };
}

/** Re-derive the 24-word mnemonic from a stored backup record by
 *  decrypting the entropy slot. Used by the Settings → Security
 *  Re-export flow — the user already password-unlocked,
 *  the caller already unwrapped the VEK; we just decrypt + re-encode.
 *  Throws on AEAD failure (wrong VEK / tampered ciphertext) and on
 *  any malformed entropy length. */
export function recoverBackupMnemonic(
  vek: Uint8Array,
  backup: SlhDsaBackup,
): string {
  const ent = unwrapBackupEntropy(
    vek,
    backup.encryptedEntropy,
    backup.encryptedEntropyNonce,
  );
  try {
    return entropyToBackupMnemonic(ent);
  } finally {
    ent.fill(0);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public-key recovery from the on-disk record (for chain-registration UX)
// ────────────────────────────────────────────────────────────────────────────

/** Decode a stored hex pubkey back to raw bytes. Used by the chain
 *  registration path to feed the precompile's `bytes`
 *  argument. Validates length so a corrupt record can't slip past. */
export function decodeBackupPublicKey(hexPubkey: string): Uint8Array {
  const bytes = hexToBytes(hexPubkey);
  if (bytes.length !== SLH_DSA_SHA2_128S_LENGTHS.publicKey) {
    throw new Error(
      `decodeBackupPublicKey: ${bytes.length} bytes, want ${SLH_DSA_SHA2_128S_LENGTHS.publicKey}`,
    );
  }
  return bytes;
}
