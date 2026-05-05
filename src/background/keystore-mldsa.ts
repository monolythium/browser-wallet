// Monolythium Wallet — ML-DSA-65 keystore (vault v3).
//
// Vault layout (stored under chrome.storage.local["mono.vault.v3"]):
//
//   {
//     version: 3,
//     algo: "ml-dsa-65",
//     kdf: "argon2id",
//     kdfParams: { m: 65536, t: 3, p: 1, salt: "<base64 16B>" },
//     aead: "xchacha20-poly1305",
//     nonce: "<base64 24B>",
//     ciphertext: "<base64 seed32 || tag>",   // 32-byte ML-DSA-65 seed
//     addr: "0x...",                          // keccak256(mldsa_pk)[12..32]
//     // Optional — present on vaults created with recovery-phrase reveal
//     // support (Phase 3+). The PQM-1 SDK does not support inverse
//     // derivation from the SHAKE256-derived seed, so the original
//     // mnemonic is persisted alongside the seed (encrypted under the
//     // same DEK, fresh nonce) to back the Settings → Show recovery
//     // phrase flow. Older vaults omit these fields and the reveal
//     // surface is disabled with an explanatory message.
//     mnemonicCiphertext?: "<base64 utf8(mnemonic) || tag>",
//     mnemonicNonce?: "<base64 24B>",
//   }
//
// Why "vault v3" and not v2-with-bigger-payload: the algorithm change
// is a breaking semantic change. A v2 vault holds a 32-byte secp256k1
// private key; a v3 vault holds a 32-byte ML-DSA-65 *seed* that derives
// a 4032-byte secret key + 1952-byte public key + 20-byte address.
// Same on-disk size for the secret material; completely different
// downstream interpretation. v2 vaults are NOT auto-upgraded — the user
// re-imports their seed (or generates a fresh one), per the same v1->v2
// ethos in keystore.ts.
//
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  MlDsa65Backend,
  generatePqm1Mnemonic,
  pqm1MnemonicToMlDsa65Seed,
} from "@monolythium/core-sdk/crypto";

const VAULT_KEY_V3 = "mono.vault.v3";

const ARGON2_M_KIB = 64 * 1024; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_DKLEN = 32;
const SALT_LEN = 16;
const XCHACHA_NONCE_LEN = 24;
const SEED_LEN = 32;

const SCHEMA_VERSION = 3;
const ALGO_ID = "ml-dsa-65" as const;
const KDF_ID = "argon2id" as const;
const AEAD_ID = "xchacha20-poly1305" as const;

interface VaultEnvelopeV3 {
  version: 3;
  algo: typeof ALGO_ID;
  kdf: typeof KDF_ID;
  kdfParams: { m: number; t: number; p: number; salt: string };
  aead: typeof AEAD_ID;
  nonce: string;
  ciphertext: string;
  addr: string;
  /** Phase 3+ — UTF-8 mnemonic encrypted under the same DEK as the
   *  seed, with a fresh nonce. Optional for backward compatibility
   *  with vaults created before the Show-Recovery-Phrase flow shipped. */
  mnemonicCiphertext?: string;
  mnemonicNonce?: string;
}

/** Error thrown when called against a v2 (secp256k1) envelope on a v3 op. */
export class WrongVaultVersionError extends Error {
  constructor() {
    super(
      "vault is v2 (secp256k1) — use the legacy keystore path; this module operates on v3 ML-DSA-65 vaults only",
    );
    this.name = "WrongVaultVersionError";
  }
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

// ---- chrome.storage helpers ----

async function loadRawV3(): Promise<unknown | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY_V3], (res) => {
      resolve(res?.[VAULT_KEY_V3] ?? null);
    });
  });
}

function isV3Envelope(raw: unknown): raw is VaultEnvelopeV3 {
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
  if (typeof obj["addr"] !== "string") return false;
  // Optional Phase-3 mnemonic fields — both must be present together if either is.
  const mc = obj["mnemonicCiphertext"];
  const mn = obj["mnemonicNonce"];
  if (mc !== undefined || mn !== undefined) {
    if (typeof mc !== "string") return false;
    if (typeof mn !== "string") return false;
  }
  return true;
}

async function loadVaultV3(): Promise<VaultEnvelopeV3 | null> {
  const raw = await loadRawV3();
  if (raw === null) return null;
  if (isV3Envelope(raw)) return raw;
  throw new Error("v3 vault envelope is unrecognised — refusing to read");
}

