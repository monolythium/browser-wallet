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
// v4-multi (Phase 5): a parallel storage entry under
// chrome.storage.local["mono.vaults.v4"] holds a VaultsContainerV4 —
// the multi-vault layer described in whitepaper §21.2.1 ("Power users
// wanting multiple accounts ... use the keystore format with a wallet
// that manages many keystores"). The container is master-password-
// unlocked: argon2id(password, container.masterKdf) → MEK; each vault
// holds a random VEK; MEK wraps each VEK in `wrappedKey`. To read a
// vault's seed: unwrap VEK with MEK, then HKDF-split VEK into
// seedKey + mnemonicKey, then XChaCha20-Poly1305 the existing envelope.
// No BIP-32 / BIP-44 derivation paths (whitepaper §21.2.1 forbids HD in
// v1) — each vault is an independent 24-word PQM-1 mnemonic.
//
// Migration from the legacy single envelope ("mono.vault.v4") to the
// container ("mono.vaults.v4") is opportunistic, lazy, and runs inside
// the unlock handler the first time after the Phase 5 upgrade. The
// legacy entry is left in place for one release cycle as rollback
// safety; later phases drop it. Commit 1 of Phase 5 lands the schema +
// helpers + migration function only — wiring into the existing unlock
// path is Commit 2.
//
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  MlDsa65Backend,
  generatePqm1Mnemonic,
  pqm1MnemonicToMlDsa65Seed,
} from "@monolythium/core-sdk/crypto";
import {
  computeTypedDataDigest,
  hexOrUtf8ToBytes,
} from "./keystore.js";
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

// ---- v4-multi container constants (Phase 5) ----

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

// Cached after a successful unlockContainerV4(). Used by
// selectActiveVaultV4 / addVaultFreshV4 / addVaultImportV4 so vault
// switches and additions don't pay the ~1 second Argon2id-MEK cost
// per operation. Cleared by lockV4(). Never leaves this module.
let mekCache: Uint8Array | null = null;
let activeContainerVaultId: string | null = null;

// ---- v4-multi container types (Phase 5) ----

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
 *  (Phase 5 commit 3 wires the rename UI); createdAt anchors stable
 *  ordering when the container is rendered.
 *
 *  Phase 8 added the `kind` discriminant. `"single"` is the legacy
 *  shape — one mnemonic, one ML-DSA-65 keypair, one address. Vault
 *  records persisted before Phase 8 carry no `kind` field on disk and
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
  /** Phase 9 — optional per-vault passkey state. Absent on legacy
   *  vaults and on vaults that haven't run passkey registration; read
   *  paths treat absence as "no passkey configured" (policy disabled,
   *  no credentials). The actual WebAuthn key material lives in the
   *  browser's authenticator; the wallet only stores credential IDs +
   *  user-edited names + policy thresholds. See `shared/passkey.ts`
   *  for the rationale and the on-chain GAP analysis. */
  passkey?: VaultPasskeyState;
  /** Phase 10 — optional per-vault SLH-DSA emergency backup record.
   *  Absent on every vault until the user opts into the §30.1 flow.
   *  Read paths treat absence as "not set up". When present, the
   *  encrypted secret-key material is XChaCha20-Poly1305-sealed under
   *  the SAME VEK that protects the primary ML-DSA-65 envelope — the
   *  cold-storage backup the user wrote down is what they recover
   *  from in a G3 emergency, NOT this on-disk copy. See
   *  `shared/slh-dsa-backup.ts` for the rationale + chain-GAP
   *  analysis + parameter-set choice (`slh_dsa_sha2_128s` algo id
   *  `1101`, the only currently-chain-eligible backup variant per
   *  Law §2.9). */
  slhDsaBackup?: SlhDsaBackup;
}

/** Multi-vault container. Stored under
 *  chrome.storage.local["mono.vaults.v4"]. */
