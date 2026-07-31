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
//     addr: "0x...",                               // ADR-0038 BLAKE3 address bytes
//   }
//
// v4 strict: mnemonic fields are MANDATORY, not optional.
// Every v4 vault carries an encrypted mnemonic so Settings → Show
// recovery phrase always works. The seed-only vault-creation paths
// from earlier builds (v3) are gone; they survive transitionally as
// stub-throwing exports, slated for removal once the v3 paths are fully retired.
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
// v4-multi: a parallel storage entry under
// chrome.storage.local["mono.vaults.v4"] holds a VaultsContainerV4 —
// the multi-vault layer described in whitepaper §21.2.1 ("Power users
// wanting multiple accounts ... use the keystore format with a wallet
// that manages many keystores"). The container is master-password-
// unlocked: argon2id(password, container.masterKdf) → MEK; each vault
// holds a random VEK; MEK wraps each VEK in `wrappedKey`. To read a
// vault's seed: unwrap VEK with MEK, then HKDF-split VEK into
// seedKey + mnemonicKey, then XChaCha20-Poly1305 the existing envelope.
// No BIP-32 / BIP-44 derivation paths (whitepaper §21.2.1 forbids HD in
// v1) — each vault is an independent 24-word BIP-39 recovery phrase.
//
// Vault creation commits straight into the container ("mono.vaults.v4"):
// createVaultFromNewMnemonic / commitVaultFromSeed assemble the container
// shape and write it directly via saveVaultsContainerV4 — the legacy
// single-envelope key ("mono.vault.v4") is never written. There is no
// legacy->container migration code at HEAD: an earlier plan for a lazy
// in-unlock migration became unnecessary once creation wrote the container
// shape from the start, so no `migrateLegacyToContainerV4` function exists.
//
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import {
  MlDsa65Backend,
  generateMnemonic,
  mnemonicToMlDsa65Seed,
} from "@monolythium/core-sdk/crypto";
import {
  computeTypedDataDigest,
  hexOrUtf8ToBytes,
} from "./typed-data.js";
import type {
  MultisigSigner,
  MultisigVaultMeta,
} from "../shared/multisig.js";
import {
  assertSignerSetUnique,
  validateSignerInput,
  validateThreshold,
} from "../shared/multisig.js";
import type {
  PasskeyCredential,
  PasskeyPolicy,
  VaultPasskeyState,
} from "../shared/passkey.js";
import {
  DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
  DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
  MAX_PASSKEY_LIMIT_LYTHOSHI,
  MIN_PASSKEY_LIMIT_LYTHOSHI,
  appendCredential,
  defaultPasskeyPolicy,
  emptyVaultPasskeyState,
  removeCredential as removePasskeyCredential,
  setPolicy as setPasskeyPolicy,
} from "../shared/passkey.js";
import type { SlhDsaBackup } from "../shared/slh-dsa-backup.js";
import {
  cloneBackupForRead,
  cloneBackupForWrite,
} from "../shared/slh-dsa-backup.js";
import {
  prepareSlhDsaBackup,
  recoverBackupMnemonic,
} from "./slh-dsa-keygen.js";
import {
  SESSION_KEY_MEK_V4,
  SESSION_KEY_MEK_REHYDRATE_DEADLINE,
  SESSION_KEY_AUTO_LOCK_DEADLINE,
} from "../shared/constants.js";
import { withKeyLock } from "./storage-lock.js";

const ARGON2_M_KIB = 64 * 1024; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const SALT_LEN = 16;
const XCHACHA_NONCE_LEN = 24;
const SEED_LEN = 32;

// V5 (P1-003) = the always-AAD-bound vault seal. A stored V4 container (no-AAD)
// cannot be opened by the V5 binding; it is DETECTED (read-only, never
// decrypted) and the user restores from their recovery phrase. Testnet-clean:
// no migration / dual-open / re-seal.
const SCHEMA_VERSION = 5;
const ALGO_ID = "ml-dsa-65" as const;
const KDF_ID = "argon2id" as const;
const AEAD_ID = "xchacha20-poly1305" as const;

const SUBKEY_LEN = 32; // XChaCha20-Poly1305 expects a 256-bit key.

// ---- v4-multi container constants ----

const VAULTS_CONTAINER_KEY_V4 = "mono.vaults.v4";
const VEK_LEN = 32;
const MEK_LEN = 32;

// HKDF info labels for the multi-vault layer. Distinct from the single-
// vault `mono-seed-v4` / `mono-mnemonic-reveal-v4` labels so cross-
// version key reuse is impossible by construction: a VEK accidentally
// piped through the single-vault HKDF path (or vice versa) derives
// different bytes and decryption fails closed.
const HKDF_INFO_VAULT_SEED = new TextEncoder().encode(
  "mono-vault-seed-vmulti-v4",
);
const HKDF_INFO_VAULT_MNEMONIC = new TextEncoder().encode(
  "mono-vault-mnemonic-vmulti-v4",
);
// P5-007 — info label for the sent-address integrity HMAC sub-key. DISTINCT
// from the seed/mnemonic labels above so the integrity sub-key can never share
// derived material with the envelope keys (domain separation by construction).
const HKDF_INFO_SENT_ADDR_INTEGRITY = new TextEncoder().encode(
  "mono-sent-addr-integrity-v1",
);

interface UnlockedState {
  backend: MlDsa65Backend;
  /** Cached `0x`-prefixed address — same value MlDsa65Backend.getAddress() returns. */
  address: string;
}

let unlocked: UnlockedState | null = null;

// Cached after a successful unlockContainerV4(). Used by
// selectActiveVaultV4 / addVaultFreshV4 / addVaultImportV4 so vault
// switches and additions don't pay the ~1 second Argon2id-MEK cost
// per operation. Cleared by lockV4(). Mirrored into chrome.storage.session
// under SESSION_KEY_MEK_V4 so MV3 service-worker hibernation doesn't
// force a re-unlock — tryRestoreFromSessionV4() re-derives the active
// backend on SW boot.
let mekCache: Uint8Array | null = null;
let activeContainerVaultId: string | null = null;

// ---- Session-rehydrate ----
//
// MV3 service workers hibernate after ~30 s of inactivity. Without
// a cross-hibernation mechanism, the in-memory `unlocked` and
// `mekCache` are lost every restart and the user lands back on the
// Unlock screen — repeatedly, within minutes of "active" use, because
// any popup-close + reopen gap >30 s triggers a restart.
//
// We mirror the MEK into chrome.storage.session (in-memory only;
// cleared on browser restart; isolated to this extension's SW) for
// the lifetime of the unlocked session. On boot, `tryRestoreFromSessionV4`
// reads it back and rebuilds the backend by unwrapping the active
// vault's VEK + opening its envelope. The MEK is cleared on every
// lock (manual + auto-lock + wipe), so a fired auto-lock alarm leaves
// the SW fully relocked even if the user only reopens the popup
// afterwards.
//
// Trust boundary: the MEK in chrome.storage.session is no more
// accessible than the MEK in module memory — both are SW-scope only.
// The new exposure is "across SW restarts within the same browser
// session." That is the security tradeoff the user accepted in
// exchange for not retyping their password every popup-reopen.

// chrome.storage.session is callback-API in MV3 like its .local sibling.
// We wrap in new Promise to stay symmetric with loadRawV4 / saveRawV4,
// and to keep the test stubs (callback-shape) compatible. The session
// area is absent in non-extension contexts (some unit tests stub only
// local) — guard so a missing `.session` doesn't throw and just behaves
// as "no rehydrate available."
function sessionAreaAvailable(): boolean {
  const s = (chrome as { storage?: { session?: unknown } }).storage;
  return !!(s && s.session);
}

async function persistMekToSessionV4(mek: Uint8Array): Promise<void> {
  if (!sessionAreaAvailable()) return;
  const b64 = bytesToBase64(mek);
  return new Promise((resolve) => {
    // 2026-06-28 auto-lock overhaul: the password-less restore window is now
    // governed SOLELY by the configured auto-lock deadline
    // (SESSION_KEY_AUTO_LOCK_DEADLINE, set/slid by the SW's resetAutoLock and
    // re-armed on boot) — see tryRestoreFromSessionV4. We no longer stamp an
    // independent 5-min rehydrate cap here (it shadowed the configured timer).
    chrome.storage.session.set({ [SESSION_KEY_MEK_V4]: b64 }, () => resolve());
  });
}

async function clearMekFromSessionV4(): Promise<void> {
  if (!sessionAreaAvailable()) return;
  return new Promise((resolve) => {
    chrome.storage.session.remove(
      [SESSION_KEY_MEK_V4, SESSION_KEY_MEK_REHYDRATE_DEADLINE],
      () => resolve(),
    );
  });
}

/** 2026-06-28 auto-lock overhaul: the configured auto-lock deadline
 *  (SESSION_KEY_AUTO_LOCK_DEADLINE, set/slid by the SW's resetAutoLock and
 *  re-armed on boot) is the SINGLE authority for the password-less session-MEK
 *  restore window — replacing the former independent 5-min cap that shadowed the
 *  configured timer. Returns true when the deadline is ABSENT or has PASSED, i.e.
 *  the restore must be refused + the session MEK wiped. FAIL-CLOSED: a missing
 *  deadline is treated as expired (no restore on a missing bound). */
async function autoLockDeadlinePassedOrAbsentV4(): Promise<boolean> {
  if (!sessionAreaAvailable()) return true;
  const deadline = await new Promise<unknown>((resolve) => {
    chrome.storage.session.get([SESSION_KEY_AUTO_LOCK_DEADLINE], (res) => {
      resolve(res?.[SESSION_KEY_AUTO_LOCK_DEADLINE] ?? null);
    });
  });
  if (typeof deadline !== "number") return true;
  return Date.now() >= deadline;
}