async function saveVaultV3(envelope: VaultEnvelopeV3): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VAULT_KEY_V3]: envelope }, () => resolve());
  });
}

// ---- public API ----

export async function hasVaultV3(): Promise<boolean> {
  const v = await loadVaultV3();
  return v !== null;
}

export async function getStoredAddressV3(): Promise<string | null> {
  const v = await loadVaultV3();
  return v?.addr ?? null;
}

/**
 * Whether the on-disk v3 vault carries an encrypted mnemonic (Phase 3+).
 * Lets the popup grey out "Show recovery phrase" for older vaults instead
 * of failing the user inside the re-auth flow.
 */
export async function hasStoredMnemonicV3(): Promise<boolean> {
  const v = await loadVaultV3();
  return !!(v?.mnemonicCiphertext && v?.mnemonicNonce);
}

export function isUnlockedV3(): boolean {
  return unlocked !== null;
}

export function getUnlockedAddressV3(): string | null {
  return unlocked?.address ?? null;
}

/** Lock — drop the in-memory backend reference. The backend's secret key
 * is held by the SDK in private fields; we cannot zero it deterministically,
 * but releasing the reference makes it eligible for GC. */
export function lockV3(): void {
  unlocked = null;
}

/**
 * Wipe the v3 vault from chrome.storage.local and drop the in-memory
 * backend. Used by both the password-confirmed Settings → Reset wallet
 * path and the Welcome → Forgot password? path. Caller is responsible
 * for clearing the lockout counters (`SESSION_KEY_UNLOCK_FAIL_COUNT`,
 * `_UNTIL`) and broadcasting `walletLocked` if the popup needs to
 * route — those live in the SW dispatcher.
 */
export async function wipeVaultV3(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove(VAULT_KEY_V3, () => resolve());
  });
  lockV3();
}

/**
 * Generate a fresh PQM-1 v1 24-word mnemonic and commit a v3 vault.
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
  if (await hasVaultV3()) {
    throw new Error("v3 vault already exists; cannot overwrite");
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
  if (await hasVaultV3()) {
    throw new Error("v3 vault already exists; cannot overwrite");
  }
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
  const address = await commitVaultFromSeed(password, seed, mnemonic);
  seed.fill(0);
  return { address };
}

/**
 * Compatibility path for pre-PQM-1 browser-wallet builds that exposed a raw
 * 32-byte ML-DSA-65 seed. New wallets should use createVaultFromNewMnemonic.
 */
export async function createVaultFromNewSeed(password: string): Promise<{
  seedHex: string;
  address: string;
}> {
  if (await hasVaultV3()) {
    throw new Error("v3 vault already exists; cannot overwrite");
  }
  const seed = randomBytes(SEED_LEN);
  const address = await commitVaultFromSeed(password, seed);
  const seedHex = bytesToHex(seed);
  seed.fill(0);
  return { seedHex, address };
}

/** Import from a user-supplied 32-byte seed (hex with or without 0x prefix). */
export async function createVaultFromSeedHex(
  password: string,
  seedHex: string,
): Promise<{ address: string }> {
  if (await hasVaultV3()) {
    throw new Error("v3 vault already exists; cannot overwrite");
  }
  const seed = parseSeedHex(seedHex);
  const address = await commitVaultFromSeed(password, seed);
  return { address };
}

