// Phase 10 — SLH-DSA emergency-backup data model + pure helpers
// (§30.1 + §21.7 + §28.5 emergency-key registration prompt).
//
// What this module owns
// =====================
// Pure types + algorithms for the wallet's emergency-backup-key surface.
// No `chrome.storage`, no `@noble/post-quantum`, no module-scope state —
// every helper here is deterministic and testable in vitest. The
// keygen + chrome.storage round-trip lives in src/background/
// slh-dsa-keygen.ts (Phase 10 Commit 2); the IPC dispatch lives in
// service-worker.ts; the UI lives in popup/.
//
// CHAIN GAP TRACKER
// =================
// 1. PQM-1 SLH-DSA derivation branch — NOT canonicalized in
//    mono-core or mono-core-sdk @0fd8a79. Only
//    `PQM1_V1_MLDSA65_DOMAIN_TAG = "monolythium.pqm1.v1.mldsa65"`
//    exists. The wallet adopts a wallet-side domain tag
//    `"monolythium.slh-dsa-backup.v1"` for SHAKE256 expansion from
//    32-byte BIP-39 entropy → 48-byte SLH-DSA seed. If Nayiem
//    canonicalizes a chain-side PQM-1 SLH-DSA branch later, this
//    derivation can flip to that path without breaking existing
//    on-chain registrations (the registered public key remains
//    valid regardless of how the wallet recovered it).
//    `// TODO: chain GAP — needs Nayiem`
// 2. Sprintnet operational endpoint availability — separate from the
//    precompile being live. The precompile itself is live and
//    non-gateable per `mono-core/crates/core/runtime/src/precompiles.rs:43`.
//    Phase 10 wires registration; if the Sprintnet RPC is offline at
//    user attempt-time, the IPC surfaces a typed error.
//    `// TODO: chain GAP — operational, not feature`
//
// Chain-side investigation findings (verified 2026-05-16)
// =======================================================
// Source: `mono-core` HEAD `ce93d83`, crate
// `crates/precompiles/system/emergency-key-registry/`.
//
//  - Precompile address: `0x1100` (`EMERGENCY_KEY_REGISTRY_ADDRESS`).
//    Lives in the `0x1100..=0x1102` extension band (emergency-key,
//    VRF, streaming-payments). Mirrored in
//    `mono-core-sdk/crates/core-sdk/src/consts.rs::EMERGENCY_KEY`.
//
//  - Algo id for SLH-DSA-SHA2-128s: `1101` (`u16`, the
//    `StandardAlgo::SlhDsaSha2_128s` numeric value).
//
//  - Pubkey length: 32 bytes (FIPS 205 n=16, pubkey = 2*n).
//
//  - Register selector: `register(uint16,bytes)` — Solidity ABI
//    encoded `(algo_id, pubkey)`. Caller is the registering account.
//    Reverts `AlreadyRegistered` on second attempt (one-time per
//    address). `lookup(address) -> (uint16, bytes, uint64)` and
//    `hasEmergencyKey(address) -> bool` are the view paths.
//
//  - Family eligibility (Whitepaper §2.9): only `HashOnly` family algos
//    are accepted as backups; lattice algos (ML-DSA, Falcon, Hybrid)
//    are rejected with `AlgoSameFamily`. Classical algos (secp256k1,
//    Ed25519, BLS, WebAuthn) are rejected with `UnsupportedAlgo`.
//    SLH-DSA-SHA2-128s is the only currently-eligible variant.
//
// `@noble/post-quantum @0.6.1` is already a direct dependency
// (Phase 8 multisig); we reuse it for `slh_dsa_sha2_128s` instead of
// adding a new crypto dep.

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/** Chain-side numeric `StandardAlgo` id for SLH-DSA-SHA2-128s.
 *  Per `mono-core/crates/precompiles/system/emergency-key-registry/
 *  src/validate.rs` — `validate_register_input(1101, ..)` is the
 *  only currently-accepted backup-algo arm. */
export const SLH_DSA_SHA2_128S_ALGO_ID = 1101;