interface VaultsContainerV4 {
  version: 4;
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

// ---- v4-multi crypto helpers (Phase 5) ----

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
function wrapVekV4(mek: Uint8Array, vek: Uint8Array): WrappedVekV4 {
  if (mek.length !== MEK_LEN) throw new Error("wrapVekV4: bad MEK length");
  if (vek.length !== VEK_LEN) throw new Error("wrapVekV4: bad VEK length");
  const nonce = randomBytes(XCHACHA_NONCE_LEN);
  const cipher = xchacha20poly1305(mek, nonce);
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
function unwrapVekV4(mek: Uint8Array, wrapped: WrappedVekV4): Uint8Array {
  if (mek.length !== MEK_LEN) throw new Error("unwrapVekV4: bad MEK length");
  if (wrapped.aead !== AEAD_ID) {
    throw new Error(`unwrapVekV4: unexpected AEAD ${wrapped.aead}`);
  }
  const nonce = base64ToBytes(wrapped.nonce);
  const ct = base64ToBytes(wrapped.ciphertext);
  const cipher = xchacha20poly1305(mek, nonce);
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

/** Encrypt seed + mnemonic under a VEK. Each side gets a fresh nonce
 *  and its own HKDF sub-key. Inputs are not zeroed by this helper. */
function sealVaultEnvelopeV4(
  vek: Uint8Array,
  seed: Uint8Array,
  mnemonic: string,
): SealedSeedRecordV4 {
  if (seed.length !== SEED_LEN) {
    throw new Error(`sealVaultEnvelopeV4: seed must be ${SEED_LEN} bytes`);
  }
  if (mnemonic.length === 0) {
    throw new Error("sealVaultEnvelopeV4: mnemonic must be non-empty");
  }
  const { seedKey, mnemonicKey } = deriveSubKeysFromVekV4(vek);
  try {
    const seedNonce = randomBytes(XCHACHA_NONCE_LEN);
    const seedCt = xchacha20poly1305(seedKey, seedNonce).encrypt(seed);
    const mnNonce = randomBytes(XCHACHA_NONCE_LEN);
    const mnPlain = new TextEncoder().encode(mnemonic);
    const mnCt = xchacha20poly1305(mnemonicKey, mnNonce).encrypt(mnPlain);
    mnPlain.fill(0);
    return {
      seedNonce: bytesToBase64(seedNonce),
      seedCiphertext: bytesToBase64(seedCt),
      mnemonicNonce: bytesToBase64(mnNonce),
      mnemonicCiphertext: bytesToBase64(mnCt),
    };
  } finally {
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
): { seed: Uint8Array; mnemonic: string } {
  const { seedKey, mnemonicKey } = deriveSubKeysFromVekV4(vek);
  try {
    const seedNonce = base64ToBytes(env.seedNonce);
    const seedCt = base64ToBytes(env.seedCiphertext);
    const mnNonce = base64ToBytes(env.mnemonicNonce);
    const mnCt = base64ToBytes(env.mnemonicCiphertext);
    let seed: Uint8Array;
    let mnPlain: Uint8Array;
    try {
      seed = xchacha20poly1305(seedKey, seedNonce).decrypt(seedCt);
      mnPlain = xchacha20poly1305(mnemonicKey, mnNonce).decrypt(mnCt);
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

// ---- v4-multi container storage (Phase 5) ----

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
  if (typeof mk["m"] !== "number") return false;
  if (typeof mk["t"] !== "number") return false;
  if (typeof mk["p"] !== "number") return false;
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
    throw new Error("v4 vaults container is unrecognised — refusing to read");
  }
  // Phase 9 hotfix: normalise the per-vault passkey state back to the
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
      // Phase 9 hotfix — passkey BigInt normalisation
      let out = v.passkey
        ? { ...v, passkey: clonePasskeyState(v.passkey) }
        : v;
      // Phase 10 — SLH-DSA backup defensive read. The on-disk shape
      // is already plain JSON (no BigInts to recover), but pushing
      // every read through `cloneBackupForRead` strips unknown fields
      // + fails closed on a corrupt record (returns `null`, which
      // the read paths treat as "no backup configured"). The same
      // defence-in-depth posture as the Phase 9 passkey path.
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

async function saveVaultsContainerV4(
  container: VaultsContainerV4,
): Promise<void> {
  // Phase 9 hotfix: chrome.storage.local doesn't reliably preserve
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
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [VAULTS_CONTAINER_KEY_V4]: persistable },
      () => resolve(),
    );
  });
}

// ---- v4-multi migration (Phase 5) ----

/**
 * Opportunistic migration from the legacy single-vault entry
 * (mono.vault.v4) to the multi-vault container (mono.vaults.v4).
 *
 * Run lazily inside the unlock handler the first time after the Phase
 * 5 upgrade: the user enters their existing password (which decrypts
 * the legacy envelope) and the same password establishes the master
 * KDF params + wraps a fresh VEK that re-seals the legacy seed +
 * mnemonic.
 *
 * Returns the new container on successful migration; returns null if
 * no migration was needed (no legacy entry OR container already
 * present). Throws "wrong password" on legacy AEAD failure — same
 * error message {@link unlockV4} surfaces, so the caller does not need
 * special-case handling.
 *
 * Leaves the legacy entry in place as rollback safety. A later phase
 * removes it once the container path is mature.
 */
async function migrateLegacyToContainerV4(
  password: string,
): Promise<VaultsContainerV4 | null> {
  // Container already exists → no migration needed.
  const existing = await loadVaultsContainerV4();
  if (existing !== null) return null;

  // No legacy envelope → fresh install, nothing to migrate.
  const legacy = await loadVaultV4();
  if (legacy === null) return null;

  // Step 1: decrypt the legacy envelope using the single-vault DEK
  // path. This is the same code unlockV4 + exportMnemonicV4 run; we
  // duplicate the steps here rather than calling them so migration
  // does not have the side effect of mutating module-level `unlocked`.
  const legacySalt = base64ToBytes(legacy.kdfParams.salt);
  const legacyDek = await argon2idAsync(
    new TextEncoder().encode(password),
    legacySalt,
    {
      m: legacy.kdfParams.m,
      t: legacy.kdfParams.t,
      p: legacy.kdfParams.p,
      dkLen: ARGON2_DKLEN,
    },
  );
  const { seedKey: legacySeedKey, mnemonicKey: legacyMnemonicKey } =
    deriveSubKeys(legacyDek);
  legacyDek.fill(0);

  let legacySeed: Uint8Array;
  let legacyMnemonic: string;
  try {
    const seedCipher = xchacha20poly1305(
      legacySeedKey,
      base64ToBytes(legacy.nonce),
    );
    legacySeed = seedCipher.decrypt(base64ToBytes(legacy.ciphertext));
    const mnCipher = xchacha20poly1305(
      legacyMnemonicKey,
      base64ToBytes(legacy.mnemonicNonce),
    );
    const mnPlain = mnCipher.decrypt(base64ToBytes(legacy.mnemonicCiphertext));
    legacyMnemonic = new TextDecoder().decode(mnPlain);
    mnPlain.fill(0);
  } catch {
    throw new Error("wrong password");
  } finally {
    legacySeedKey.fill(0);
    legacyMnemonicKey.fill(0);
  }
  if (legacySeed.length !== SEED_LEN) {
    legacySeed.fill(0);
    throw new Error("legacy vault payload is not a 32-byte seed");
  }

  // Step 2: establish fresh masterKdf params + derive MEK from the
  // SAME password the user just used to unlock legacy.
  const masterKdf = generateMasterKdfParamsV4();
  const mek = await deriveMekV4(password, masterKdf);

  // Step 3: generate fresh VEK, wrap with MEK, seal seed+mnemonic.
  const vek = generateVekV4();
  let wrappedKey: WrappedVekV4;
  let envelope: SealedSeedRecordV4;
  try {
    wrappedKey = wrapVekV4(mek, vek);
    envelope = sealVaultEnvelopeV4(vek, legacySeed, legacyMnemonic);
  } finally {
    mek.fill(0);
    vek.fill(0);
    legacySeed.fill(0);
  }

  const record: VaultRecordV4 = {
    id: crypto.randomUUID(),
    label: "Vault 1",
    createdAt: Date.now(),
    wrappedKey,
    envelope,
    addr: legacy.addr,
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
  // NOTE: legacy `mono.vault.v4` entry is intentionally NOT removed
  // here — kept as one-release-cycle rollback safety per the Phase 5
  // plan. A later phase wipes it.
  return container;
}

// ---- v4-multi public API (Phase 5 Commit 2) ----

/** Summary projection over a VaultRecordV4 — what the popup needs to
 *  render the vault picker. Excludes the wrappedKey / envelope (key
 *  material stays inside the keystore).
 *
 *  Phase 8 added the multisig fields (`kind`, `signerCount`,
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

/** Wipe the multi-vault container from chrome.storage.local. Used by
 *  the Settings → Reset wallet path in conjunction with
 *  {@link wipeVaultV4} to remove both the legacy entry and the
 *  container. Also clears the unlocked + MEK cache. */
export async function wipeContainerV4(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove(VAULTS_CONTAINER_KEY_V4, () => resolve());
  });
  lockV4();
}

/** Internal: unwrap a vault's VEK, open its envelope, build the
 *  backend, return the unlocked-state record. Used by both
 *  {@link unlockContainerV4} and {@link selectActiveVaultV4} — both
 *  paths share the same "unwrap → open → instantiate" pipeline. */
async function loadVaultBackend(
  mek: Uint8Array,
  vault: VaultRecordV4,
): Promise<UnlockedState> {
  const vek = unwrapVekV4(mek, vault.wrappedKey);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, vault.envelope);
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
 * Container-aware unlock. Runs migration from the legacy
 * `mono.vault.v4` envelope opportunistically if no container exists
 * yet, then derives the MEK from the master password, unwraps the
 * active vault's VEK, opens the envelope, and loads the backend.
 *
 * Throws `"wrong password"` on AEAD failure at any step. Same error
 * contract as {@link unlockV4}; the dispatcher's rate-limit handling
 * applies identically.
 *
 * Caches the derived MEK in module state for the unlock session so
 * subsequent {@link selectActiveVaultV4} / {@link addVaultFreshV4} /
 * {@link addVaultImportV4} calls skip Argon2id.
 */
export async function unlockContainerV4(
  password: string,
): Promise<{ address: string; vaultId: string }> {
  let container = await loadVaultsContainerV4();
  if (!container) {
    container = await migrateLegacyToContainerV4(password);
  }
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
  unlocked = state;
  activeContainerVaultId = active.id;
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
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const target = container.vaults.find((v) => v.id === vaultId);
  if (!target) throw new Error("unknown vault id");
  // No-op fast path: already the active vault.
  if (vaultId === activeContainerVaultId && unlocked) {
    return { address: unlocked.address };
  }
  const state = await loadVaultBackend(mekCache, target);
  container.activeVaultId = vaultId;
  await saveVaultsContainerV4(container);
  unlocked = state;
  activeContainerVaultId = vaultId;
  return { address: state.address };
}

/** Read-only list of vault summaries. No unlock required — labels and
 *  addresses are non-sensitive metadata. Returns `null` when no
 *  container exists (so the popup can branch on "still single-vault
 *  legacy" during the migration window).
 *
 *  Phase 8 — the multisig summary fields are populated from the
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
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const target = container.vaults.find((v) => v.id === vaultId);
  if (!target) throw new Error("unknown vault id");
  target.label = trimmed;
  await saveVaultsContainerV4(container);
}

/** Generate a fresh PQM-1 mnemonic and add a new vault to the
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
  const mnemonic = generatePqm1Mnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
  try {
    return await appendVaultRecord(mekCache, seed, mnemonic, label);
  } finally {
    seed.fill(0);
  }
}

/** Import a user-supplied PQM-1 mnemonic and add it to the container.
 *  Requires the container to be unlocked. Rejects if the derived
 *  address already matches a vault in the container (duplicate seed).
 *  See {@link addVaultFreshV4} for label semantics. */
export async function addVaultImportV4(
  mnemonic: string,
  label?: string,
): Promise<{ vaultId: string; address: string }> {
  if (!mekCache) throw new Error("container is locked");
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
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
 *  Whitepaper §28.5 Q70 — N up to {@link MAX_SIGNERS} (16); threshold
 *  in [1, N]. The wallet enforces the policy at the IPC boundary;
 *  chain enforcement is a GAP (`TODO: chain GAP — needs Nayiem`),
 *  see shared/multisig.ts module doc-block for the off-chain story.
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

  const mnemonic = generatePqm1Mnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
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
  const vek = unwrapVekV4(mekCache, v.wrappedKey);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, v.envelope);
    seed = opened.seed;
  } finally {
    vek.fill(0);
  }
  try {
    const backend = MlDsa65Backend.fromSeed(seed);
    return backend.signPrehash(digest);
  } finally {
    seed.fill(0);
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
  const vek = unwrapVekV4(mekCache, v.wrappedKey);
  let seed: Uint8Array;
  try {
    const opened = openVaultEnvelopeV4(vek, v.envelope);
    seed = opened.seed;
  } finally {
    vek.fill(0);
  }
  try {
    const backend = MlDsa65Backend.fromSeed(seed);
    return "0x" + bytesToHex(backend.publicKey());
  } finally {
    seed.fill(0);
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
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  if (v.kind !== "multisig") {
    throw new Error("target vault is not a multisig vault");
  }
  validateThreshold(meta.threshold, meta.signers.length);
  assertSignerSetUnique(meta.signers);
  v.multisig = cloneMultisigMeta(meta);
  await saveVaultsContainerV4(container);
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
    governance: meta.governance.map((g) => ({
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

// ---- Passkey per-vault state (Phase 9) ----

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
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  const current = v.passkey ?? emptyVaultPasskeyState();
  const next = appendCredential(current, cred);
  v.passkey = clonePasskeyState(next);
  await saveVaultsContainerV4(container);
  return clonePasskeyState(next);
}

/** Remove a credential by id. No-op if absent. Auto-disables the
 *  policy when the last credential is removed (shared helper handles
 *  that). */
export async function removePasskeyCredentialV4(
  vaultId: string,
  credentialId: string,
): Promise<VaultPasskeyState> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  const current = v.passkey ?? emptyVaultPasskeyState();
  const next = removePasskeyCredential(current, credentialId);
  v.passkey = clonePasskeyState(next);
  await saveVaultsContainerV4(container);
  return clonePasskeyState(next);
}

/** Replace the policy. Validation runs inside `setPolicy` — bad input
 *  throws without persisting. */
export async function setPasskeyPolicyV4(
  vaultId: string,
  policy: PasskeyPolicy,
): Promise<VaultPasskeyState> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  const current = v.passkey ?? emptyVaultPasskeyState();
  const next = setPasskeyPolicy(current, policy);
  v.passkey = clonePasskeyState(next);
  await saveVaultsContainerV4(container);
  return clonePasskeyState(next);
}

// ---- Phase 10 SLH-DSA backup CRUD ----
//
// The keygen + secret-key encryption lives in
// `src/background/slh-dsa-keygen.ts` (Phase 10 Commit 2). These
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
 *  keygen path (Commit 2) — by the time we get here the secret key
 *  has already been VEK-wrapped + the user has gone through the
 *  reveal-modal flow. Throws on unknown vault id; the caller never
 *  catches it because the only call site is the SW IPC handler
 *  which surfaces the throw as a typed error. */
export async function writeSlhDsaBackupV4(
  vaultId: string,
  backup: SlhDsaBackup,
): Promise<SlhDsaBackup> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v) throw new Error("unknown vault id");
  v.slhDsaBackup = cloneBackupForWrite(backup);
  await saveVaultsContainerV4(container);
  // Return through the read clone so the caller always gets a
  // fresh object (defensive against future mutation by callers
  // that capture the reference).
  return cloneBackupForRead(v.slhDsaBackup) ?? backup;
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
  const container = await loadVaultsContainerV4();
  if (!container) return false;
  const v = container.vaults.find((rec) => rec.id === vaultId);
  if (!v || !v.slhDsaBackup) return false;
  delete v.slhDsaBackup;
  await saveVaultsContainerV4(container);
  return true;
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
  const vek = unwrapVekV4(mekCache, v.wrappedKey);
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

  const vek = unwrapVekV4(mekCache, v.wrappedKey);
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
}