async function commitVaultFromSeed(
  password: string,
  seed: Uint8Array,
  mnemonic?: string,
): Promise<string> {
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes`);
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
  const seedCipher = xchacha20poly1305(dek, nonce);
  const ct = seedCipher.encrypt(seed);

  // Optional mnemonic persistence — independent nonce so reusing the DEK
  // across two AEAD encryptions stays IND-CPA. Same DEK is reused since
  // it's derived from the user's password and an additional argon2id pass
  // would just duplicate work without strengthening anything.
  let mnemonicCiphertext: string | undefined;
  let mnemonicNonce: string | undefined;
  if (typeof mnemonic === "string" && mnemonic.length > 0) {
    const mnNonceBytes = randomBytes(XCHACHA_NONCE_LEN);
    const mnCipher = xchacha20poly1305(dek, mnNonceBytes);
    const mnPlain = new TextEncoder().encode(mnemonic);
    const mnCt = mnCipher.encrypt(mnPlain);
    mnemonicCiphertext = bytesToBase64(mnCt);
    mnemonicNonce = bytesToBase64(mnNonceBytes);
  }
  dek.fill(0);

  const envelope: VaultEnvelopeV3 = {
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
    addr: address,
    ...(mnemonicCiphertext && mnemonicNonce
      ? { mnemonicCiphertext, mnemonicNonce }
      : {}),
  };
  await saveVaultV3(envelope);

  unlocked = { backend, address };
  return address;
}

/**
 * Decrypt the v3 vault and load the ML-DSA-65 backend into memory.
 * Throws `"wrong password"` on AEAD failure.
 */
export async function unlockV3(password: string): Promise<{ address: string }> {
  const v = await loadVaultV3();
  if (!v) throw new Error("no v3 vault — run onboarding first");

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
  let seed: Uint8Array;
  try {
    const cipher = xchacha20poly1305(dek, nonce);
    seed = cipher.decrypt(ct);
  } catch {
    throw new Error("wrong password");
  } finally {
    dek.fill(0);
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
 * Returns `null` when the vault was created before mnemonic persistence
 * shipped (no `mnemonicCiphertext` field on the envelope). Throws
 * `"wrong password"` on AEAD failure — same shape as `unlockV3`, so
 * callers can share the lockout-counter machinery.
 *
 * The seed AEAD is decrypted first so the password check is anchored to
 * the same primary record that `unlockV3` validates.
 */
export async function exportMnemonicV3(
  password: string,
): Promise<{ mnemonic: string } | null> {
  const v = await loadVaultV3();
  if (!v) throw new Error("no v3 vault — run onboarding first");
  if (!v.mnemonicCiphertext || !v.mnemonicNonce) return null;

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
  try {
    // Verify password by decrypting the seed first; if this fails the
    // mnemonic decrypt would also fail, but anchoring to the seed keeps
    // the wrong-password signal identical to unlockV3.
    const seedCipher = xchacha20poly1305(dek, seedNonce);
    const seedPlain = seedCipher.decrypt(seedCt);
    seedPlain.fill(0);
    const mnCipher = xchacha20poly1305(dek, mnNonce);
    const mnPlain = mnCipher.decrypt(mnCt);
    const mnemonic = new TextDecoder().decode(mnPlain);
    mnPlain.fill(0);
    return { mnemonic };
  } catch {
    throw new Error("wrong password");
  } finally {
    dek.fill(0);
  }
}


/**
 * Sign + bincode-encode a Monolythium-native EVM transaction.
 * Returns the wire-ready 0x-prefixed hex string + tx hash + the raw
 * `bincode(SignedTransaction)` bytes (needed by the SDK encrypted-envelope
 * wrapper, which uses the raw bytes as the AEAD plaintext).
 */
export async function signEvmTxV3(req: {
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
  if (!unlocked) throw new Error("v3 wallet is locked");
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
export function getUnlockedPublicKeyV3(): Uint8Array | null {
  return unlocked?.backend.publicKey() ?? null;
}

/**
 * Raw 20-byte address from the unlocked backend — convenient when
 * building a `NonceAad` (which carries a `sender` byte array, not a
 * hex string). Returns null when the keystore is locked.
 */
export function getUnlockedAddressBytesV3(): Uint8Array | null {
  return unlocked?.backend.addressBytes() ?? null;
}

export function getUnlockedBackendV3(): MlDsa65Backend | null {
  return unlocked?.backend ?? null;
}

/**
 * Sign an arbitrary 32-byte digest with ML-DSA-65 — used by the
 * SDK encrypted-envelope outer signature, which signs
 * `keccak256(bincode(nonce_aad) || ciphertext || bincode(decryption_hint)
 * || sender_pubkey)`. Keeping the secret-key dereference inside this
 * module is what keeps secret-key dereferences scoped to the keystore.
 *
 * Throws `"v3 wallet is locked"` if the keystore isn't unlocked.
 */
export function signOuterDigestV3(digest: Uint8Array): Uint8Array {
  if (!unlocked) throw new Error("v3 wallet is locked");
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

function parseSeedHex(s: string): Uint8Array {
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length !== SEED_LEN * 2) {
    throw new Error(`seed hex must be ${SEED_LEN * 2} chars (got ${r.length})`);
  }
  const out = new Uint8Array(SEED_LEN);
  for (let i = 0; i < SEED_LEN; i++) {
    const byte = parseInt(r.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("seed hex has invalid characters");
    out[i] = byte;
  }
  return out;
}

export const __internalV3 = {
  isV3Envelope,
  parseSeedHex,
};