/** Emergency-key precompile address. Lives at the start of the
 *  `0x1100..=0x1102` extension band. Mirrors
 *  `mono-core-sdk` `consts::precompiles::EMERGENCY_KEY`. */
export const EMERGENCY_KEY_PRECOMPILE_ADDRESS =
  "0x0000000000000000000000000000000000001100";

/** Per-variant byte lengths sourced from FIPS 205 + verified against
 *  `@noble/post-quantum @0.6.1` `slh-dsa.d.ts` table comments. Pin
 *  here so any future variant addition (192s, 256s, ...) lands as a
 *  data change rather than a scattered grep. */
export const SLH_DSA_SHA2_128S_LENGTHS = {
  /** Public key — exactly the byte length the chain's `register`
   *  selector validates against (`validate.rs::WrongPubkeyLength`). */
  publicKey: 32,
  /** Secret key — stored locally encrypted via the vault's VEK. */
  secretKey: 64,
  /** Signature size — large by design; ~17 KB on the 's' (small,
   *  slow-signing) variant. Documented for the rotation-flow
   *  rehearsal UX. */
  signature: 17088,
  /** Keygen seed length. Noble's `slh_dsa_sha2_128s.keygen(seed)`
   *  accepts exactly this many bytes. We feed it the SHAKE256-
   *  expansion of the 32-byte BIP-39 entropy. */
  seed: 48,
  /** Signing-randomness length. Used only at rotation-flow time. */
  signRand: 16,
} as const;

/** SHAKE256 domain tag used by the wallet to expand 32-byte BIP-39
 *  entropy into the 48-byte SLH-DSA-SHA2-128s keygen seed.
 *
 *  Wallet-side ONLY — the chain has not canonicalized a PQM-1 branch
 *  for SLH-DSA derivation (see CHAIN GAP TRACKER above). Domain-
 *  separated from PQM-1 ML-DSA (`monolythium.pqm1.v1.mldsa65`) so a
 *  future chain-canonicalized branch cannot collide. */
export const SLH_DSA_BACKUP_DOMAIN_TAG = "monolythium.slh-dsa-backup.v1";

/** Hint-bar default re-surface cadence. After "Dismiss for now",
 *  the bar suppresses for this many ms before reappearing. The
 *  user can also pick "Never show again" to suppress permanently. */
export const HINT_BAR_RESURFACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ────────────────────────────────────────────────────────────────────────────
// Backup state — the canonical typed shape persisted into VaultRecordV4
// ────────────────────────────────────────────────────────────────────────────

/** Variant tag for the backup's chosen parameter set. v1 only ships
 *  the chain-eligible variant; widening means adding chain-side
 *  family-table entries first (`validate.rs::is_eligible_backup_algo`). */
export type SlhDsaParameterSet = "slh_dsa_sha2_128s";

/** Chain-registration status. Tracked per vault so the UI can render
 *  the right CTA without re-querying the chain on every popup open.
 *
 *   - `not-registered`   — wallet has locally generated the keypair
 *                          but has not yet submitted the on-chain
 *                          `register(uint16, bytes)` precompile call.
 *   - `pending`          — registration tx submitted; awaiting block
 *                          inclusion. Includes the tx hash so the
 *                          UI can poll / link to Monoscan.
 *   - `registered`       — chain accepted the registration. Final
 *                          state — the precompile is one-time per
 *                          address (re-attempts revert).
 *   - `registration-failed` — submission errored. Includes the chain
 *                          reason verbatim (e.g. `AlreadyRegistered`,
 *                          `WrongPubkeyLength`, RPC offline). User
 *                          can retry from the Security page. */
export type BackupRegistrationStatus =
  | "not-registered"
  | "pending"
  | "registered"
  | "registration-failed";