async function loadMekFromSessionV4(): Promise<Uint8Array | null> {
  if (!sessionAreaAvailable()) return null;
  const b64 = await new Promise<unknown>((resolve) => {
    chrome.storage.session.get([SESSION_KEY_MEK_V4], (res) => {
      resolve(res?.[SESSION_KEY_MEK_V4] ?? null);
    });
  });
  if (typeof b64 !== "string") return null;
  try {
    const bytes = base64ToBytes(b64);
    if (bytes.length !== MEK_LEN) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Attempt to rebuild the unlocked state from the session-cached MEK.
 *  Returns `{ ok: true, address }` on success and leaves the module
 *  state populated as if `unlockContainerV4` had just succeeded.
 *  Returns `{ ok: false }` if no MEK is cached, the container is
 *  missing, or the AEAD unwrap fails (which should be impossible
 *  given the MEK is the one that wrapped it — defensive only).
 *  Idempotent: if already unlocked, returns the live address. */
export async function tryRestoreFromSessionV4(): Promise<
  { ok: true; address: string; vaultId: string } | { ok: false }
> {
  if (unlocked && activeContainerVaultId) {
    return { ok: true, address: unlocked.address, vaultId: activeContainerVaultId };
  }
  const mek = await loadMekFromSessionV4();
  if (!mek) return { ok: false };
  // 2026-06-28 auto-lock overhaul: the configured auto-lock deadline is the
  // SINGLE authority for the password-less restore window. Refuse + wipe when it
  // is absent or has passed, so the wallet stays locked until a fresh password
  // unlock. tryRestoreFromSessionV4 enforces this ITSELF (fail-closed) so it can
  // never restore past the deadline even if a caller forgets to gate — both
  // production callers (boot rehydrate, ensureUnlockRestored) also pre-gate on
  // the same key, so this is idempotent for them.
  if (await autoLockDeadlinePassedOrAbsentV4()) {
    mek.fill(0);
    await clearMekFromSessionV4();
    return { ok: false };
  }
  const container = await loadVaultsContainerV4();
  if (!container) {
    mek.fill(0);
    await clearMekFromSessionV4();
    return { ok: false };
  }
  const active = container.vaults.find((v) => v.id === container.activeVaultId);
  if (!active) {
    mek.fill(0);
    await clearMekFromSessionV4();
    return { ok: false };
  }
  let state: UnlockedState;
  try {
    state = await loadVaultBackend(mek, active);
  } catch {
    mek.fill(0);
    await clearMekFromSessionV4();
    return { ok: false };
  }
  if (mekCache) mekCache.fill(0);
  mekCache = mek;
  // S1-01 (defensive): `unlocked` is null here in normal flow — the
  // early-return guard at the top returns first when a live session exists.
  // Upholds the no-abandoned-secret invariant.
  const prev = unlocked;
  unlocked = state;
  activeContainerVaultId = active.id;
  prev?.backend.dispose();
  return { ok: true, address: state.address, vaultId: active.id };
}

// ---- v4-multi container types ----

/** Argon2id parameters for the master encryption key. One set per
 *  container, shared across all vaults — the same MEK unwraps every
 *  vault's wrappedKey. */
interface MasterKdfParamsV4 {
  kdf: typeof KDF_ID;
  m: number;
  t: number;
  p: number;
  salt: string; // base64, 16 bytes
}

/** Per-vault encryption key (32 bytes) wrapped under the MEK. */
interface WrappedVekV4 {
  aead: typeof AEAD_ID;
  nonce: string; // base64, 24 bytes
  ciphertext: string; // base64, 32-byte VEK + 16-byte Poly1305 tag
}

/** Seed + mnemonic envelope sealed by the per-vault VEK.
 *  HKDF-SHA-256 splits the VEK into seedKey + mnemonicKey via the same
 *  schema-bound info labels used elsewhere in this module (rotated to
 *  `*-vmulti-v4` to keep the multi-vault layer cryptographically
 *  isolated from the legacy single-vault layer). No per-vault KDF
 *  section — the VEK is already 32 bytes of high-entropy random. */
interface SealedSeedRecordV4 {
  seedNonce: string; // base64, 24 bytes
  seedCiphertext: string; // base64
  mnemonicNonce: string; // base64, 24 bytes
  mnemonicCiphertext: string; // base64
}

/** One vault inside a VaultsContainerV4. The label is user-editable
 *  (the rename UI is wired separately); createdAt anchors stable
 *  ordering when the container is rendered.
 *
 *  The `kind` discriminant was added later. `"single"` is the legacy
 *  shape — one mnemonic, one ML-DSA-65 keypair, one address. Vault
 *  records persisted before the discriminant existed carry no `kind` field on disk and
 *  are treated as `"single"` by every read path. `"multisig"` records
 *  reuse the same wrappedKey + envelope (the multisig vault has its
 *  own ML-DSA-65 keypair that submits executed proposals on-chain)
 *  and additionally carry the M-of-N committee + proposal queues in
 *  `multisig`. */
interface VaultRecordV4 {
  id: string; // crypto.randomUUID()
  label: string; // default "Vault N", user-editable
  createdAt: number; // Date.now() at creation
  wrappedKey: WrappedVekV4;
  envelope: SealedSeedRecordV4;
  addr: string; // 0x..., cached for locked-state display
  /** Vault kind. Optional on disk for backward compat — absence
   *  means `"single"`. */
  kind?: "single" | "multisig";
  /** M-of-N committee + proposal queues for `kind === "multisig"`.
   *  Must be present on multisig records, absent on single records. */
  multisig?: MultisigVaultMeta;
  /** Optional per-vault passkey state. Absent on legacy
   *  vaults and on vaults that haven't run passkey registration; read
   *  paths treat absence as "no passkey configured" (policy disabled,
   *  no credentials). The actual WebAuthn key material lives in the
   *  browser's authenticator; the wallet only stores credential IDs +
   *  user-edited names + policy thresholds. See `shared/passkey.ts`
   *  for the rationale and the on-chain GAP analysis. */
  passkey?: VaultPasskeyState;
  /** Optional per-vault SLH-DSA emergency backup record.
   *  Absent on every vault until the user opts into the §30.1 flow.
   *  Read paths treat absence as "not set up". When present, the
   *  encrypted secret-key material is XChaCha20-Poly1305-sealed under
   *  the SAME VEK that protects the primary ML-DSA-65 envelope — the
   *  cold-storage backup the user wrote down is what they recover
   *  from in a G3 emergency, NOT this on-disk copy. See
   *  `shared/slh-dsa-backup.ts` for the rationale + chain-GAP
   *  analysis + parameter-set choice (`slh_dsa_sha2_128s` algo id
   *  `1101`, the only currently-chain-eligible backup variant per
   *  Whitepaper §2.9). */
  slhDsaBackup?: SlhDsaBackup;
}

/** Multi-vault container. Stored under
 *  chrome.storage.local["mono.vaults.v4"]. */
interface VaultsContainerV4 {
  version: 5;
  algo: typeof ALGO_ID;
  kdf: typeof KDF_ID;
  aead: typeof AEAD_ID;
  masterKdf: MasterKdfParamsV4;
  vaults: VaultRecordV4[];
  activeVaultId: string;
}

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


// ---- v4-multi crypto helpers ----

/** Canonical additional-authenticated-data for the V5 vault seal (P1-003).
 *  Binds every per-vault ciphertext to (format tag | schema version | algo |
 *  aead | vaultId), so a ciphertext cannot be lifted into a different vault:
 *  opening a record under the wrong vaultId fails the AEAD tag check.
 *  Deterministic, fixed-order, length-prefixed (every field < 256 bytes → a
 *  1-byte length). Seal + open build identical bytes from the record id. */
function buildVaultAadV4(vaultId: string): Uint8Array {
  const enc = new TextEncoder();
  const tag = enc.encode("mono.vault.aad.v1");
  const algo = enc.encode(ALGO_ID);
  const aead = enc.encode(AEAD_ID);
  const id = enc.encode(vaultId);
  if (id.length > 255) throw new Error("buildVaultAadV4: vaultId too long");
  const out = new Uint8Array(
    tag.length + 1 + (1 + algo.length) + (1 + aead.length) + (1 + id.length),
  );
  let o = 0;
  out.set(tag, o);
  o += tag.length;
  out[o++] = SCHEMA_VERSION & 0xff;
  out[o++] = algo.length;
  out.set(algo, o);
  o += algo.length;
  out[o++] = aead.length;
  out.set(aead, o);
  o += aead.length;
  out[o++] = id.length;
  out.set(id, o);
  return out;
}

/** Fresh argon2id parameters for a new container. Reuses the same
 *  cost knobs the single-vault layer uses (64 MiB / t=3 / p=1) so the
 *  unlock-time round-trip is comparable. */
function generateMasterKdfParamsV4(): MasterKdfParamsV4 {
  return {
    kdf: KDF_ID,
    m: ARGON2_M_KIB,
    t: ARGON2_T,
    p: ARGON2_P,
    salt: bytesToBase64(randomBytes(SALT_LEN)),
  };
}

async function deriveMekV4(
  password: string,
  params: MasterKdfParamsV4,
): Promise<Uint8Array> {
  return argon2idAsync(
    new TextEncoder().encode(password),
    base64ToBytes(params.salt),
    { m: params.m, t: params.t, p: params.p, dkLen: MEK_LEN },
  );
}

function generateVekV4(): Uint8Array {
  return randomBytes(VEK_LEN);
}

/** Encrypt a VEK under the MEK with XChaCha20-Poly1305. Fresh random
 *  nonce per wrap. Caller owns MEK + VEK lifetimes — this helper does
 *  not zero its inputs. */
function wrapVekV4(
  mek: Uint8Array,
  vek: Uint8Array,
  vaultId: string,
): WrappedVekV4 {
  if (mek.length !== MEK_LEN) throw new Error("wrapVekV4: bad MEK length");
  if (vek.length !== VEK_LEN) throw new Error("wrapVekV4: bad VEK length");
  const nonce = randomBytes(XCHACHA_NONCE_LEN);
  const cipher = xchacha20poly1305(mek, nonce, buildVaultAadV4(vaultId));
  const ct = cipher.encrypt(vek);
  return {
    aead: AEAD_ID,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ct),
  };
}

/** Decrypt the VEK using the MEK. Throws on AEAD failure (wrong MEK or
 *  tampered ciphertext) without leaking timing about which. Returned
 *  VEK is a fresh 32-byte buffer; caller MUST zero it after use. */
function unwrapVekV4(
  mek: Uint8Array,
  wrapped: WrappedVekV4,
  vaultId: string,
): Uint8Array {
  if (mek.length !== MEK_LEN) throw new Error("unwrapVekV4: bad MEK length");
  if (wrapped.aead !== AEAD_ID) {
    throw new Error(`unwrapVekV4: unexpected AEAD ${wrapped.aead}`);
  }
  const nonce = base64ToBytes(wrapped.nonce);
  const ct = base64ToBytes(wrapped.ciphertext);
  const cipher = xchacha20poly1305(mek, nonce, buildVaultAadV4(vaultId));
  const vek = cipher.decrypt(ct);
  if (vek.length !== VEK_LEN) {
    vek.fill(0);
    throw new Error("unwrapVekV4: unwrapped VEK has wrong length");
  }
  return vek;
}

/** Split a VEK into seedKey + mnemonicKey using HKDF-SHA-256 with the
 *  multi-vault info labels. Mirrors `deriveSubKeys` for the single-
 *  vault DEK but uses distinct labels so the two layers cannot
 *  accidentally share derived material. */
function deriveSubKeysFromVekV4(vek: Uint8Array): {
  seedKey: Uint8Array;
  mnemonicKey: Uint8Array;
} {
  const seedKey = hkdf(sha256, vek, undefined, HKDF_INFO_VAULT_SEED, SUBKEY_LEN);
  const mnemonicKey = hkdf(
    sha256,
    vek,
    undefined,
    HKDF_INFO_VAULT_MNEMONIC,
    SUBKEY_LEN,
  );
  return { seedKey, mnemonicKey };
}

/** P5-007 — derive the sent-address-integrity sub-key from the in-session MEK.
 *  Domain-separated from the seed/mnemonic sub-keys so it can never collide.
 *  Returns null when the container is locked (no MEK) → callers fail safe. The
 *  caller MUST zero the returned key after use. */
function deriveSentAddrIntegrityKeyV4(): Uint8Array | null {
  if (!mekCache) return null;
  return hkdf(sha256, mekCache, undefined, HKDF_INFO_SENT_ADDR_INTEGRITY, SUBKEY_LEN);
}

/** P5-007 — compute the wallet HMAC integrity tag (hex) for a canonical
 *  sent-address message (see `canonicalSentAddrMessage`). Returns null when the
 *  container is locked. The MEK-derived sub-key never leaves this module and is
 *  zeroed after use. Advisory-only: the tag gates a phishing-friction warning,
 *  never a send. */
export function computeSentAddrTagV4(message: string): string | null {
  const subKey = deriveSentAddrIntegrityKeyV4();
  if (!subKey) return null;
  try {
    return bytesToHex(hmac(sha256, subKey, new TextEncoder().encode(message)));
  } finally {
    subKey.fill(0);
  }
}

/** P5-007 — verify a stored tag against a freshly recomputed one in CONSTANT
 *  TIME. Returns false when the container is locked, when the stored tag isn't a
 *  well-formed hex MAC of the right length, or on any mismatch. Never throws. */
export function verifySentAddrTagV4(message: string, tagHex: string): boolean {
  const subKey = deriveSentAddrIntegrityKeyV4();
  if (!subKey) return false;
  try {
    const expected = hmac(sha256, subKey, new TextEncoder().encode(message));
    let provided: Uint8Array;
    try {
      provided = hexToBytes(tagHex);
    } catch {
      return false;
    }
    if (provided.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= (expected[i] ?? 0) ^ (provided[i] ?? 0);
    }
    return diff === 0;
  } finally {
    subKey.fill(0);
  }
}

/** Encrypt seed + mnemonic under a VEK. Each side gets a fresh nonce
 *  and its own HKDF sub-key. Inputs are not zeroed by this helper. */
function sealVaultEnvelopeV4(
  vek: Uint8Array,
  seed: Uint8Array,
  mnemonic: string,
  vaultId: string,
): SealedSeedRecordV4 {
  if (seed.length !== SEED_LEN) {
    throw new Error(`sealVaultEnvelopeV4: seed must be ${SEED_LEN} bytes`);
  }
  if (mnemonic.length === 0) {
    throw new Error("sealVaultEnvelopeV4: mnemonic must be non-empty");
  }
  const aad = buildVaultAadV4(vaultId);
  const { seedKey, mnemonicKey } = deriveSubKeysFromVekV4(vek);
  let mnPlain: Uint8Array | null = null;
  try {
    const seedNonce = randomBytes(XCHACHA_NONCE_LEN);
    const seedCt = xchacha20poly1305(seedKey, seedNonce, aad).encrypt(seed);
    const mnNonce = randomBytes(XCHACHA_NONCE_LEN);
    mnPlain = new TextEncoder().encode(mnemonic);
    const mnCt = xchacha20poly1305(mnemonicKey, mnNonce, aad).encrypt(mnPlain);
    return {
      seedNonce: bytesToBase64(seedNonce),
      seedCiphertext: bytesToBase64(seedCt),
      mnemonicNonce: bytesToBase64(mnNonce),
      mnemonicCiphertext: bytesToBase64(mnCt),
    };
  } finally {
    // P2-005 — zero the mnemonic plaintext on EVERY exit, including an
    // encrypt() throw (it was zeroed only on the happy path, leaving the UTF-8
    // mnemonic bytes live in the heap on failure).
    if (mnPlain) mnPlain.fill(0);
    seedKey.fill(0);
    mnemonicKey.fill(0);
  }
}

/** Decrypt seed + mnemonic from a sealed envelope using the VEK.
 *  Throws "wrong password" on AEAD failure to match the legacy
 *  contract; the same error message is what the unlock path surfaces.
 *  Returns fresh buffers — caller MUST zero the seed after use. */
function openVaultEnvelopeV4(
  vek: Uint8Array,
  env: SealedSeedRecordV4,
  vaultId: string,
): { seed: Uint8Array; mnemonic: string } {
  const aad = buildVaultAadV4(vaultId);
  const { seedKey, mnemonicKey } = deriveSubKeysFromVekV4(vek);
  try {
    const seedNonce = base64ToBytes(env.seedNonce);
    const seedCt = base64ToBytes(env.seedCiphertext);
    const mnNonce = base64ToBytes(env.mnemonicNonce);
    const mnCt = base64ToBytes(env.mnemonicCiphertext);
    let seed: Uint8Array;
    let mnPlain: Uint8Array;
    try {
      seed = xchacha20poly1305(seedKey, seedNonce, aad).decrypt(seedCt);
      mnPlain = xchacha20poly1305(mnemonicKey, mnNonce, aad).decrypt(mnCt);
    } catch {
      throw new Error("wrong password");
    }
    if (seed.length !== SEED_LEN) {
      seed.fill(0);
      mnPlain.fill(0);
      throw new Error(`openVaultEnvelopeV4: seed must be ${SEED_LEN} bytes`);
    }
    const mnemonic = new TextDecoder().decode(mnPlain);
    mnPlain.fill(0);
    return { seed, mnemonic };
  } finally {
    seedKey.fill(0);
    mnemonicKey.fill(0);
  }
}

// ---- v4-multi container storage ----

function isVaultsContainerV4(raw: unknown): raw is VaultsContainerV4 {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== SCHEMA_VERSION) return false;
  if (obj["algo"] !== ALGO_ID) return false;
  if (obj["kdf"] !== KDF_ID) return false;
  if (obj["aead"] !== AEAD_ID) return false;
  const mk = obj["masterKdf"] as Record<string, unknown> | undefined;
  if (!mk || typeof mk !== "object") return false;
  if (mk["kdf"] !== KDF_ID) return false;
  // P1-002 — refuse out-of-band argon2id params. Integrity/DoS only (the params
  // are AEAD-bound, NOT a confidentiality path): the m-cap stops a tampered
  // container from driving argon2id into an OOM at unlock, and the floors stop a
  // trivially-weak KDF (e.g. m:1) from being read. Bands: m ∈ [64 MiB, 1 GiB]
  // KiB, t ∈ [2, 10], p ∈ [1, 4]; the create-default (64 MiB / t3 / p1) is in-band.
  const m = mk["m"];
  const t = mk["t"];
  const p = mk["p"];
  if (typeof m !== "number" || !Number.isInteger(m) || m < 65536 || m > 1048576) {
    return false;
  }
  if (typeof t !== "number" || !Number.isInteger(t) || t < 2 || t > 10) {
    return false;
  }
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 4) {
    return false;
  }
  if (typeof mk["salt"] !== "string") return false;
  const vaults = obj["vaults"];
  if (!Array.isArray(vaults)) return false;
  if (typeof obj["activeVaultId"] !== "string") return false;
  // We trust the per-vault structure rather than deep-validating every
  // record here — the unlock path's AEAD failure produces a fail-closed
  // "wrong password" if the envelope is malformed.
  return true;
}