/** Defensive copy so callers can't mutate stored state by holding a
 *  reference to the returned record.
 *
 *  Phase 9 hotfix: also tolerates the JSON-safe form policy may be in
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
 *  `"Vault N"` (where N is the post-append vault count) when the
 *  caller passes no label. Optional `extra` block attaches multisig
 *  metadata for the multisig path. */
async function appendVaultRecord(
  mek: Uint8Array,
  seed: Uint8Array,
  mnemonic: string,
  requestedLabel?: string,
  extra?: { kind: "single" | "multisig"; multisig?: MultisigVaultMeta },
): Promise<{ vaultId: string; mnemonic: string; address: string }> {
  const container = await loadVaultsContainerV4();
  if (!container) throw new Error("no v4 vaults container");
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
    label = `Vault ${container.vaults.length + 1}`;
  }
  const vek = generateVekV4();
  let wrappedKey: WrappedVekV4;
  let envelope: SealedSeedRecordV4;
  try {
    wrappedKey = wrapVekV4(mek, vek);
    envelope = sealVaultEnvelopeV4(vek, seed, mnemonic);
  } finally {
    vek.fill(0);
  }
  const record: VaultRecordV4 = {
    id: crypto.randomUUID(),
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
  await saveVaultsContainerV4(container);
  return { vaultId: record.id, mnemonic, address };
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
 * but releasing the reference makes it eligible for GC.
 *
 * Also zeros + drops the cached MEK and forgets the active vault id (Phase
 * 5 multi-vault state). After lock, any vault-switch or vault-add call
 * fails until the user re-unlocks the container. */
export function lockV4(): void {
  unlocked = null;
  if (mekCache) {
    mekCache.fill(0);
    mekCache = null;
  }
  activeContainerVaultId = null;
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

// ---- test-only exports (Phase 5) ----
//
// Mirrors the `__internal` pattern in keystore.ts — lets the vitest
// suite reach into the multi-vault helpers without exposing them on
// the public module API surface.
export const __internalV4Multi = {
  VAULTS_CONTAINER_KEY_V4,
  generateMasterKdfParamsV4,
  deriveMekV4,
  generateVekV4,
  wrapVekV4,
  unwrapVekV4,
  sealVaultEnvelopeV4,
  openVaultEnvelopeV4,
  isVaultsContainerV4,
  loadVaultsContainerV4,
  saveVaultsContainerV4,
  migrateLegacyToContainerV4,
};
