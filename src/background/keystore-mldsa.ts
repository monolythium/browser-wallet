// Monolythium Wallet — ML-DSA-65 keystore (vault v4).
//
// Vault layout (stored under chrome.storage.local["mono.vault.v4"]):
//
//   {
//     version: 4,
//     algo: "ml-dsa-65",
//     kdf: "argon2id",
//     kdfParams: { m: 65536, t: 3, p: 1, salt: "<base64 16B>" },
//     aead: "xchacha20-poly1305",
//     nonce: "<base64 24B>",
//     ciphertext: "<base64 seed32 || tag>",        // 32-byte ML-DSA-65 seed
//     mnemonicCiphertext: "<base64 utf8(mnemonic) || tag>",
//     mnemonicNonce: "<base64 24B>",
//     addr: "0x...",                               // keccak256(mldsa_pk)[12..32]
//   }
//
// v4 strict (Phase 3.5): mnemonic fields are MANDATORY, not optional.
// Every v4 vault carries an encrypted mnemonic so Settings → Show
// recovery phrase always works. The seed-only vault-creation paths
// from earlier builds (v3) are gone; they survive transitionally as
// stub-throwing exports until Phase 3.5 Commit C removes them entirely.
//
// v3→v4 migration is silent: the storage key was bumped from
// "mono.vault.v3" to "mono.vault.v4", so any old v3 entry on disk is
// unreachable from this code path. Internal-dev upgraders land on
// Welcome and re-onboard. No migration UX, no detection branch — the
// key bump is the migration.
//
// Why a separate vault format and not v2-with-bigger-payload: the
// algorithm change is a breaking semantic change. A v2 vault holds a
// 32-byte secp256k1 private key; a v4 vault holds a 32-byte ML-DSA-65
// *seed* that derives a 4032-byte secret key + 1952-byte public key
// + 20-byte address, plus a persisted mnemonic. v2 vaults are NOT
// auto-upgraded — the user re-imports their seed (or generates fresh).
//
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  MlDsa65Backend,
  generatePqm1Mnemonic,
  pqm1MnemonicToMlDsa65Seed,
} from "@monolythium/core-sdk/crypto";

const VAULT_KEY_V4 = "mono.vault.v4";

const ARGON2_M_KIB = 64 * 1024; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_DKLEN = 32;
const SALT_LEN = 16;
const XCHACHA_NONCE_LEN = 24;
const SEED_LEN = 32;

const SCHEMA_VERSION = 4;
const ALGO_ID = "ml-dsa-65" as const;
const KDF_ID = "argon2id" as const;
const AEAD_ID = "xchacha20-poly1305" as const;

// HKDF info labels — committed to the v4 schema. The `-v4` suffix means
// any future schema bump can rotate these labels (and therefore the
// derived sub-keys) cleanly without ambiguity.
const HKDF_INFO_SEED = new TextEncoder().encode("mono-seed-v4");
const HKDF_INFO_MNEMONIC = new TextEncoder().encode("mono-mnemonic-reveal-v4");
const SUBKEY_LEN = 32; // XChaCha20-Poly1305 expects a 256-bit key.

interface VaultEnvelopeV4 {
  version: 4;
  algo: typeof ALGO_ID;
  kdf: typeof KDF_ID;
  kdfParams: { m: number; t: number; p: number; salt: string };
  aead: typeof AEAD_ID;
  nonce: string;
  ciphertext: string;
  /** UTF-8 mnemonic encrypted under the same Argon2id-derived DEK as
   *  the seed (Commit B switches each side to its own HKDF sub-key).
   *  Mandatory in v4 — every vault is revealable by definition. */
  mnemonicCiphertext: string;
  mnemonicNonce: string;
  addr: string;
}

interface UnlockedState {
  backend: MlDsa65Backend;
  /** Cached `0x`-prefixed address — same value MlDsa65Backend.getAddress() returns. */
  address: string;
}

let unlocked: UnlockedState | null = null;

// ---- base64 helpers (no Buffer in service workers) ----

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

/**
 * Expand the Argon2id-derived DEK into two 32-byte XChaCha20 sub-keys via
 * HKDF-SHA-256 with explicit, schema-bound info labels:
 *
 *   seedKey     = HKDF(DEK, info="mono-seed-v4")
 *   mnemonicKey = HKDF(DEK, info="mono-mnemonic-reveal-v4")
 *
 * Why HKDF and not the DEK directly: reusing the same key across two
 * AEAD encryptions is safe under XChaCha20-Poly1305 (the random nonces
 * already give us IND-CPA), but separating the keys gives us a clean
 * audit story + decoupled re-encryption hooks for a future
 * password-change flow that may need to rotate one side independently.
 *
 * Caller owns the DEK lifetime — this helper does not zero `dek`.
 * Caller MUST zero both returned sub-keys after use (mirroring the
 * `dek.fill(0)` discipline elsewhere in this module).
 */