async function loadVaultsContainerV4(): Promise<VaultsContainerV4 | null> {
  const raw = await new Promise<unknown>((resolve) => {
    chrome.storage.local.get([VAULTS_CONTAINER_KEY_V4], (res) => {
      resolve(res?.[VAULTS_CONTAINER_KEY_V4] ?? null);
    });
  });
  if (raw === null) return null;
  if (!isVaultsContainerV4(raw)) {
    // P1-003: a pre-V5 container (no-AAD seal) can't be opened by the V5 AAD
    // binding. Treat it as "no usable container" (graceful — boot stays alive);
    // `storedContainerNeedsRestoreV4` drives the restore-from-phrase UX. This
    // NEVER decrypts the V4 blob — a version check only. Truly unrecognised
    // data still throws fail-closed.
    const ver = (raw as { version?: unknown }).version;
    if (typeof ver === "number" && ver < SCHEMA_VERSION) return null;
    throw new Error("v4 vaults container is unrecognised — refusing to read");
  }
  // Normalise the per-vault passkey state back to the
  // in-memory (bigint-typed) shape. On disk the passkey policy is
  // stored as decimal strings (see `passkeyStateForStorage`); rest of
  // the code expects bigints. `clonePasskeyState` tolerates either
  // shape and fills in defaults when fields are missing entirely,
  // which also covers the (real-Chrome-observed) case where bigints
  // round-tripped through `chrome.storage.local.set` and came back
  // as `undefined`.
  return {
    ...raw,
    vaults: raw.vaults.map((v) => {
      // passkey BigInt normalisation
      let out = v.passkey
        ? { ...v, passkey: clonePasskeyState(v.passkey) }
        : v;
      // SLH-DSA backup defensive read. The on-disk shape
      // is already plain JSON (no BigInts to recover), but pushing
      // every read through `cloneBackupForRead` strips unknown fields
      // + fails closed on a corrupt record (returns `null`, which
      // the read paths treat as "no backup configured"). The same
      // defence-in-depth posture as the passkey path.
      if (out.slhDsaBackup) {
        const restored = cloneBackupForRead(out.slhDsaBackup);
        if (restored !== null) {
          out = { ...out, slhDsaBackup: restored };
        } else {
          // Corrupt record — drop the field rather than carry a
          // broken shape forward. The next write rehydrates a
          // clean record.
          const { slhDsaBackup: _drop, ...withoutBackup } = out;
          out = withoutBackup;
        }
      }
      return out;
    }),
  };
}

/** Read-only: is there a stored container that predates V5 (the always-AAD
 *  seal)? Such a container can't be opened by the V5 binding — the user must
 *  restore from their recovery phrase. DETECTION ONLY: reads the raw `version`
 *  field; NEVER decrypts the V4 blob. Used by the unlock + status IPC to show
 *  a clear "restore from your recovery phrase" instead of a wrong-password. */
export async function storedContainerNeedsRestoreV4(): Promise<boolean> {
  const raw = await new Promise<unknown>((resolve) => {
    chrome.storage.local.get([VAULTS_CONTAINER_KEY_V4], (res) => {
      resolve(res?.[VAULTS_CONTAINER_KEY_V4] ?? null);
    });
  });
  if (!raw || typeof raw !== "object") return false;
  const ver = (raw as { version?: unknown }).version;
  return typeof ver === "number" && ver < SCHEMA_VERSION;
}

/**
 * The container-write invariant (H1).
 *
 * THE RULE: every mutation of the vaults container runs inside
 * `withKeyLock(VAULTS_CONTAINER_KEY_V4, …)`, and the container is re-read with
 * `loadVaultsContainerV4()` INSIDE that lock. Acting on a snapshot taken before
 * acquiring reintroduces the original defect with extra steps: the container is
 * persisted as one blob, so a writer holding a stale snapshot overwrites
 * whatever landed in between. When both writers touch the vault ARRAY —
 * `removeVaultV4` and `appendVaultRecord` — what is overwritten is a vault
 * record, destroying its wrapped VEK and sealed seed envelope for an address
 * that stays funded on-chain.
 *
 * WHY THE LOCK IS AROUND THE STORAGE ROUND TRIPS, not around the KDF: the
 * exposure is the genuine macrotask yields — the `chrome.storage.local` get and
 * set, and a vault-backend load. It is NOT the Argon2id derivation, which
 * yields only to microtasks (`@noble/hashes` `nextTick` is an empty async
 * function) and so never returns control to the host. A lock scoped to the
 * derivation would be scoped to the wrong thing.
 *
 * WHY DERIVING OUTSIDE THE LOCK IS SAFE: `removeVaultV4` and
 * `commitVaultFromSeed` derive before acquiring. That is licensed by
 * `masterKdf` being immutable — it is written once, into the fresh-container
 * literal in `commitVaultFromSeed`, and no writer mutates it thereafter. Holding
 * the lock across a ~1 s derivation would queue every other container op behind
 * it. Nothing else read before the lock may be acted upon.
 *
 * ENROLMENT AT THE TIME OF WRITING: all fifteen writers in this module, plus
 * `wipeAllLocalWalletState` in the service worker, which removes the container
 * by `mono.`-prefix scan rather than through this helper and therefore takes the
 * same lock via `vaultContainerLockKey()`.
 *
 * WHAT IS NOT ENFORCED — read this before adding a sixteenth writer. Two gaps,
 * and the second was previously described here as closed when it is not:
 *
 *   1. Nothing stops a NEW writer inside this module from calling this helper
 *      without taking the lock, or from taking the lock and then persisting a
 *      snapshot read BEFORE it. The second is the dangerous one: it looks
 *      correct in review, because the lock is visibly present.
 *
 *   2. This function is NOT private to the module. It is re-exported on
 *      `__internalV4Multi` at the foot of this file, so any module can import it
 *      and write the container unlocked. An earlier version of this note claimed
 *      the opposite — "confined to this one non-exported function, so no code
 *      outside the module can write the container". That was false. Today only
 *      `keystore-mldsa.test.ts` imports it, so nothing exploits the gap, but the
 *      door is ajar rather than shut.
 *
 * Closing either one needs every call site to go through a primitive that owns
 * the lock, the read and the write — deferred, not done. Until then, the rule
 * above is what keeps the container consistent, and this note claims no more
 * than that.
 */