/** Per-vault backup record. Lives inside `VaultRecordV4.slhDsaBackup`,
 *  absent on vaults that haven't generated a backup yet.
 *
 *  Storage discipline (Phase 9 hotfix learnings):
 *   - Numeric fields are plain `number` — no BigInt anywhere in this
 *     shape, so chrome.storage round-trip is JSON-safe out of the box.
 *   - `encryptedPrivateKey` is the VEK-wrapped 64-byte secret key,
 *     base64-encoded. Never decrypted unless the user opens the
 *     re-export flow with password unlock.
 *   - `publicKey` is the canonical 32-byte pubkey, hex-encoded
 *     (`0x`-less, lowercase). Public by design — readable for
 *     display + chain registration without a vault unlock. */
export interface SlhDsaBackup {
  /** XChaCha20-Poly1305 ciphertext of the 64-byte SLH-DSA secret
   *  key, sealed with the same VEK that protects the primary
   *  ML-DSA-65 envelope. base64. */
  encryptedPrivateKey: string;
  /** Per-record XChaCha20 nonce (24 bytes), base64. Distinct from
   *  the primary envelope's nonce — each AEAD slot owns its own. */
  encryptedPrivateKeyNonce: string;
  /** XChaCha20-Poly1305 ciphertext of the 32-byte BIP-39 entropy
   *  the user backed up as a 24-word mnemonic. Sealed under the
   *  same VEK + a fresh nonce. Lets the Settings → Security
   *  "Re-export backup" flow re-derive the mnemonic on demand
   *  (password unlock → VEK → decrypt → SHAKE256-expand →
   *  entropyToMnemonic). Without this field, re-export would have
   *  to generate a fresh keypair (which would invalidate any
   *  prior on-chain registration since the precompile is one-time
   *  per address). base64. */
  encryptedEntropy: string;
  /** Per-record XChaCha20 nonce (24 bytes) for the entropy slot,
   *  base64. */
  encryptedEntropyNonce: string;
  /** SLH-DSA-SHA2-128s public key. Hex, lowercase, no `0x` prefix.
   *  32 bytes. Public — does not require a vault unlock to read. */
  publicKey: string;
  /** Parameter-set discriminant. v1 only ships the one chain-
   *  eligible variant; the field is here so a future variant can
   *  land as data without breaking older records. */
  parameterSet: SlhDsaParameterSet;
  /** Chain-registration lifecycle. See [`BackupRegistrationStatus`]. */
  chainRegistrationStatus: BackupRegistrationStatus;
  /** Tx hash, populated when status is `pending` or `registered`. */
  chainRegistrationTxHash?: string;
  /** Block number at which the chain recorded the registration.
   *  Populated when status is `registered`. Surfaces in Settings →
   *  Security as "Registered at block N". */
  chainRegistrationBlock?: number;
  /** Chain-side error message verbatim, populated when status is
   *  `registration-failed`. Cleared when the user re-attempts. */
  chainRegistrationError?: string;
  /** User-attested via the reveal modal's "I have written this down"
   *  checkbox. Gates the "Register on-chain" CTA — the wallet
   *  refuses to register on chain until the user confirms the
   *  cold-storage backup exists. */
  coldStorageConfirmed: boolean;
  /** `Date.now()` at keygen. */
  createdAt: number;
}

/** Fresh placeholder used by every "is this vault backed up?" code
 *  path that needs a defined object to compare against. NOT
 *  persisted — read paths that find `vault.slhDsaBackup === undefined`
 *  treat the absence as "not set up" without materializing this. */