function deriveSubKeys(dek: Uint8Array): {
  seedKey: Uint8Array;
  mnemonicKey: Uint8Array;
} {
  const seedKey = hkdf(sha256, dek, undefined, HKDF_INFO_SEED, SUBKEY_LEN);
  const mnemonicKey = hkdf(
    sha256,
    dek,
    undefined,
    HKDF_INFO_MNEMONIC,
    SUBKEY_LEN,
  );
  return { seedKey, mnemonicKey };
}

// ---- chrome.storage helpers ----

async function loadRawV4(): Promise<unknown | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY_V4], (res) => {
      resolve(res?.[VAULT_KEY_V4] ?? null);
    });
  });
}

function isV4Envelope(raw: unknown): raw is VaultEnvelopeV4 {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== SCHEMA_VERSION) return false;
  if (obj["algo"] !== ALGO_ID) return false;
  if (obj["kdf"] !== KDF_ID) return false;
  if (obj["aead"] !== AEAD_ID) return false;
  const params = obj["kdfParams"] as Record<string, unknown> | undefined;
  if (!params || typeof params !== "object") return false;
  if (typeof params["m"] !== "number") return false;
  if (typeof params["t"] !== "number") return false;
  if (typeof params["p"] !== "number") return false;
  if (typeof params["salt"] !== "string") return false;
  if (typeof obj["nonce"] !== "string") return false;
  if (typeof obj["ciphertext"] !== "string") return false;
  if (typeof obj["mnemonicCiphertext"] !== "string") return false;
  if (typeof obj["mnemonicNonce"] !== "string") return false;
  if (typeof obj["addr"] !== "string") return false;
  return true;
}

async function loadVaultV4(): Promise<VaultEnvelopeV4 | null> {
  const raw = await loadRawV4();
  if (raw === null) return null;
  if (isV4Envelope(raw)) return raw;
  throw new Error("v4 vault envelope is unrecognised — refusing to read");
}

async function saveVaultV4(envelope: VaultEnvelopeV4): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VAULT_KEY_V4]: envelope }, () => resolve());
  });
}

// ---- public API ----

export async function hasVaultV4(): Promise<boolean> {
  const v = await loadVaultV4();
  return v !== null;
}

export async function getStoredAddressV4(): Promise<string | null> {
  const v = await loadVaultV4();
  return v?.addr ?? null;
}

export function isUnlockedV4(): boolean {
  return unlocked !== null;
}

export function getUnlockedAddressV4(): string | null {
  return unlocked?.address ?? null;
}

/** Lock — drop the in-memory backend reference. The backend's secret key
 * is held by the SDK in private fields; we cannot zero it deterministically,
 * but releasing the reference makes it eligible for GC. */
export function lockV4(): void {
  unlocked = null;
}

/**
 * Wipe the v4 vault from chrome.storage.local and drop the in-memory
 * backend. Used by both the password-confirmed Settings → Reset wallet
 * path and the Welcome → Forgot password? path. Caller is responsible
 * for clearing the lockout counters (`SESSION_KEY_UNLOCK_FAIL_COUNT`,
 * `_UNTIL`) and broadcasting `walletLocked` if the popup needs to
 * route — those live in the SW dispatcher.
 */
export async function wipeVaultV4(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove(VAULT_KEY_V4, () => resolve());
  });
  lockV4();
}

/**
 * Generate a fresh PQM-1 v1 24-word mnemonic and commit a v4 vault.
 *
 * The returned mnemonic is the recovery secret. Treat it like a private key.
 * The mnemonic is also persisted in the vault (encrypted under the same DEK)
 * so the Settings → Show recovery phrase flow can re-display it after a
 * password re-auth.
 */
export async function createVaultFromNewMnemonic(password: string): Promise<{
  mnemonic: string;
  address: string;
}> {
  if (await hasVaultV4()) {
    throw new Error("v4 vault already exists; cannot overwrite");
  }
  const mnemonic = generatePqm1Mnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
  const address = await commitVaultFromSeed(password, seed, mnemonic);
  seed.fill(0);
  return { mnemonic, address };
}