async function saveVaultsContainerV4(
  container: VaultsContainerV4,
): Promise<void> {
  // chrome.storage.local doesn't reliably preserve
  // BigInt values across the persistence boundary — on some Chrome
  // versions the bigint fields get stripped silently, leaving e.g.
  // `policy.limitWei: undefined` on the next read, which then crashes
  // any downstream `.toString()` call. Project the per-vault passkey
  // state down to a JSON-safe shape (bigints → decimal strings) just
  // before the actual `set`. The in-memory `container` is unchanged
  // so callers that hold a reference still see the rich shape.
  const persistable = {
    ...container,
    vaults: container.vaults.map((v) =>
      v.passkey
        ? { ...v, passkey: passkeyStateForStorage(v.passkey) }
        : v,
    ),
  };
  // DA-002 — `chrome.storage.local.set` reports failure (quota exhaustion, I/O,
  // a corrupt profile) by setting `chrome.runtime.lastError` INSIDE the
  // callback: it does not throw and it does not reject. Resolving
  // unconditionally therefore reported every failed container write as a
  // success, which made each caller's "the write landed" reasoning vacuous —
  // including `removeVaultV4`'s rollback, whose catch could never fire.
  // Reject instead, so those paths become live.
  //
  // `chrome.runtime` is always present in an MV3 service worker; the optional
  // read only keeps this callable from a test stub that installs `storage`
  // alone. An absent `runtime` is treated as "no error", which matches the
  // real platform where its absence is impossible.
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(
      { [VAULTS_CONTAINER_KEY_V4]: persistable },
      () => {
        const err = (
          chrome.runtime as { lastError?: { message?: string } } | undefined
        )?.lastError;
        if (err) {
          reject(
            new Error(
              `failed to persist the vault container: ${err.message ?? "unknown storage error"}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Rejects a callback that hands the container back.
 *
 * `mutateContainer` PERSISTS THE CONTAINER IT READ — never a value the callback
 * returns. So returning it is already pointless; the reason to make it a type
 * error is what it would mean if it were ever honoured. A primitive that saved
 * what it was given would accept a snapshot read BEFORE the lock, which is
 * exactly the clobber this arrangement exists to prevent. Keeping that API shape
 * unreachable stops it being reintroduced as a "simplification".
 *
 * The error surfaces where the result is USED; the branded name is the
 * explanation a future reader gets.
 */
type ContainerMutationResult<T> = T extends VaultsContainerV4
  ? {
      readonly __invalid: "a mutateContainer callback must not return the container; the primitive persists the one it read";
    }
  : T;

/**
 * Read-modify-write the vaults container under its lock.
 *
 * OWNS the lock, the read, the not-found refusal, and the write. The callback
 * receives a container read INSIDE the lock and mutates it in place; whatever it
 * returns becomes the caller's result and is never persisted.
 *
 * A caller may still read the container before the lock — `removeVaultV4` and
 * `updatePasskeyCredentialSignCountV4` both do, as optimisations — and that stays
 * safe, because a pre-lock copy has no route to storage: this writes the object
 * it read, and there is no parameter through which another could be supplied.
 *
 * ALWAYS WRITES. A callback that decides there is nothing to do still causes a
 * write of the unchanged container, and the popup watches this key
 * (`App.tsx`'s container-change listener refreshes keystore state). A mutator
 * whose common case is "no change" must therefore pre-check BEFORE calling this,
 * not return early from inside it.
 */
async function mutateContainer<T>(
  fn: (container: VaultsContainerV4) => T | Promise<T>,
): Promise<ContainerMutationResult<T>> {
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) throw new Error("no v4 vaults container");
    const result = await fn(container);
    // The container THIS call read. Not an argument, not a return value.
    await saveVaultsContainerV4(container);
    return result as ContainerMutationResult<T>;
  });
}

// ---- v4-multi public API ----

/** Summary projection over a VaultRecordV4 — what the popup needs to
 *  render the vault picker. Excludes the wrappedKey / envelope (key
 *  material stays inside the keystore).
 *
 *  The multisig fields (`kind`, `signerCount`,
 *  `threshold`, `pendingCount`) so the picker can render a multisig
 *  badge + "M-of-N · K pending" without a second IPC roundtrip. The
 *  full signer roster + proposal queue is read separately via the
 *  multisig-meta IPC handlers — those carry sensitive(-ish) data and
 *  the list-vaults call should stay cheap. */
export interface VaultSummaryV4 {
  id: string;
  label: string;
  addr: string;
  createdAt: number;
  isActive: boolean;
  /** "single" for legacy + freshly-created single-key vaults;
   *  "multisig" for vaults created via {@link addVaultMultisigV4}. */
  kind: "single" | "multisig";
  /** Number of signers (multisig only; 0 for single). */
  signerCount: number;
  /** M in M-of-N (multisig only; 0 for single). */
  threshold: number;
  /** Pending proposal count — tx proposals + governance proposals
   *  that are still in the `pending` status (multisig only; 0 for
   *  single). The popup surfaces this in the home pill. */
  pendingCount: number;
}

export async function hasContainerV4(): Promise<boolean> {
  return (await loadVaultsContainerV4()) !== null;
}

/**
 * The `withKeyLock` key that serialises every vault-container mutation.
 *
 * Exported ONLY so the wallet-state wipe can take the same lock. That wipe
 * removes the container by scanning for the `mono.` prefix rather than going
 * through `saveVaultsContainerV4`, so it is the one container mutation the
 * "route every write through the locked helper" invariant cannot catch on its
 * own — without this it could delete the container out from under an in-flight
 * writer, or be overwritten by one.
 *
 * Deliberately a key accessor and NOT a setter: callers can serialise against
 * the container, but cannot write it. The only way to change the container's
 * contents remains the locked writers in this module.
 */
export function vaultContainerLockKey(): string {
  return VAULTS_CONTAINER_KEY_V4;
}

/** Internal: unwrap a vault's VEK, open its envelope, build the
 *  backend, return the unlocked-state record. Used by both
 *  {@link unlockContainerV4} and {@link selectActiveVaultV4} — both
 *  paths share the same "unwrap → open → instantiate" pipeline. */
async function loadVaultBackend(
  mek: Uint8Array,
  vault: VaultRecordV4,
): Promise<UnlockedState> {
  const vek = unwrapVekV4(mek, vault.wrappedKey, vault.id);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, vault.envelope, vault.id);
    seed = opened.seed;
    // mnemonic not needed for backend instantiation; let it fall out of scope.
  } finally {
    vek.fill(0);
  }
  const backend = MlDsa65Backend.fromSeed(seed);
  const address = await backend.getAddress();
  seed.fill(0);
  return { backend, address };
}

/**
 * Container-aware unlock. Derives the MEK from the master password,
 * unwraps the active vault's VEK, opens the envelope, and loads the
 * backend.
 *
 * Throws `"wrong password"` on AEAD failure at any step; the
 * dispatcher's rate-limit handling applies identically.
 *
 * Caches the derived MEK in module state for the unlock session so
 * subsequent {@link selectActiveVaultV4} / {@link addVaultFreshV4} /
 * {@link addVaultImportV4} calls skip Argon2id.
 */
export async function unlockContainerV4(
  password: string,
): Promise<{ address: string; vaultId: string }> {
  const container = await loadVaultsContainerV4();
  if (!container) {
    throw new Error("no v4 vault — run onboarding first");
  }

  const mek = await deriveMekV4(password, container.masterKdf);
  const active = container.vaults.find(
    (v) => v.id === container!.activeVaultId,
  );
  if (!active) {
    mek.fill(0);
    throw new Error("container is missing its active vault");
  }

  let state: UnlockedState;
  try {
    state = await loadVaultBackend(mek, active);
  } catch (e) {
    mek.fill(0);
    throw e; // "wrong password" surfaces here on legitimate AEAD failure
  }

  // Successful unlock — replace cached state.
  if (mekCache) mekCache.fill(0);
  mekCache = mek;
  // S1-01 (defensive): no-op in the normal locked→unlock flow (`unlocked` is
  // null after lockV4). Upholds the no-abandoned-secret invariant if unlock is
  // ever reached while a session is already live.
  const prev = unlocked;
  unlocked = state;
  activeContainerVaultId = active.id;
  prev?.backend.dispose();
  // Mirror MEK to chrome.storage.session so MV3 SW hibernation doesn't
  // force a re-unlock. See `tryRestoreFromSessionV4` for the boot-side
  // read path. SW awaits this before the rate-limit counters get
  // cleared so a crash mid-set still leaves us in a coherent state
  // (cached MEK + zero fail count, or no cached MEK + the previous
  // fail count — never the mismatched in-between).
  await persistMekToSessionV4(mek);
  return { address: state.address, vaultId: active.id };
}

/** Switch the active vault using the cached MEK. Requires the
 *  container to be unlocked (i.e., MEK cached by a prior
 *  {@link unlockContainerV4}). Updates `container.activeVaultId` on
 *  disk and swaps the in-memory backend. The dispatcher broadcasts
 *  `accountsChanged` after this returns. */
export async function selectActiveVaultV4(
  vaultId: string,
): Promise<{ address: string }> {
  if (!mekCache) throw new Error("container is locked");
  const mek = mekCache;
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const target = container.vaults.find((v) => v.id === vaultId);
  if (!target) throw new Error("unknown vault id");
  // No-op fast path: already the active vault.
  if (vaultId === activeContainerVaultId && unlocked) {
    return { address: unlocked.address };
  }
  const state = await loadVaultBackend(mek, target);
  container.activeVaultId = vaultId;
  try {
    await saveVaultsContainerV4(container);
  } catch (e) {
    // DA-002 made this path reachable. The incoming backend never becomes the
    // session, so dispose its decrypted ML-DSA-65 secret rather than leaving it
    // for GC — the same discipline removeVaultV4 applies to its speculative
    // successor. `unlocked` is untouched, so the outgoing vault stays live.
    state.backend.dispose();
    throw e;
  }
  // S1-01: deterministically wipe the OUTGOING vault's ML-DSA-65 secret once
  // the new backend is installed, instead of leaving it for GC. `prev` is the
  // abandoned instance; `state.backend` (now `unlocked`) is never the target.
  const prev = unlocked;
  unlocked = state;
  activeContainerVaultId = vaultId;
  prev?.backend.dispose();
  return { address: state.address };
  });
}

/** Read-only list of vault summaries. No unlock required — labels and
 *  addresses are non-sensitive metadata. Returns `null` when no
 *  container exists (so the popup can branch on "still single-vault
 *  legacy" during the migration window).
 *
 *  The multisig summary fields are populated from the
 *  per-vault `multisig` block. Pending count counts both tx and
 *  governance proposals in `pending` status (the popup surfaces a
 *  combined number; the per-page views render the two queues
 *  separately). */
export async function listVaultsV4(): Promise<VaultSummaryV4[] | null> {
  const container = await loadVaultsContainerV4();
  if (!container) return null;
  return container.vaults.map((v) => summarizeVault(v, container.activeVaultId));
}

function summarizeVault(
  v: VaultRecordV4,
  activeVaultId: string,
): VaultSummaryV4 {
  const kind = v.kind === "multisig" ? "multisig" : "single";
  const m = kind === "multisig" ? v.multisig : undefined;
  const pendingTx = m?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const pendingGov =
    m?.governance.filter((g) => g.status === "pending").length ?? 0;
  return {
    id: v.id,
    label: v.label,
    addr: v.addr,
    createdAt: v.createdAt,
    isActive: v.id === activeVaultId,
    kind,
    signerCount: m?.signers.length ?? 0,
    threshold: m?.threshold ?? 0,
    pendingCount: pendingTx + pendingGov,
  };
}

/** Rename a vault. No unlock required — labels are non-sensitive UI
 *  metadata. Validates: trim, 1-32 chars, non-empty after trim. */
export async function renameVaultV4(
  vaultId: string,
  newLabel: string,
): Promise<void> {
  const trimmed = newLabel.trim();
  if (trimmed.length === 0) throw new Error("label must be non-empty");
  if (trimmed.length > 32) throw new Error("label must be 1-32 characters");
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) throw new Error("no v4 vaults container");
    const target = container.vaults.find((v) => v.id === vaultId);
    if (!target) throw new Error("unknown vault id");
    target.label = trimmed;
    await saveVaultsContainerV4(container);
  });
}

/** Outcome of a successful {@link removeVaultV4}. */
export interface RemoveVaultResultV4 {
  removedId: string;
  /** The elected successor when the removed vault was active; otherwise the
   *  unchanged active id. */
  newActiveVaultId: string;
  newActiveAddress: string;
  /** Labels of multisig vaults whose signer roster referenced the removed
   *  vault. Removing it does not corrupt their meta, but it destroys the key
   *  those wallets need to approve — callers surface this so the user is told
   *  which wallets lose a signer. */
  affectedMultisigLabels: string[];
}

/** Successor rule: the survivor with the lowest `createdAt`. Ties are broken
 *  by container order, taking the earlier record — `<=` keeps the accumulator,
 *  which is the earlier element. Deterministic, so the same removal always
 *  elects the same wallet. Callers guarantee a non-empty list. */
function electSuccessorV4(survivors: VaultRecordV4[]): VaultRecordV4 {
  return survivors.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
}

/** Labels of multisig vaults referencing `target` in their signer roster.
 *  Matched on the self-signer's `vaultId` where present and on the address
 *  otherwise, so external entries that name the same address are caught too. */
function multisigVaultsReferencingV4(
  vaults: VaultRecordV4[],
  target: VaultRecordV4,
): string[] {
  const addr = target.addr.toLowerCase();
  return vaults
    .filter(
      (v) =>
        v.id !== target.id &&
        v.kind === "multisig" &&
        (v.multisig?.signers ?? []).some(
          (s) => s.vaultId === target.id || s.address.toLowerCase() === addr,
        ),
    )
    .map((v) => v.label);
}

/**
 * Permanently remove ONE vault from the container after re-verifying the
 * master password.
 *
 * Verification is a fresh Argon2id derivation plus an authenticated decrypt of
 * the TARGET vault's envelope. A wrong password yields a wrong MEK, which fails
 * the Poly1305 tag — and that happens before anything is written. The cached
 * MEK proves only that a session is open; it is never accepted in place of the
 * password. No plaintext password is stored, compared, or logged, and the
 * derived MEK is zeroed on every exit path.
 *
 * Fails CLOSED, in this order, with nothing persisted unless every check passes:
 *   - locked container;
 *   - unknown vault id;
 *   - the LAST remaining vault. Removing it would leave `activeVaultId`
 *     dangling, and `unlockContainerV4` would then throw "container is missing
 *     its active vault" — a bricked wallet. Callers route the user to Reset
 *     wallet, which wipes cleanly, instead.
 *
 * Atomicity: the new container is persisted BEFORE any in-memory state moves.
 * If the write fails, the on-disk container is untouched, the held backend is
 * still the original, and any successor backend opened in advance is disposed
 * rather than abandoned. A half-applied removal is not reachable.
 *
 * Scope: this removes the vault RECORD only — its wrapped key, its sealed
 * seed + mnemonic envelope, its cached address, and any per-vault passkey,
 * SLH-DSA backup, and multisig meta. Address-keyed state that lives outside the
 * container (contacts, connected-site grants, activity caches) is deliberately
 * left alone; a targeted purge is a separate concern.
 */
export async function removeVaultV4(
  password: string,
  vaultId: string,
): Promise<RemoveVaultResultV4> {
  if (!mekCache) throw new Error("container is locked");
  // H1/D2 — the KDF runs OUTSIDE the container lock, deliberately.
  //
  // `masterKdf` is the one part of the container that cannot go stale: it is
  // written exactly once, in `commitVaultFromSeed`'s fresh-container literal,
  // and no writer mutates it thereafter. Reading it from a pre-lock snapshot is
  // therefore safe, and it keeps a ~1 s Argon2id derivation out of the critical
  // section — holding the lock across it would queue every other container op
  // behind this one and make the UI look hung.
  //
  // Everything that CAN go stale — the vault list, the active id, the target
  // record — is re-read INSIDE the lock below. Acting on this pre-lock snapshot
  // would be the original bug with extra steps.
  const pre = await loadVaultsContainerV4();
  if (!pre) throw new Error("no v4 vaults container");
  // D4 — cheap structural pre-check on the pre-lock snapshot, so a bogus vault
  // id or a single-vault container is refused BEFORE spending a ~2.76 s
  // Argon2id derivation. Hoisting the KDF above the lock (D2) put these checks
  // behind it; this puts a copy back in front.
  //
  // OPTIMISATION ONLY — NOT THE BOUNDARY. This snapshot is taken outside the
  // container lock and can be stale, so it may let a request through that the
  // authoritative checks inside the lock then refuse. That direction is safe;
  // the reverse is not, which is why these checks are duplicated rather than
  // moved. Both messages are structural refusals, so neither costs the user a
  // brute-force attempt.
  if (!pre.vaults.some((v) => v.id === vaultId)) {
    throw new Error("unknown vault id");
  }
  if (pre.vaults.length <= 1) {
    throw new Error("cannot remove the last vault — use Reset wallet instead");
  }
  const mek = await deriveMekV4(password, pre.masterKdf);
  try {
    return await withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
      const container = await loadVaultsContainerV4();
      if (!container) throw new Error("no v4 vaults container");
      const target = container.vaults.find((v) => v.id === vaultId);
      if (!target) throw new Error("unknown vault id");
      if (container.vaults.length <= 1) {
        throw new Error(
          "cannot remove the last vault — use Reset wallet instead",
        );
      }

      const survivors = container.vaults.filter((v) => v.id !== vaultId);
      const wasActive = container.activeVaultId === vaultId;
      const successorId = wasActive
        ? electSuccessorV4(survivors).id
        : container.activeVaultId;

      // Prove password knowledge, and (only if needed) open the successor.
      // Both happen before any mutation.
      let nextState: UnlockedState | null = null;
      const vek = unwrapVekV4(mek, target.wrappedKey, target.id);
      try {
        const opened = openVaultEnvelopeV4(vek, target.envelope, target.id);
        opened.seed.fill(0);
      } finally {
        vek.fill(0);
      }
      if (wasActive) {
        nextState = await loadVaultBackend(mek, electSuccessorV4(survivors));
      }

      const affectedMultisigLabels = multisigVaultsReferencingV4(
        container.vaults,
        target,
      );

      container.vaults = survivors;
      container.activeVaultId = successorId;
      try {
        await saveVaultsContainerV4(container);
      } catch (e) {
        // Nothing on disk changed and no in-memory state has moved yet. Dispose
        // the successor we opened speculatively so its decrypted secret doesn't
        // linger.
        nextState?.backend.dispose();
        // C9 — the AEAD above already passed, so the password was CORRECT. A
        // write failure here is infrastructure, not a guess: it must not be
        // charged to the brute-force counter or reported as a wrong password.
        throw markPostVerificationFailure(e);
      }

      if (nextState) {
        // S1-01: wipe the removed vault's ML-DSA-65 secret once the successor is
        // installed, rather than leaving it for GC — same discipline as
        // selectActiveVaultV4.
        const prev = unlocked;
        unlocked = nextState;
        activeContainerVaultId = successorId;
        prev?.backend.dispose();
      }

      return {
        removedId: vaultId,
        newActiveVaultId: successorId,
        newActiveAddress: nextState?.address ?? unlocked?.address ?? "",
        affectedMultisigLabels,
      };
    });
  } finally {
    // Covers every exit, including a rejection while WAITING for the lock.
    mek.fill(0);
  }
}

/** Generate a fresh recovery phrase and add a new vault to the
 *  container. Requires the container to be unlocked. Returns the new
 *  vault id, the mnemonic (one-time — treat like a private key), and
 *  the derived address. Does NOT change `activeVaultId`.
 *
 *  When `label` is provided it is trimmed and validated to 1-32 chars
 *  (matches {@link renameVaultV4}); when omitted the SW assigns
 *  `"Vault N"` where N is the post-append vault count. */
export async function addVaultFreshV4(label?: string): Promise<{
  vaultId: string;
  mnemonic: string;
  address: string;
}> {
  if (!mekCache) throw new Error("container is locked");
  const mnemonic = generateMnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = mnemonicToMlDsa65Seed(mnemonic);
  try {
    return await appendVaultRecord(mekCache, seed, mnemonic, label);
  } finally {
    seed.fill(0);
  }
}

/** Generate a fresh recovery phrase WITHOUT
 *  persisting any vault. The popup uses this for the in-app multi-
 *  step new-wallet flow (show phrase → verify phrase → commit). The
 *  returned mnemonic lives in popup-side React state until the user
 *  verifies it, at which point the existing addVaultImportV4 path
 *  takes over for the actual commit. Requires the container to be
 *  unlocked so the SW context has the keystore available for the
 *  follow-up commit — generating while locked would let a stale
 *  mnemonic leak into a state where it could be committed against
 *  the wrong container after an unlock. */
export function generateFreshMnemonicV4(): string {
  if (!mekCache) throw new Error("container is locked");
  return generateMnemonic((out) => {
    out.set(randomBytes(out.length));
  });
}

/** Import a user-supplied recovery phrase and add it to the container.
 *  Requires the container to be unlocked. Rejects if the derived
 *  address already matches a vault in the container (duplicate seed).
 *  See {@link addVaultFreshV4} for label semantics. */
export async function addVaultImportV4(
  mnemonic: string,
  label?: string,
): Promise<{ vaultId: string; address: string }> {
  if (!mekCache) throw new Error("container is locked");
  const seed = mnemonicToMlDsa65Seed(mnemonic);
  try {
    const r = await appendVaultRecord(mekCache, seed, mnemonic, label);
    return { vaultId: r.vaultId, address: r.address };
  } finally {
    seed.fill(0);
  }
}

/** Generate a fresh multisig vault. Creates a new ML-DSA-65 keypair
 *  for the multisig vault itself (this is the keypair that submits
 *  executed proposals on-chain) and attaches the supplied signer
 *  roster + threshold as the M-of-N policy.
 *
 *  Whitepaper §28.5 (wallet portfolio / multisig policy) — N up to
 *  {@link MAX_SIGNERS} (16); threshold in [1, N]. The wallet enforces the policy at the IPC boundary.
 *  The chain DOES enforce M-of-N natively (unconditional `verify_quorum` on the
 *  0x40 multisig witness) and the SDK exposes the witness encoders; the gap is
 *  wallet adoption — see shared/multisig.ts module doc-block for the off-chain story.
 *
 *  Returns the new vault id, the multisig vault's mnemonic (the
 *  "executor" recovery phrase — treat like a single-vault mnemonic),
 *  and its on-chain address. */
export async function addVaultMultisigV4(args: {
  signers: MultisigSigner[];
  threshold: number;
  label?: string;
}): Promise<{
  vaultId: string;
  mnemonic: string;
  address: string;
}> {
  if (!mekCache) throw new Error("container is locked");
  for (const s of args.signers) validateSignerInput(s);
  assertSignerSetUnique(args.signers);
  validateThreshold(args.threshold, args.signers.length);

  const mnemonic = generateMnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = mnemonicToMlDsa65Seed(mnemonic);
  try {
    return await appendVaultRecord(mekCache, seed, mnemonic, args.label, {
      kind: "multisig",
      multisig: {
        signers: args.signers,
        threshold: args.threshold,
        proposals: [],
        governance: [],
      },
    });
  } finally {
    seed.fill(0);
  }
}

/** Sign a 32-byte prehash with a target vault's ML-DSA-65 keypair.
 *  Requires the container to be unlocked (cached MEK). Used by the
 *  multisig proposal flow so the proposer's self-signer key signs
 *  approval signatures without forcing an active-vault swap. Does
 *  NOT swap the active vault — caller's `unlocked` state is
 *  unchanged. Returns the raw signature bytes (~3309 bytes for
 *  ML-DSA-65). */
export async function signWithVaultV4(
  vaultId: string,
  digest: Uint8Array,
): Promise<Uint8Array> {
  if (!mekCache) throw new Error("container is locked");
  if (digest.length !== 32) {
    throw new Error(`digest must be 32 bytes, got ${digest.length}`);
  }
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  const vek = unwrapVekV4(mekCache, v.wrappedKey, v.id);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, v.envelope, v.id);
    seed = opened.seed;
  } finally {
    vek.fill(0);
  }
  let backend: MlDsa65Backend | null = null;
  try {
    backend = MlDsa65Backend.fromSeed(seed);
    return backend.signPrehash(digest);
  } finally {
    seed.fill(0);
    backend?.dispose(); // S1-01: wipe the transient signer's secret after use
  }
}

/** Read a target vault's 1952-byte ML-DSA-65 pubkey as a 0x-prefixed
 *  hex string. Requires the container to be unlocked (cached MEK).
 *  Used by the MultisigCreateModal to populate self-signer pubkey
 *  fields without forcing the user to switch active vaults. Does NOT
 *  swap the active vault — caller's `unlocked` state is unchanged. */
export async function getVaultPubkeyV4(vaultId: string): Promise<string> {
  if (!mekCache) throw new Error("container is locked");
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  const vek = unwrapVekV4(mekCache, v.wrappedKey, v.id);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, v.envelope, v.id);
    seed = opened.seed;
  } finally {
    vek.fill(0);
  }
  let backend: MlDsa65Backend | null = null;
  try {
    backend = MlDsa65Backend.fromSeed(seed);
    return "0x" + bytesToHex(backend.publicKey());
  } finally {
    seed.fill(0);
    backend?.dispose(); // S1-01: wipe the transient backend's secret after use
  }
}

/** Read a vault's multisig meta. Returns null for single vaults or
 *  unknown ids. No unlock required — the meta is plaintext alongside
 *  the encrypted envelope (signer pubkeys + proposal payloads are
 *  intentionally non-secret; only the multisig vault's own seed is
 *  encrypted). */
export async function readMultisigMetaV4(
  vaultId: string,
): Promise<MultisigVaultMeta | null> {
  const container = await loadVaultsContainerV4();
  if (!container) return null;
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v || v.kind !== "multisig" || !v.multisig) return null;
  return cloneMultisigMeta(v.multisig);
}

/** Replace a multisig vault's meta atomically. Caller is expected to
 *  have validated the new meta (signer roster unique, threshold in
 *  range, etc.); this helper just persists. Throws on unknown id or
 *  non-multisig vault. */
export async function writeMultisigMetaV4(
  vaultId: string,
  meta: MultisigVaultMeta,
): Promise<void> {
  return mutateContainer((container) => {
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    if (v.kind !== "multisig") {
      throw new Error("target vault is not a multisig vault");
    }
    validateThreshold(meta.threshold, meta.signers.length);
    assertSignerSetUnique(meta.signers);
    v.multisig = cloneMultisigMeta(meta);
  });
}

function cloneMultisigMeta(meta: MultisigVaultMeta): MultisigVaultMeta {
  return {
    signers: meta.signers.map((s) => ({ ...s })),
    threshold: meta.threshold,
    proposals: meta.proposals.map((p) => ({
      ...p,
      approvals: p.approvals.map((a) => ({ ...a })),
      rejections: p.rejections.map((a) => ({ ...a })),
      action: { ...p.action },
    })),
    // B.3 fail-closed: a governance proposal persisted before the P1-006
    // chainIdHex binding (shipped 0.4.x) can't be re-hashed/verified — drop it
    // from the actionable meta rather than crash later at hashGovernanceProposal.
    // Testnet phase: no migration; the user re-creates the proposal.
    governance: meta.governance
      .filter((g) => typeof g.chainIdHex === "string")
      .map((g) => ({
        ...g,
        approvals: g.approvals.map((a) => ({ ...a })),
        rejections: g.rejections.map((a) => ({ ...a })),
        action: cloneGovernanceAction(g.action),
      })),
  };
}

function cloneGovernanceAction(
  a: MultisigVaultMeta["governance"][number]["action"],
): MultisigVaultMeta["governance"][number]["action"] {
  if (a.kind === "add-signer") return { kind: "add-signer", signer: { ...a.signer } };
  if (a.kind === "replace-signer") {
    return {
      kind: "replace-signer",
      signerId: a.signerId,
      replacement: { ...a.replacement },
    };
  }
  return { ...a };
}

// ---- Passkey per-vault state ----

/** Read a vault's passkey state. Returns an empty (disabled, no
 *  credentials) state when the vault is unknown or has never
 *  configured passkeys — caller never needs a presence check. */
export async function readPasskeyStateV4(
  vaultId: string,
): Promise<VaultPasskeyState> {
  const container = await loadVaultsContainerV4();
  if (!container) return emptyVaultPasskeyState();
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v || !v.passkey) return emptyVaultPasskeyState();
  return clonePasskeyState(v.passkey);
}

/** Append a fresh credential to the targeted vault. Throws on
 *  unknown id, on cap-reached, or on duplicate credentialId. */
export async function addPasskeyCredentialV4(
  vaultId: string,
  cred: PasskeyCredential,
): Promise<VaultPasskeyState> {
  return mutateContainer((container) => {
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    const current = v.passkey ?? emptyVaultPasskeyState();
    const next = appendCredential(current, cred);
    v.passkey = clonePasskeyState(next);
    return clonePasskeyState(next);
  });
}

/** Remove a credential by id. No-op if absent. Auto-disables the
 *  policy when the last credential is removed (shared helper handles
 *  that). */
export async function removePasskeyCredentialV4(
  vaultId: string,
  credentialId: string,
): Promise<VaultPasskeyState> {
  return mutateContainer((container) => {
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    const current = v.passkey ?? emptyVaultPasskeyState();
    const next = removePasskeyCredential(current, credentialId);
    v.passkey = clonePasskeyState(next);
    return clonePasskeyState(next);
  });
}

/** Advance a credential's stored signature counter after a verified WebAuthn
 *  assertion (boundary 3b). No-op when the vault / credential is absent, or
 *  when the new count would not advance (the monotonic check in
 *  `verifyPasskeyAssertion` already gates this; the never-lower guard here is
 *  defense-in-depth). Best-effort — the single-use challenge is the primary
 *  replay defense; the counter catches a cloned authenticator across sessions. */
export async function updatePasskeyCredentialSignCountV4(
  vaultId: string,
  credentialId: string,
  newSignCount: number,
): Promise<void> {
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) return;
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v || !v.passkey) return;
    const next = clonePasskeyState(v.passkey);
    const idx = next.credentials.findIndex(
      (c) => c.credentialId === credentialId,
    );
    if (idx < 0) return;
    const cur = next.credentials[idx]!;
    if (typeof cur.signCount === "number" && newSignCount <= cur.signCount) {
      return;
    }
    next.credentials[idx] = { ...cur, signCount: newSignCount };
    v.passkey = next;
    await saveVaultsContainerV4(container);
  });
}

/** Replace the policy. Validation runs inside `setPolicy` — bad input
 *  throws without persisting. */
export async function setPasskeyPolicyV4(
  vaultId: string,
  policy: PasskeyPolicy,
): Promise<VaultPasskeyState> {
  return mutateContainer((container) => {
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    const current = v.passkey ?? emptyVaultPasskeyState();
    const next = setPasskeyPolicy(current, policy);
    v.passkey = clonePasskeyState(next);
    return clonePasskeyState(next);
  });
}

// ---- SLH-DSA backup CRUD ----
//
// The keygen + secret-key encryption lives in
// `src/background/slh-dsa-keygen.ts`. These
// helpers are the storage seam — they accept an already-prepared
// `SlhDsaBackup` record and persist / read it through the same
// container the rest of the vault state lives in. Read paths return
// `null` (not a placeholder) for vaults that have not opted into
// the backup flow.

/** Read the SLH-DSA backup record for the target vault. Returns
 *  `null` for unknown vault ids and for vaults that have never
 *  generated a backup. Tolerates the round-trip through
 *  chrome.storage via `cloneBackupForRead` — a corrupt on-disk
 *  shape returns `null` rather than crashing the caller. */
export async function readSlhDsaBackupV4(
  vaultId: string,
): Promise<SlhDsaBackup | null> {
  const container = await loadVaultsContainerV4();
  if (!container) return null;
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v || !v.slhDsaBackup) return null;
  return cloneBackupForRead(v.slhDsaBackup);
}

/** Replace the SLH-DSA backup record atomically. Caller is the
 *  keygen path — by the time we get here the secret key
 *  has already been VEK-wrapped + the user has gone through the
 *  reveal-modal flow. Throws on unknown vault id; the caller never
 *  catches it because the only call site is the SW IPC handler
 *  which surfaces the throw as a typed error. */
export async function writeSlhDsaBackupV4(
  vaultId: string,
  backup: SlhDsaBackup,
): Promise<SlhDsaBackup> {
  return mutateContainer((container) => {
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    v.slhDsaBackup = cloneBackupForWrite(backup);
    // Return through the read clone so the caller always gets a
    // fresh object (defensive against future mutation by callers
    // that capture the reference).
    return cloneBackupForRead(v.slhDsaBackup) ?? backup;
  });
}

/** Drop the SLH-DSA backup record entirely. Used by the Settings →
 *  Security re-export flow when the user explicitly chooses
 *  "Generate a new backup key" (which means abandoning the prior
 *  one — chain registration is one-time, so the new key cannot be
 *  registered on the same vault address; this is an escape hatch
 *  for users who lost their cold-storage copy and accept that the
 *  on-chain registration is now irrecoverable for this vault).
 *  Returns `true` if a record existed and was removed. */
export async function clearSlhDsaBackupV4(
  vaultId: string,
): Promise<boolean> {
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) return false;
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v || !v.slhDsaBackup) return false;
    delete v.slhDsaBackup;
    await saveVaultsContainerV4(container);
    return true;
  });
}

/** Generate a fresh SLH-DSA backup keypair for the target vault,
 *  encrypt the secret + entropy under the vault's VEK, persist the
 *  record into the container, and return the human-readable
 *  24-word BIP-39 mnemonic for the popup's reveal flow.
 *
 *  Requires the container to be unlocked (MEK cached). The caller
 *  (SW IPC handler) checks `isUnlockedV4()` before invoking; we
 *  throw a typed `"keystore locked"` if the cache is empty so a
 *  race between auto-lock + user action surfaces cleanly.
 *
 *  Refuses to overwrite an existing record — Re-export uses
 *  {@link recoverSlhDsaMnemonicV4} instead. Callers that want to
 *  abandon and regenerate must call {@link clearSlhDsaBackupV4}
 *  first (Settings → Security exposes this as an explicit
 *  "Generate new key" action that warns about losing any prior
 *  on-chain registration).
 *
 *  Returns `{ mnemonic, backup }` — the mnemonic is for the
 *  popup ONLY and is never persisted; the backup record is what
 *  callers can read back via {@link readSlhDsaBackupV4}. */
export async function generateSlhDsaBackupV4(
  vaultId: string,
): Promise<{ mnemonic: string; backup: SlhDsaBackup }> {
  if (mekCache === null) {
    throw new Error("keystore locked");
  }
  const mek = mekCache;
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) throw new Error("no v4 vaults container");
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v) throw new Error("unknown vault id");
    if (v.slhDsaBackup && v.slhDsaBackup.publicKey.length > 0) {
      throw new Error(
        "backup already exists — clear it first or use the re-export flow",
      );
    }

    // Unwrap the VEK locally, run keygen, zero the VEK before return.
    // The VEK never escapes this function's stack — the keygen module
    // gets it by-reference and zeroes its working secret too.
    const vek = unwrapVekV4(mek, v.wrappedKey, v.id);
    let prepared: { mnemonic: string; backup: SlhDsaBackup };
    try {
      prepared = prepareSlhDsaBackup({ vek });
    } finally {
      vek.fill(0);
    }

    v.slhDsaBackup = cloneBackupForWrite(prepared.backup);
    await saveVaultsContainerV4(container);
    // Return the in-memory record (with mnemonic) — the caller
    // forwards mnemonic to the popup and lets it fall out of scope.
    return prepared;
  });
}

/** Re-derive the 24-word mnemonic from a previously-generated
 *  backup record. Used by the Settings → Security "Re-export"
 *  flow. Requires the container to be unlocked. Throws if the
 *  vault has no backup, or if the AEAD decrypt fails (wrong VEK,
 *  tampered ciphertext). */
export async function recoverSlhDsaMnemonicV4(
  vaultId: string,
): Promise<string> {
  if (mekCache === null) {
    throw new Error("keystore locked");
  }
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  if (!v.slhDsaBackup || v.slhDsaBackup.publicKey.length === 0) {
    throw new Error("no backup configured for this vault");
  }

  const vek = unwrapVekV4(mekCache, v.wrappedKey, v.id);
  try {
    return recoverBackupMnemonic(vek, v.slhDsaBackup);
  } finally {
    vek.fill(0);
  }
}

/** Flip `coldStorageConfirmed` to `true` after the user attests
 *  via the reveal modal's "I have written this down" checkbox.
 *  Idempotent — calling on an already-confirmed record is a no-op.
 *  Returns the updated record (or null if the vault has no backup). */
export async function confirmSlhDsaColdStorageV4(
  vaultId: string,
): Promise<SlhDsaBackup | null> {
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    const container = await loadVaultsContainerV4();
    if (!container) return null;
    const v = container.vaults.find((rec) => rec.id === vaultId);
    if (!v || !v.slhDsaBackup) return null;
    if (!v.slhDsaBackup.coldStorageConfirmed) {
      v.slhDsaBackup = cloneBackupForWrite({
        ...v.slhDsaBackup,
        coldStorageConfirmed: true,
      });
      await saveVaultsContainerV4(container);
    }
    return cloneBackupForRead(v.slhDsaBackup);
  });
}

/** Update a backup record's chain-registration status atomically.
 *  The popup orchestrates the flow:
 *
 *    1. read backup → decode pubkey → buildTx → bgWalletSendTx
 *    2. on tx-submitted reply, call this with status="pending"
 *       + the returned tx hash
 *    3. on a later receipt poll (or a manual user "check status"),
 *       call this again with "registered" + the inclusion block,
 *       or "registration-failed" + the revert reason
 *    4. clear back to "not-registered" only if the caller decides
 *       to abandon a stuck `pending` and retry (rare)
 *
 *  Throws on unknown vault id / no backup record (call
 *  `generateSlhDsaBackupV4` first). */
export async function setSlhDsaRegistrationStatusV4(
  vaultId: string,
  args: {
    status: "not-registered" | "pending" | "registered" | "registration-failed";
    /** Tx hash — required when transitioning to `pending` or
     *  `registered`; cleared when transitioning to
     *  `not-registered`. Optional otherwise. */
    txHash?: string | null;
    /** Inclusion block — populated when transitioning to
     *  `registered`. */
    block?: number | null;
    /** Chain revert reason — populated when transitioning to
     *  `registration-failed`. */
    error?: string | null;
  },
): Promise<SlhDsaBackup> {
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  if (!v.slhDsaBackup) {
    throw new Error("no backup record for this vault");
  }

  // Build the next record from the existing one + the patch. Use
  // conditional spreads for the optional fields so we can both
  // SET and CLEAR them through this single API (`undefined` →
  // omit from record, `null` → also omit, a string → set, etc.).
  const next: SlhDsaBackup = {
    ...v.slhDsaBackup,
    chainRegistrationStatus: args.status,
    ...(typeof args.txHash === "string"
      ? { chainRegistrationTxHash: args.txHash }
      : {}),
    ...(typeof args.block === "number"
      ? { chainRegistrationBlock: args.block }
      : {}),
    ...(typeof args.error === "string"
      ? { chainRegistrationError: args.error }
      : {}),
  };

  // For terminal states, clear stale fields explicitly so a UI
  // that reads the record sees a clean shape rather than a mix of
  // old + new metadata. Use delete to make the field absent (which
  // honours `exactOptionalPropertyTypes`).
  if (args.status === "not-registered") {
    delete next.chainRegistrationTxHash;
    delete next.chainRegistrationBlock;
    delete next.chainRegistrationError;
  }
  if (args.status === "registered") {
    delete next.chainRegistrationError;
  }
  if (args.status === "registration-failed") {
    // Keep the txHash if we have one (the failure may have a tx
    // we want the user to be able to investigate) but drop the
    // success-block field.
    delete next.chainRegistrationBlock;
  }
  if (args.txHash === null) {
    delete next.chainRegistrationTxHash;
  }

  v.slhDsaBackup = cloneBackupForWrite(next);
  await saveVaultsContainerV4(container);
  return cloneBackupForRead(v.slhDsaBackup) ?? next;
  });
}

/** Defensive copy so callers can't mutate stored state by holding a
 *  reference to the returned record.
 *
 *  Also tolerates the JSON-safe form policy may be in
 *  after a chrome.storage round-trip. `BigInt` values do not survive
 *  the chrome.storage persistence boundary reliably across all Chrome
 *  versions — some strip the field silently, leaving `policy.limitWei`
 *  / `policy.dailyCapWei` as `undefined`. This clone normalises both
 *  the in-memory (bigint-typed) and on-disk (string- or missing-typed)
 *  shapes back into a well-formed in-memory record, falling back to
 *  the defaults from `defaultPasskeyPolicy()` whenever a field can't
 *  be coerced. */
function clonePasskeyState(s: VaultPasskeyState | StoredPasskeyState | unknown): VaultPasskeyState {
  const safe = (s ?? emptyVaultPasskeyState()) as Partial<VaultPasskeyState> &
    Partial<StoredPasskeyState>;
  const credentials = Array.isArray(safe.credentials)
    ? safe.credentials.map((c) => ({ ...c }))
    : [];
  return {
    credentials,
    policy: clonePasskeyPolicy(safe.policy),
  };
}

/** JSON-safe shape that's actually written to chrome.storage. BigInt
 *  fields collapse to decimal strings; the rest of the policy is
 *  plain JSON. Used only at the persistence boundary inside
 *  `saveVaultsContainerV4` + on load. */
interface StoredPasskeyPolicy {
  enabled: boolean;
  mode: "per-tx" | "daily";
  limitWei: string;
  dailyCapWei: string;
}

interface StoredPasskeyState {
  credentials: PasskeyCredential[];
  policy: StoredPasskeyPolicy;
}

/** Normalise an arbitrary `policy` blob back into a `PasskeyPolicy`.
 *  Accepts either the in-memory (bigint-typed) or the on-disk
 *  (string- or missing-typed) shape; coerces passkey amounts to v4.1
 *  lythoshi at the storage boundary. */
function clonePasskeyPolicy(raw: unknown): PasskeyPolicy {
  const def = defaultPasskeyPolicy();
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    mode: r.mode === "daily" ? "daily" : "per-tx",
    limitWei: toPasskeyLythoshiOrDefault(
      r.limitWei,
      DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
    ),
    dailyCapWei: toPasskeyLythoshiOrDefault(
      r.dailyCapWei,
      DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
    ),
  };
}

/** Coerce a value into a `bigint`, falling back to `fallback` when
 *  the input is missing or unparseable. Accepts: bigint (passthrough),
 *  string (decimal or hex), number (truncated via `BigInt(Math.floor(...))`).
 *  Returns the fallback on everything else. */
function toBigIntOrDefault(v: unknown, fallback: bigint): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      return fallback;
    }
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    try {
      return BigInt(Math.floor(v));
    } catch {
      return fallback;
    }
  }
  return fallback;
}

const LEGACY_WEI_PER_LYTHOSHI = 10_000_000_000n;

/** Coerce a passkey policy amount into v4.1 lythoshi. Older builds
 *  persisted these compatibility-named fields as 18-decimal wei; if
 *  that value maps cleanly into the allowed lythoshi range, normalize
 *  it at the storage boundary. */
function toPasskeyLythoshiOrDefault(v: unknown, fallback: bigint): bigint {
  const raw = toBigIntOrDefault(v, fallback);
  if (
    raw > MAX_PASSKEY_LIMIT_LYTHOSHI &&
    raw % LEGACY_WEI_PER_LYTHOSHI === 0n
  ) {
    const maybeLythoshi = raw / LEGACY_WEI_PER_LYTHOSHI;
    if (
      maybeLythoshi >= MIN_PASSKEY_LIMIT_LYTHOSHI &&
      maybeLythoshi <= MAX_PASSKEY_LIMIT_LYTHOSHI
    ) {
      return maybeLythoshi;
    }
  }
  return raw;
}

/** Project a `VaultPasskeyState` down to the JSON-safe shape that's
 *  written to chrome.storage. BigInt → decimal string; everything
 *  else is preserved. */
function passkeyStateForStorage(s: VaultPasskeyState): StoredPasskeyState {
  return {
    credentials: s.credentials.map((c) => ({ ...c })),
    policy: {
      enabled: s.policy.enabled,
      mode: s.policy.mode,
      limitWei: s.policy.limitWei.toString(),
      dailyCapWei: s.policy.dailyCapWei.toString(),
    },
  };
}

/** Shared body for {@link addVaultFreshV4} + {@link addVaultImportV4} +
 *  {@link addVaultMultisigV4}. Generates a VEK, seals the seed +
 *  mnemonic, wraps the VEK with the cached MEK, rejects duplicate
 *  addresses, appends, saves. Validates the optional caller-supplied
 *  label with the same rules as {@link renameVaultV4}; falls back to
 *  `"Wallet N"` (where N is the post-append vault count) when the
 *  caller passes no label. (The UI surface uses
 *  "Wallet" everywhere; the data-structure name stays "vault" for
 *  diff continuity with storage keys, IPC ops, and types.) Optional
 *  `extra` block attaches multisig metadata for the multisig path. */
async function appendVaultRecord(
  mek: Uint8Array,
  seed: Uint8Array,
  mnemonic: string,
  requestedLabel?: string,
  extra?: { kind: "single" | "multisig"; multisig?: MultisigVaultMeta },
): Promise<{ vaultId: string; mnemonic: string; address: string }> {
  // H1 — the ENTIRE read-modify-write runs under the container lock. This is
  // the append half of the fund-loss pair: without it, a concurrent writer that
  // read the container before this append's write would persist a vault array
  // lacking the record below, erasing a wrapped VEK and a sealed seed envelope
  // for an address that stays funded on-chain. No KDF runs here (the caller
  // supplies the cached MEK), so the lock is held only for the storage
  // round trips plus a backend construction.
  return withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  // NOTE: this backend is RETAINED as the held session backend below
  // (`unlocked = { backend, address }` — adding a fresh vault makes it active),
  // so it must NOT be disposed here — lockV4() wipes it (S1-01) on lock.
  const backend = MlDsa65Backend.fromSeed(seed);
  const address = await backend.getAddress();
  if (container.vaults.some((v) => v.addr === address)) {
    throw new Error("vault with this address already exists in the container");
  }
  let label: string;
  if (requestedLabel !== undefined) {
    const trimmed = requestedLabel.trim();
    if (trimmed.length === 0) throw new Error("label must be non-empty");
    if (trimmed.length > 32) throw new Error("label must be 1-32 characters");
    label = trimmed;
  } else {
    // Default label uses the user-facing "Wallet"
    // terminology. Existing records named "Vault N" by the previous
    // generator keep their stored labels (rename is the only way to
    // change them); only the default for new records changes.
    label = `Wallet ${container.vaults.length + 1}`;
  }
  // V5 (P1-003): the id is generated BEFORE the seal so it can be bound into
  // the AAD (wrap + envelope), which prevents a cross-vault ciphertext lift.
  const vaultId = crypto.randomUUID();
  const vek = generateVekV4();
  let wrappedKey: WrappedVekV4;
  let envelope: SealedSeedRecordV4;
  try {
    wrappedKey = wrapVekV4(mek, vek, vaultId);
    envelope = sealVaultEnvelopeV4(vek, seed, mnemonic, vaultId);
  } finally {
    vek.fill(0);
  }
  const record: VaultRecordV4 = {
    id: vaultId,
    label,
    createdAt: Date.now(),
    wrappedKey,
    envelope,
    addr: address,
  };
  if (extra?.kind === "multisig") {
    record.kind = "multisig";
    if (!extra.multisig) {
      throw new Error("multisig kind requires multisig meta");
    }
    record.multisig = extra.multisig;
  }
  container.vaults.push(record);
  // Auto-switch the active vault to the just-added record.
  // Previous design left the active vault unchanged and required the
  // caller to invoke `vault-select` separately to switch; the popup's
  // VaultAddModal didn't, so users saw the old vault's address after
  // creating a new one and reported it as a "fresh vault shows same
  // address" bug (a storage dump confirmed two
  // distinct addresses on disk; only the UI was stuck on the prior
  // active vault). Persist the new active vault id alongside the
  // append, and update the in-memory `unlocked` state from the live
  // `backend` we already hold so `getUnlockedAddressV4()` returns the
  // new address on the next `wallet-active-account` IPC. SW handlers
  // (`vault-add-fresh`, `vault-add-import`, `vault-add-multisig`)
  // broadcast `accountsChanged` after this returns so dApps + popup
  // refresh.
  container.activeVaultId = record.id;
  try {
    await saveVaultsContainerV4(container);
  } catch (e) {
    // DA-002 made this path reachable. The new vault was never persisted, so it
    // never becomes the session — dispose the backend built for it instead of
    // leaking a decrypted secret that `lockV4` (which only disposes `unlocked`)
    // would never reach. The previously active vault stays live and undisposed.
    backend.dispose();
    throw e;
  }
  // S1-01: dispose the PREVIOUSLY-active vault's backend (the outgoing session
  // secret) now that the just-added vault becomes active. The new `backend` is
  // deliberately NOT disposed here (see its construction note above — lockV4
  // owns it); only the outgoing `prev` instance is wiped.
  const prev = unlocked;
  unlocked = { backend, address };
  activeContainerVaultId = record.id;
  prev?.backend.dispose();
  return { vaultId: record.id, mnemonic, address };
  });
}

// ---- public API ----

export function isUnlockedV4(): boolean {
  return unlocked !== null;
}

/** The active address — ONLY when unlocked. Returns null while locked: the
 *  address lives in the in-memory backend set on unlock and is never resolved
 *  from the at-rest container metadata while locked (top-tier address privacy).
 *  Callers MUST treat null as "no address available right now". */
export function getUnlockedAddressV4(): string | null {
  return unlocked?.address ?? null;
}

/** The active vault id while unlocked, else null. Lets the SW resolve the
 *  per-vault passkey policy for the active vault without a popup-supplied
 *  vaultId (`wallet-send-tx` carries none). Mirrors {@link getUnlockedAddressV4}'s
 *  unlocked-only contract. */
export function getActiveVaultIdV4(): string | null {
  return unlocked ? activeContainerVaultId : null;
}

/** Verify a password against the active vault WITHOUT mutating unlock state:
 *  re-derive the MEK and attempt to unwrap the active vault's VEK (AEAD fails
 *  closed on a wrong password). Used by the SW to gate an over-limit passkey
 *  send behind a REAL password re-auth (T1-04(a)) — an SW-side check, never a
 *  popup-asserted flag (which the already-unlocked local actor this gate
 *  targets could forge). Returns false (never throws) on any failure and
 *  zeroes all derived secret material. */
/**
 * Why a container-password verification did not succeed.
 *
 * `structural: true` means the attempt **never evaluated the password** — the
 * container was absent, or present but with a dangling `activeVaultId`. No MEK
 * was tested against any ciphertext, so the outcome is identical for every
 * password, including the correct one. Callers use this to decide whether the
 * attempt counts against the brute-force budget: a structural refusal must NOT,
 * because charging it throttles a user whose password was right all along.
 *
 * `structural: false` is a genuine password verdict — the Poly1305 tag was
 * checked and it failed. That one always counts.
 */
/**
 * Mark an error as having been raised AFTER the password was proven correct.
 *
 * The brute-force counter exists to charge password GUESSES. Once the AEAD tag
 * has been checked and passed, the password is known-good, so anything that
 * fails downstream — a storage write rejecting, infrastructure erroring — is
 * not a guess and must not spend one of the user's attempts, nor be reported to
 * them as "wrong password".
 *
 * This is a POSITIVE signal tied to the verification event, deliberately not a
 * string in `isStructuralVaultRefusal`. That list is matched by message and
 * shared across every op, so it can only express properties of WHAT an error
 * says. This class is safe because of WHERE it is raised — downstream of the
 * AEAD — which a message match cannot capture: the moment any op wrote before
 * verifying, a message entry would silently hand out free guesses. Marking at
 * the raise site keeps the property attached to the thing that makes it true.
 */
export function markPostVerificationFailure(err: unknown): unknown {
  if (err && typeof err === "object") {
    (err as { postVerification?: boolean }).postVerification = true;
  }
  return err;
}

/** True when `err` was raised downstream of a successful password check. */
export function isPostVerificationFailure(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { postVerification?: boolean }).postVerification === true
  );
}

export type VerifyPasswordOutcomeV4 =
  | { verified: true }
  | {
      verified: false;
      structural: true;
      reason: "no-container" | "missing-active-vault";
    }
  | { verified: false; structural: false };

export async function verifyContainerPasswordV4(
  password: string,
): Promise<VerifyPasswordOutcomeV4> {
  const container = await loadVaultsContainerV4();
  if (!container) {
    return { verified: false, structural: true, reason: "no-container" };
  }
  const active = container.vaults.find((v) => v.id === container.activeVaultId);
  if (!active) {
    return {
      verified: false,
      structural: true,
      reason: "missing-active-vault",
    };
  }
  const mek = await deriveMekV4(password, container.masterKdf);
  try {
    const vek = unwrapVekV4(mek, active.wrappedKey, active.id);
    vek.fill(0);
    return { verified: true };
  } catch {
    // The AEAD tag was checked and failed — a real wrong-password verdict.
    return { verified: false, structural: false };
  } finally {
    mek.fill(0);
  }
}

/** Lock — wipe the in-memory backend, then drop its reference. The backend's
 * ML-DSA-65 secret key is held by the SDK; `dispose()` deterministically zeroes
 * the SDK-held copy (S1-01 / Stage-1 #11) before we release the reference for
 * GC, so the secret does not linger in the JS heap until the next collection.
 * `dispose()` is idempotent and leaves public material usable; we drop the
 * reference anyway. (Requires `@monolythium/core-sdk` >= 0.4.9, which ships
 * `MlDsa65Backend.dispose()`.)
 *
 * Also zeros + drops the cached MEK and forgets the active vault id (Phase
 * 5 multi-vault state). After lock, any vault-switch or vault-add call
 * fails until the user re-unlocks the container. */
export function lockV4(): void {
  unlocked?.backend.dispose();
  unlocked = null;
  if (mekCache) {
    mekCache.fill(0);
    mekCache = null;
  }
  activeContainerVaultId = null;
  // Fire-and-forget the session-MEK clear — lockV4 is sync to preserve
  // call-site shape (used by triggerAutoLock and the keystore-lock IPC).
  // The session.remove is fast (single key); SW
  // boot's rehydrate path tolerates an absent key the same as a
  // present-but-invalid one, so a partial-clear can't unlock a
  // post-lock SW.
  void clearMekFromSessionV4();
}

/**
 * Generate a fresh 24-word BIP-39 recovery phrase and commit a v4 vault.
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
  if (await hasContainerV4()) {
    throw new Error("v4 vault already exists; cannot overwrite");
  }
  const mnemonic = generateMnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = mnemonicToMlDsa65Seed(mnemonic);
  try {
    const address = await commitVaultFromSeed(password, seed, mnemonic);
    return { mnemonic, address };
  } finally {
    // Zeroize on BOTH the success and the throw path (P2 defense-in-depth,
    // mirroring the addVault*V4 siblings) — a failed derive/write must not
    // leave the 32-byte seed lingering in the heap.
    seed.fill(0);
  }
}

/** Import from a user-supplied 24-word BIP-39 recovery phrase.
 *
 * The supplied mnemonic is persisted alongside the seed (encrypted) so the
 * imported wallet can re-display the phrase from Settings without forcing
 * the user to re-import. */
export async function createVaultFromMnemonic(
  password: string,
  mnemonic: string,
): Promise<{ address: string }> {
  if (await hasContainerV4()) {
    throw new Error("v4 vault already exists; cannot overwrite");
  }
  const seed = mnemonicToMlDsa65Seed(mnemonic);
  try {
    const address = await commitVaultFromSeed(password, seed, mnemonic);
    return { address };
  } finally {
    seed.fill(0);
  }
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

  // Derive the keypair eagerly for the address that goes in the record.
  // NOTE: this backend is RETAINED as the held session backend below
  // (`unlocked = { backend, address }`, unlock-on-create), so it must NOT be
  // disposed here — lockV4() wipes it (S1-01) when the session ends.
  const backend = MlDsa65Backend.fromSeed(seed);
  // P2-004 — until ownership of `mek` + `backend` transfers to the session
  // (mekCache / unlocked) below, any throw must zeroize the derived MEK and
  // dispose the backend so a mid-commit failure can't leave key material live
  // in the heap. On success they're owned by the session — do NOT wipe.
  let mek: Uint8Array | null = null;
  let committed = false;
  try {
    const address = await backend.getAddress();

    // Build a fresh container holding this one vault, master-password-
    // unlocked, seeded from the freshly generated seed/mnemonic. No
    // single-vault `mono.vault.v4` write — create commits straight into
    // the `mono.vaults.v4` container shape.
    const masterKdf = generateMasterKdfParamsV4();
    // D2 — derive BEFORE taking the container lock. These params are freshly
    // generated rather than read from storage, so there is nothing here that
    // could go stale while we wait.
    mek = await deriveMekV4(password, masterKdf);
    const mekOwned = mek;
    return await withKeyLock(VAULTS_CONTAINER_KEY_V4, async () => {
    // H1 — the AUTHORITATIVE overwrite guard. The callers check
    // `hasContainerV4()` too, but that check is separated from this write by
    // `getAddress` and a ~1 s derivation, so on its own it is a check-then-act:
    // two concurrent onboarding commits could both pass it and both write, and
    // because this function persists a FRESH single-vault container the second
    // would obliterate the first. Re-checking inside the lock closes that.
    if (await hasContainerV4()) {
      throw new Error("v4 vault already exists; cannot overwrite");
    }
    // V5 (P1-003): id generated before the seal so it binds into the AAD.
    const vaultId = crypto.randomUUID();
    const vek = generateVekV4();
    let wrappedKey: WrappedVekV4;
    let envelope: SealedSeedRecordV4;
    try {
      wrappedKey = wrapVekV4(mekOwned, vek, vaultId);
      envelope = sealVaultEnvelopeV4(vek, seed, mnemonic, vaultId);
    } finally {
      vek.fill(0);
    }
    const record: VaultRecordV4 = {
      id: vaultId,
      label: "Wallet 1",
      createdAt: Date.now(),
      wrappedKey,
      envelope,
      addr: address,
    };
    const container: VaultsContainerV4 = {
      version: SCHEMA_VERSION,
      algo: ALGO_ID,
      kdf: KDF_ID,
      aead: AEAD_ID,
      masterKdf,
      vaults: [record],
      activeVaultId: record.id,
    };
    await saveVaultsContainerV4(container);

    // Unlock-on-create: same state-set as unlockContainerV4 (do NOT zero
    // `mek` — ownership transfers to mekCache). This reproduces the exact
    // end state the d67de85 follow-up unlockContainerV4 call established,
    // inline, so no single-vault write + re-unlock round-trip is needed.
    if (mekCache) mekCache.fill(0);
    mekCache = mekOwned;
    unlocked = { backend, address };
    activeContainerVaultId = record.id;
    committed = true; // ownership of mek + backend now held by the session
    await persistMekToSessionV4(mekOwned);
    return address;
    });
  } catch (e) {
    if (!committed) {
      if (mek) mek.fill(0);
      backend.dispose();
    }
    throw e;
  }
}


/**
 * Re-derive the MEK from `password` and decrypt the ACTIVE vault's stored
 * mnemonic. v4 schema mandates the mnemonic, so this returns it on success
 * or throws on AEAD failure — never returns null. The SW handler
 * (keystore-export-seed) layers the re-prompt + brute-force lockout on top
 * and treats any throw as wrong-password; the popup's hold-to-reveal flow
 * reads this result. Phase A: reads the ACTIVE vault, so switching wallets
 * then revealing shows the active wallet's phrase. Single-vault installs
 * are unaffected (active == the only vault).
 */
export async function exportMnemonicV4(
  password: string,
): Promise<{ mnemonic: string }> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vault — run onboarding first");
  const active = container.vaults.find((v) => v.id === container.activeVaultId);
  if (!active) throw new Error("container is missing its active vault");
  return exportMnemonicForVaultV4(password, active.id);
}

/**
 * Re-derive the MEK from `password` and decrypt a SPECIFIC vault's stored
 * mnemonic. Same pipeline as {@link exportMnemonicV4} — which now delegates
 * here — but targeted by id, so a wallet list can reveal a non-active wallet
 * without switching the active vault first.
 *
 * Does NOT cache the MEK: this is a read, not an unlock, and the derived key is
 * zeroed on every exit path. Nothing is persisted or logged; the phrase exists
 * only in the returned value.
 *
 * `vaultId` is a TRUSTED SELECTOR, not a check. It picks which record to open,
 * and a valid id returns that wallet's 24 words — which is the whole point of
 * the per-wallet reveal. Nothing here re-authorises the choice, and nothing
 * needs to: the caller has already proven the master password, which unlocks
 * every vault in the container. What that means for callers is that the
 * PROVENANCE of the id is theirs to guarantee — a stale or swapped id shows a
 * different wallet's phrase, silently and successfully.
 *
 * What the AEAD binding does do: `buildVaultAadV4(vaultId)` is threaded into
 * the wrapped VEK and both envelope halves, so a record's ciphertext only opens
 * under its OWN id. That stops a transplant — moving one vault's envelope into
 * another's slot in the container — not a caller naming a different vault.
 */
export async function exportMnemonicForVaultV4(
  password: string,
  vaultId: string,
): Promise<{ mnemonic: string }> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vault — run onboarding first");
  const target = container.vaults.find((v) => v.id === vaultId);
  if (!target) throw new Error("unknown vault id");
  const mek = await deriveMekV4(password, container.masterKdf);
  try {
    // Wrong password → MEK mismatch → AEAD failure here (unwrap or open),
    // which throws — the handler maps any throw to wrong-password.
    const vek = unwrapVekV4(mek, target.wrappedKey, target.id);
    let opened: { seed: Uint8Array; mnemonic: string };
    try {
      opened = openVaultEnvelopeV4(vek, target.envelope, target.id);
    } finally {
      vek.fill(0);
    }
    opened.seed.fill(0);
    return { mnemonic: opened.mnemonic };
  } finally {
    mek.fill(0);
  }
}


/** Get the unlocked backend's 1952-byte public key — needed for monkey-patched
 * `eth_accounts` views that want to surface "this is the ML-DSA pubkey" along
 * with the address. */
export function getUnlockedPublicKeyV4(): Uint8Array | null {
  return unlocked?.backend.publicKey() ?? null;
}

export function getUnlockedBackendV4(): MlDsa65Backend | null {
  return unlocked?.backend ?? null;
}

/** Sign the already-domain-separated wallet-auth v1 32-byte digest with the
 * active ML-DSA-65 backend. Kept separate from personal_sign (which applies an
 * EIP-191 prefix and keccak itself) so authentication bytes cannot cross into
 * the generic message-signing domain. Synchronous by design: the service
 * worker can snapshot, sign, and recheck the active vault without yielding. */
export function signWalletAuthDigestV4(digest: Uint8Array): Uint8Array {
  if (!unlocked) throw new Error("v4 wallet is locked");
  if (digest.length !== 32) {
    throw new Error(`wallet authentication digest must be 32 bytes, got ${digest.length}`);
  }
  return unlocked.backend.signPrehash(digest);
}

/**
 * EIP-191 personal_sign with the v4 ML-DSA-65 backend. The v4 vault
 * derives the wallet address from the ML-DSA pubkey, so signing
 * personal_sign payloads with secp256k1 (the keystore.ts path) would
 * recover to a different address than `eth_accounts[0]` — useless for
 * any dApp that does ecrecover. We sign with ML-DSA instead. The
 * signature is ~3309 bytes; dApps need a Monolythium-aware verifier
 * (whitepaper §22.7 ecosystem direction).
 *
 * Throws `"v4 wallet is locked"` if the keystore isn't unlocked.
 */
export function personalSignV4(message: Uint8Array | string): Uint8Array {
  if (!unlocked) throw new Error("v4 wallet is locked");
  const bytes =
    typeof message === "string" ? hexOrUtf8ToBytes(message) : message;
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${bytes.length}`,
  );
  const concat = new Uint8Array(prefix.length + bytes.length);
  concat.set(prefix, 0);
  concat.set(bytes, prefix.length);
  const digest = keccak_256(concat);
  return unlocked.backend.signPrehash(digest);
}

/**
 * EIP-712 v4 typed-data sign with the v4 ML-DSA-65 backend. Mirrors
 * `personalSignV4` rationale: the wallet address is derived from the
 * ML-DSA pubkey, so routing through keystore.ts secp256k1 would produce
 * signatures that don't recover to the wallet's claimed address. We
 * compute the EIP-712 v4 digest (pure helper from keystore.ts — no
 * module state needed) and sign with ML-DSA-65.
 *
 * Throws `"v4 wallet is locked"` if the keystore isn't unlocked.
 */
export function signTypedDataV4FromV4(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Uint8Array {
  if (!unlocked) throw new Error("v4 wallet is locked");
  const digest = computeTypedDataDigest(envelope);
  return unlocked.backend.signPrehash(digest);
}

// ---- hex helpers ----

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

// ---- test-only exports ----
//
// Mirrors the `__internal` pattern in keystore.ts — lets the vitest
// suite reach into the multi-vault helpers without exposing them on
// the public module API surface.
export const __internalV4Multi = {
  VAULTS_CONTAINER_KEY_V4,
  generateMasterKdfParamsV4,
  deriveMekV4,
  generateVekV4,
  buildVaultAadV4,
  wrapVekV4,
  unwrapVekV4,
  sealVaultEnvelopeV4,
  openVaultEnvelopeV4,
  isVaultsContainerV4,
  loadVaultsContainerV4,
  saveVaultsContainerV4,
};