export function emptySlhDsaBackup(): SlhDsaBackup {
  return {
    encryptedPrivateKey: "",
    encryptedPrivateKeyNonce: "",
    encryptedEntropy: "",
    encryptedEntropyNonce: "",
    publicKey: "",
    parameterSet: "slh_dsa_sha2_128s",
    chainRegistrationStatus: "not-registered",
    coldStorageConfirmed: false,
    createdAt: 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

export type BackupValidationError =
  | "missing-fields"
  | "bad-public-key-length"
  | "bad-public-key-hex"
  | "bad-encrypted-key"
  | "bad-encrypted-key-nonce"
  | "bad-parameter-set"
  | "bad-status"
  | "bad-createdAt";

/** Reject corrupt or malformed backup records on the read path.
 *  Used by the storage round-trip helper to fail closed before a
 *  bad record can wedge the UI. Returns null on valid input. */
export function validateBackupShape(b: unknown): BackupValidationError | null {
  if (!b || typeof b !== "object") return "missing-fields";
  const r = b as Record<string, unknown>;
  if (typeof r.publicKey !== "string") return "missing-fields";
  if (typeof r.encryptedPrivateKey !== "string") return "missing-fields";
  if (typeof r.encryptedPrivateKeyNonce !== "string") return "missing-fields";
  if (typeof r.encryptedEntropy !== "string") return "missing-fields";
  if (typeof r.encryptedEntropyNonce !== "string") return "missing-fields";
  if (typeof r.parameterSet !== "string") return "missing-fields";
  if (typeof r.chainRegistrationStatus !== "string") return "missing-fields";
  if (typeof r.coldStorageConfirmed !== "boolean") return "missing-fields";
  if (typeof r.createdAt !== "number") return "bad-createdAt";

  if (r.parameterSet !== "slh_dsa_sha2_128s") return "bad-parameter-set";

  // 32-byte pubkey → 64 lowercase hex chars, no 0x prefix.
  if (!/^[0-9a-f]{64}$/.test(r.publicKey)) {
    if (r.publicKey === "") {
      // Empty pubkey is allowed only on the empty-placeholder shape
      // (createdAt === 0) — distinguishes "no backup yet" from
      // "real backup with corrupt pubkey".
      if (r.createdAt !== 0) return "bad-public-key-length";
    } else {
      return /^[0-9a-f]+$/.test(r.publicKey)
        ? "bad-public-key-length"
        : "bad-public-key-hex";
    }
  }

  const validStatuses: BackupRegistrationStatus[] = [
    "not-registered",
    "pending",
    "registered",
    "registration-failed",
  ];
  if (
    !validStatuses.includes(
      r.chainRegistrationStatus as BackupRegistrationStatus,
    )
  ) {
    return "bad-status";
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Storage serialization (Phase 9 hotfix discipline — JSON-safe always)
// ────────────────────────────────────────────────────────────────────────────

/** Defensive clone used at every read path that returns a backup to
 *  a caller. Strips any unrecognised fields, normalises types,
 *  fills in defaults for missing-but-required fields. Mirrors the
 *  Phase 9 `clonePasskeyState` discipline.
 *
 *  Returns `null` when the input is too broken to recover — the
 *  caller treats this as "no backup configured for this vault". */
export function cloneBackupForRead(raw: unknown): SlhDsaBackup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const err = validateBackupShape(r);
  if (err !== null) return null;
  return {
    encryptedPrivateKey: r.encryptedPrivateKey as string,
    encryptedPrivateKeyNonce: r.encryptedPrivateKeyNonce as string,
    encryptedEntropy: r.encryptedEntropy as string,
    encryptedEntropyNonce: r.encryptedEntropyNonce as string,
    publicKey: r.publicKey as string,
    parameterSet: "slh_dsa_sha2_128s",
    chainRegistrationStatus:
      r.chainRegistrationStatus as BackupRegistrationStatus,
    // Conditional spreads honour `exactOptionalPropertyTypes` — the
    // tsconfig has it enabled, so the optional fields must either be
    // present with a real value or absent entirely.
    ...(typeof r.chainRegistrationTxHash === "string"
      ? { chainRegistrationTxHash: r.chainRegistrationTxHash }
      : {}),
    ...(typeof r.chainRegistrationBlock === "number"
      ? { chainRegistrationBlock: r.chainRegistrationBlock }
      : {}),
    ...(typeof r.chainRegistrationError === "string"
      ? { chainRegistrationError: r.chainRegistrationError }
      : {}),
    coldStorageConfirmed: r.coldStorageConfirmed as boolean,
    createdAt: r.createdAt as number,
  };
}

/** Defensive clone before writing to chrome.storage. Plain-JSON
 *  shape — no BigInt, no Uint8Array, no Date object. Phase 9
 *  hotfix burned in the lesson: BigInt values do not survive
 *  chrome.storage round-trips on all Chrome builds. This shape is
 *  already plain JSON, but the clone is here so any future field
 *  addition has an obvious choke point to enforce the rule. */
export function cloneBackupForWrite(b: SlhDsaBackup): SlhDsaBackup {
  return {
    encryptedPrivateKey: b.encryptedPrivateKey,
    encryptedPrivateKeyNonce: b.encryptedPrivateKeyNonce,
    encryptedEntropy: b.encryptedEntropy,
    encryptedEntropyNonce: b.encryptedEntropyNonce,
    publicKey: b.publicKey,
    parameterSet: b.parameterSet,
    chainRegistrationStatus: b.chainRegistrationStatus,
    ...(b.chainRegistrationTxHash !== undefined
      ? { chainRegistrationTxHash: b.chainRegistrationTxHash }
      : {}),
    ...(b.chainRegistrationBlock !== undefined
      ? { chainRegistrationBlock: b.chainRegistrationBlock }
      : {}),
    ...(b.chainRegistrationError !== undefined
      ? { chainRegistrationError: b.chainRegistrationError }
      : {}),
    coldStorageConfirmed: b.coldStorageConfirmed,
    createdAt: b.createdAt,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// UI-state helpers (pure)
// ────────────────────────────────────────────────────────────────────────────

/** Compact label for the Security card + About surface. Used by
 *  every UI element that needs a one-line state badge. */
export function backupStatusLabel(b: SlhDsaBackup | null | undefined): string {
  if (!b || b.createdAt === 0) return "Not set up";
  switch (b.chainRegistrationStatus) {
    case "not-registered":
      return b.coldStorageConfirmed
        ? "Locally generated (not on chain)"
        : "Locally generated (backup not confirmed)";
    case "pending":
      return "Registering on chain…";
    case "registered":
      return "Chain registered";
    case "registration-failed":
      return "Registration failed — retry";
  }
}

/** True when the vault has a backup that we'd consider "complete":
 *  user has the cold-storage copy AND the chain has accepted the
 *  registration. Drives the About-page aggregate count + the hint
 *  bar's "should I surface?" check. */
export function isBackupComplete(
  b: SlhDsaBackup | null | undefined,
): boolean {
  return (
    b !== null &&
    b !== undefined &&
    b.createdAt > 0 &&
    b.coldStorageConfirmed &&
    b.chainRegistrationStatus === "registered"
  );
}

/** True when the vault has at least started the flow (key
 *  generated, possibly not registered yet). Drives the hint bar's
 *  suppression: if the user has started but not finished, we don't
 *  re-surface — they can resume from Settings → Security. */
export function hasBackupStarted(
  b: SlhDsaBackup | null | undefined,
): boolean {
  return b !== null && b !== undefined && b.createdAt > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Hex helpers — also useful in the popup tx-building path
// ────────────────────────────────────────────────────────────────────────────

/** Decode a stored hex pubkey back to raw 32 bytes. Used by the
 *  popup-side `bgSlhDsaBackupSubmitRegistration` orchestrator to
 *  feed the precompile's `bytes` argument. Validates length so a
 *  corrupt record can't slip past. Lives in this shared module
 *  (rather than the SW-side keygen module) so the popup can import
 *  it without pulling the heavy SW crypto graph. */
export function decodeBackupPublicKeyHex(hexPubkey: string): Uint8Array {
  if (typeof hexPubkey !== "string") {
    throw new Error("decodeBackupPublicKeyHex: input must be a string");
  }
  if (!/^[0-9a-f]*$/.test(hexPubkey)) {
    throw new Error("decodeBackupPublicKeyHex: non-hex characters");
  }
  if (hexPubkey.length !== SLH_DSA_SHA2_128S_LENGTHS.publicKey * 2) {
    throw new Error(
      `decodeBackupPublicKeyHex: ${hexPubkey.length / 2} bytes, want ${SLH_DSA_SHA2_128S_LENGTHS.publicKey}`,
    );
  }
  const out = new Uint8Array(SLH_DSA_SHA2_128S_LENGTHS.publicKey);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hexPubkey.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