/** Import from a user-supplied PQM-1 v1 24-word mnemonic.
 *
 * The supplied mnemonic is persisted alongside the seed (encrypted) so the
 * imported wallet can re-display the phrase from Settings without forcing
 * the user to re-import. */
export async function createVaultFromMnemonic(
  password: string,
  mnemonic: string,
): Promise<{ address: string }> {
  if (await hasVaultV4()) {
    throw new Error("v4 vault already exists; cannot overwrite");
  }
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
  const address = await commitVaultFromSeed(password, seed, mnemonic);
  seed.fill(0);
  return { address };
}

async function commitVaultFromSeed(
  password: string,
  seed: Uint8Array,
  mnemonic: string,
): Promise<string> {
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes`);
  }
  if (mnemonic.length === 0) {
    throw new Error("mnemonic must be non-empty");
  }

  // Derive the keypair eagerly to compute the address that goes in the envelope.
  const backend = MlDsa65Backend.fromSeed(seed);
  const address = await backend.getAddress();

  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(XCHACHA_NONCE_LEN);
  const dek = await argon2idAsync(
    new TextEncoder().encode(password),
    salt,
    { m: ARGON2_M_KIB, t: ARGON2_T, p: ARGON2_P, dkLen: ARGON2_DKLEN },
  );
  const { seedKey, mnemonicKey } = deriveSubKeys(dek);
  dek.fill(0);

  let ct: Uint8Array;
  let mnCt: Uint8Array;
  const mnNonceBytes = randomBytes(XCHACHA_NONCE_LEN);
  try {
    const seedCipher = xchacha20poly1305(seedKey, nonce);
    ct = seedCipher.encrypt(seed);
    const mnCipher = xchacha20poly1305(mnemonicKey, mnNonceBytes);
    const mnPlain = new TextEncoder().encode(mnemonic);
    mnCt = mnCipher.encrypt(mnPlain);
    mnPlain.fill(0);
  } finally {
    seedKey.fill(0);
    mnemonicKey.fill(0);
  }

  const envelope: VaultEnvelopeV4 = {
    version: SCHEMA_VERSION,
    algo: ALGO_ID,
    kdf: KDF_ID,
    kdfParams: {
      m: ARGON2_M_KIB,
      t: ARGON2_T,
      p: ARGON2_P,
      salt: bytesToBase64(salt),
    },
    aead: AEAD_ID,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ct),
    mnemonicCiphertext: bytesToBase64(mnCt),
    mnemonicNonce: bytesToBase64(mnNonceBytes),
    addr: address,
  };
  await saveVaultV4(envelope);

  unlocked = { backend, address };
  return address;
}

/**
 * Decrypt the v4 vault and load the ML-DSA-65 backend into memory.
 * Throws `"wrong password"` on AEAD failure.
 */
export async function unlockV4(password: string): Promise<{ address: string }> {
  const v = await loadVaultV4();
  if (!v) throw new Error("no v4 vault — run onboarding first");

  const salt = base64ToBytes(v.kdfParams.salt);
  const nonce = base64ToBytes(v.nonce);
  const ct = base64ToBytes(v.ciphertext);

  const dek = await argon2idAsync(
    new TextEncoder().encode(password),
    salt,
    {
      m: v.kdfParams.m,
      t: v.kdfParams.t,
      p: v.kdfParams.p,
      dkLen: ARGON2_DKLEN,
    },
  );
  const { seedKey, mnemonicKey } = deriveSubKeys(dek);
  dek.fill(0);
  // mnemonicKey isn't needed for unlock (the mnemonic is only decrypted
  // on demand by exportMnemonicV4). Zero it immediately rather than
  // letting it sit in memory until GC.
  mnemonicKey.fill(0);

  let seed: Uint8Array;
  try {
    const cipher = xchacha20poly1305(seedKey, nonce);
    seed = cipher.decrypt(ct);
  } catch {
    throw new Error("wrong password");
  } finally {
    seedKey.fill(0);
  }
  if (seed.length !== SEED_LEN) {
    seed.fill(0);
    throw new Error(`vault payload is not a ${SEED_LEN}-byte seed`);
  }

  const backend = MlDsa65Backend.fromSeed(seed);
  const address = await backend.getAddress();
  // The seed lives inside the backend now (as the keypair); we can drop our copy.
  seed.fill(0);
  unlocked = { backend, address };
  return { address };
}

/**
 * Re-derive the DEK from `password` and decrypt the stored mnemonic.
 * v4 schema mandates the mnemonic, so this returns the mnemonic on
 * success or throws `"wrong password"` on AEAD failure — never returns
 * null. The seed AEAD is decrypted first so the password check is
 * anchored to the same primary record that `unlockV4` validates.
 */
export async function exportMnemonicV4(
  password: string,
): Promise<{ mnemonic: string }> {
  const v = await loadVaultV4();
  if (!v) throw new Error("no v4 vault — run onboarding first");

  const salt = base64ToBytes(v.kdfParams.salt);
  const seedNonce = base64ToBytes(v.nonce);
  const seedCt = base64ToBytes(v.ciphertext);
  const mnNonce = base64ToBytes(v.mnemonicNonce);
  const mnCt = base64ToBytes(v.mnemonicCiphertext);

  const dek = await argon2idAsync(
    new TextEncoder().encode(password),
    salt,
    {
      m: v.kdfParams.m,
      t: v.kdfParams.t,
      p: v.kdfParams.p,
      dkLen: ARGON2_DKLEN,
    },
  );
  const { seedKey, mnemonicKey } = deriveSubKeys(dek);
  dek.fill(0);
  try {
    // Verify password by decrypting the seed first; if this fails the
    // mnemonic decrypt would also fail, but anchoring to the seed keeps
    // the wrong-password signal identical to unlockV4.
    const seedCipher = xchacha20poly1305(seedKey, seedNonce);
    const seedPlain = seedCipher.decrypt(seedCt);
    seedPlain.fill(0);
    const mnCipher = xchacha20poly1305(mnemonicKey, mnNonce);
    const mnPlain = mnCipher.decrypt(mnCt);
    const mnemonic = new TextDecoder().decode(mnPlain);
    mnPlain.fill(0);
    return { mnemonic };
  } catch {
    throw new Error("wrong password");
  } finally {
    seedKey.fill(0);
    mnemonicKey.fill(0);
  }
}


/**
 * Sign + bincode-encode a Monolythium-native EVM transaction.
 * Returns the wire-ready 0x-prefixed hex string + tx hash + the raw
 * `bincode(SignedTransaction)` bytes (needed by the SDK encrypted-envelope
 * wrapper, which uses the raw bytes as the AEAD plaintext).
 */
export async function signEvmTxV4(req: {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: Uint8Array | null;
  value: bigint;
  input?: Uint8Array;
}): Promise<{
  rawTxHex: string;
  sighashHex: string;
  wireBytes: number;
  /** Raw `bincode(SignedTransaction)` bytes — same payload `rawTxHex` carries. */
  bincodeBytes: Uint8Array;
  /** Raw 32-byte sighash. */
  sighashBytes: Uint8Array;
}> {
  if (!unlocked) throw new Error("v4 wallet is locked");
  const result = unlocked.backend.signEvmTx(req);
  return {
    rawTxHex: "0x" + result.wireHex,
    sighashHex: "0x" + bytesToHex(result.sighash),
    wireBytes: result.wireBytes.length,
    bincodeBytes: result.wireBytes,
    sighashBytes: result.sighash,
  };
}

/** Get the unlocked backend's 1952-byte public key — needed for monkey-patched
 * `eth_accounts` views that want to surface "this is the ML-DSA pubkey" along
 * with the address. */
export function getUnlockedPublicKeyV4(): Uint8Array | null {
  return unlocked?.backend.publicKey() ?? null;
}

/**
 * Raw 20-byte address from the unlocked backend — convenient when
 * building a `NonceAad` (which carries a `sender` byte array, not a
 * hex string). Returns null when the keystore is locked.
 */
export function getUnlockedAddressBytesV4(): Uint8Array | null {
  return unlocked?.backend.addressBytes() ?? null;
}

export function getUnlockedBackendV4(): MlDsa65Backend | null {
  return unlocked?.backend ?? null;
}

/**
 * Sign an arbitrary 32-byte digest with ML-DSA-65 — used by the
 * SDK encrypted-envelope outer signature, which signs
 * `keccak256(bincode(nonce_aad) || ciphertext || bincode(decryption_hint)
 * || sender_pubkey)`. Keeping the secret-key dereference inside this
 * module is what keeps secret-key dereferences scoped to the keystore.
 *
 * Throws `"v4 wallet is locked"` if the keystore isn't unlocked.
 */
export function signOuterDigestV4(digest: Uint8Array): Uint8Array {
  if (!unlocked) throw new Error("v4 wallet is locked");
  if (digest.length !== 32) {
    throw new Error(`outer digest must be 32 bytes, got ${digest.length}`);
  }
  return unlocked.backend.signPrehash(digest);
}

// ---- hex helpers ----

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
