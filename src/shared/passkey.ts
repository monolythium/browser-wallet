// Passkey policy types + pure helpers (§28.5 Q30 + Q31).
//
// What this module owns
// =====================
// Pure types + algorithms for the wallet's passkey policy surface. No
// `chrome.storage`, no `navigator.credentials`, no module-scope state —
// every helper here is deterministic and testable in vitest without
// browser shims. The storage round-trip lives in keystore-mldsa.ts
// (the policy persists inside the per-vault record alongside the
// existing envelope); the WebAuthn IPC dispatch lives in
// service-worker.ts; the UI lives in popup/.
//
// On-chain reality
// ===========================================
// mono-core @ce93d83 has NO passkey precompile. The chain SDK
// (`mono-core-sdk @0fd8a79`) exposes a `WebAuthnP256` algorithm tag in
// `StandardAlgo`, but the implementation is a WASM-primary stub that
// returns `NoInteractiveContext` on every native call — there is no
// production signing path, and the chain's transaction admission
// (`crates/boundary/mempool/src/admission.rs:164`) explicitly rejects
// every classical signature payload including WebAuthn. Today the
// chain accepts ML-DSA-65 only.
//
// Consequence: the passkey is a **local unlock gate** for the
// primary ML-DSA-65 vault key. WebAuthn's `navigator.credentials.get()`
// signs over a challenge derived from the proposal hash; if the
// authenticator asserts successfully the wallet decrypts the vault's
// VEK in-memory for the duration of one signing operation. The
// primary ML-DSA-65 key still signs the actual transaction. The
// passkey does NOT replace the ML-DSA-65 signature on chain.
//
// Upgrade path: when the chain ships a passkey precompile (likely
// `0x110x` block, post-mainnet research), the wallet can evolve to
// dual-signing — passkey assertion + ML-DSA-65 signature both go on
// chain, the chain precompile verifies both. The persistent shape
// here (`PasskeyCredential.credentialId` etc.) is already what that
// future path needs.
//
// Whitepaper alignment
// ====================
// §28.5 Q30 — default passkey limit ~$500 per tx, user-configurable.
// §28.5 Q31 — passkey unlocks signing for txs under the limit; primary
//             key (password unlock) required above the limit. v1 enforces
//             the per-tx/daily cap LOCALLY at the SW signing boundary
//             (wallet-send-tx) for value-only transfers, as defense-in-
//             depth: an over-limit send is rejected unless an SW-VERIFIED
//             password re-auth is supplied. This is NOT cryptographic
//             passkey authorization and there is NO chain-side enforcement
//             until the chain ships a passkey precompile.
// §28.5     — single binary, multisig + passkey + two-tier UX coexist
//             on one wallet; passkey is per-vault metadata.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { LYTHOSHI_PER_LYTH } from "@monolythium/core-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/** Hard cap on registered credentials per vault. Picks the practical
 *  upper bound — a user with a Windows Hello + Touch ID + YubiKey + a
 *  laptop's TPM passkey is at 4 already; 8 leaves headroom without
 *  bloating the per-vault record. */
export const MAX_CREDENTIALS_PER_VAULT = 8;

/** WebAuthn user-verification policy for register (`create()`) AND sign
 *  (`get()`) — both call sites read this single constant so the policy can't
 *  drift between them (P6-001/P6-004). "required" forces the authenticator to
 *  actually perform user verification (biometric / PIN) and to FAIL if it
 *  can't; "preferred" lets an authenticator silently skip it, so a key that
 *  auto-asserts (e.g. an evil-maid-spoofed or mis-provisioned authenticator)
 *  could satisfy the gate with no real user-presence check. The passkey is a
 *  local unlock gate for the ML-DSA-65 key, so a real UV check is the point. */
export const PASSKEY_USER_VERIFICATION: UserVerificationRequirement = "required";

/** Native LYTH precision sourced from the SDK (single source of truth). Chain
 *  migrated 8 → 18 decimals (1 lythoshi == 1 wei); SDK 0.3.15 carries
 *  `LYTHOSHI_PER_LYTH = 10^18`. Re-exported so existing importers keep
 *  resolving it from here. All passkey limits below are LYTH-denominated
 *  (`Nn * LYTHOSHI_PER_LYTH`), so they retain the same LYTH magnitude. */
export { LYTHOSHI_PER_LYTH };

/** Default per-tx passkey limit, in lythoshi. §28.5 Q30 anchors this to
 *  "~$500"; in the absence of a LYTH/USD oracle in the wallet today
 *  (chain GAP), we hardcode 100 LYTH as a stand-in. The limit is
 *  user-configurable from the Security page.
 *
 *  100 LYTH = 100 * 1_000_000_000_000_000_000 lythoshi
 *
 *  Reasoning for 100 LYTH proxy: at testnet pricing (no public mainnet
 *  price yet) this is a comfortable median user spend — large enough
 *  that routine transfers don't constantly hit the cap, small enough
 *  that an attacker with passkey access (e.g. evil maid with thumbprint
 *  spoof) can drain at most this much per attempt. */
export const DEFAULT_PASSKEY_LIMIT_LYTHOSHI = 100n * LYTHOSHI_PER_LYTH;

/** Floor on the user-configurable passkey limit. 1 LYTH
 *  (1_000_000_000_000_000_000 lythoshi) — below this, passkey unlock is too narrow
 *  to be useful. */
export const MIN_PASSKEY_LIMIT_LYTHOSHI = LYTHOSHI_PER_LYTH;

/** Ceiling on the user-configurable passkey limit. 10_000 LYTH —
 *  above this, the passkey-unlock path stops being a "small-value
 *  fast unlock" and becomes an attacker-friendly bypass of password
 *  protection. The wallet caps the slider at this value. */
export const MAX_PASSKEY_LIMIT_LYTHOSHI = 10_000n * LYTHOSHI_PER_LYTH;

/** Default daily cap when `dailyCap` mode is enabled. 500 LYTH —
 *  five normal-sized txs at the default per-tx limit. */
export const DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI = 500n * LYTHOSHI_PER_LYTH;

/** Domain tag mixed into every passkey challenge hash. Keeps WebAuthn
 *  assertions over wallet challenges cryptographically separate from
 *  any other challenge the same authenticator might sign. */
const CHALLENGE_DOMAIN = "mono-wallet-passkey-v1";

// ────────────────────────────────────────────────────────────────────────────
// Authenticator metadata
// ────────────────────────────────────────────────────────────────────────────

/** Where the credential lives. Determines the UX the wallet shows
 *  ("Touch ID / Windows Hello" vs "Plug in your security key") and
 *  also informs the `authenticatorAttachment` field on `create()`.
 *
 *   - `"platform"`     — built-in authenticator: Windows Hello, Touch
 *                        ID, Android biometric. Most common; wallet
 *                        UX defaults to this on the register CTA.
 *   - `"cross-platform"` — roaming authenticator: YubiKey, Titan, etc.
 *                        Power-user / enterprise path.
 */
export type AuthenticatorKind = "platform" | "cross-platform";

/** One registered passkey credential. Stored inside the per-vault
 *  record (`VaultRecordV4.passkey.credentials[]`). The actual private
 *  key material lives in the browser's authenticator — the wallet
 *  only ever holds the public credential id + cosmetic metadata.
 *
 *  Shape rationale:
 *   - `credentialId` is a base64-encoded `ArrayBuffer` returned by
 *     `navigator.credentials.create()`. We pass it back as
 *     `allowCredentials[].id` on `.get()` so the authenticator knows
 *     which key to use.
 *   - `name` is user-editable ("Office YubiKey", "MacBook Touch ID").
 *     Defaults to a sensible label at register time.
 *   - `kind` lets the UX render the right affordance per credential.
 *   - `createdAt` for stable ordering in the credentials list. */
export interface PasskeyCredential {
  /** base64(rawId) — opaque to the wallet, meaningful only to the
   *  underlying authenticator. */
  credentialId: string;
  /** User-editable label. 1-64 chars after trim. */
  name: string;
  /** Authenticator class — drives UX. */
  kind: AuthenticatorKind;
  /** Date.now() at registration. */
  createdAt: number;
  /** base64url(SPKI DER) of the credential public key, captured at
   *  registration via `getPublicKey()`. REQUIRED for new credentials (the
   *  add-credential IPC rejects a new registration without it). Optional on
   *  the type because credentials persisted before this field existed read
   *  back without it; Option A's SW-verify (a later commit) detects that
   *  absence and routes the user to re-register. */
  publicKeySpki?: string;
  /** COSE algorithm id from `getPublicKeyAlgorithm()` — `-7` (ES256) or
   *  `-257` (RS256), the only registered algs. Absent on legacy creds. */
  alg?: number;
  /** Authenticator signature counter from the registration `authData`
   *  (big-endian u32). Absent on legacy creds; `0` when unavailable. */
  signCount?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Policy
// ────────────────────────────────────────────────────────────────────────────

/** Spending-limit enforcement mode for the passkey policy.
 *
 *   - `"per-tx"` — every transaction's native value is compared against
 *                  the configured limit. Simple, predictable; doesn't
 *                  catch the "drain via many small txs" pattern.
 *   - `"daily"`  — sum of all native values signed via passkey within a
 *                  rolling 24-hour window is compared against the daily
 *                  cap. Catches the drain-via-many-small case but requires
 *                  the wallet to maintain a usage ledger.
 *
 *  Both modes coexist on the same policy record. The active mode
 *  drives which threshold the IPC boundary checks; the inactive
 *  threshold is preserved so the user can flip back without re-typing. */
export type PolicyMode = "per-tx" | "daily";

/** Persisted policy. Lives inside `VaultRecordV4.passkey.policy`.
 *  Absent on legacy vaults — treated as `{ enabled: false }` by every
 *  read path. */
export interface PasskeyPolicy {
  /** Whether the policy gates signing at all. When `false`, every
   *  tx requires password unlock as in pre-Phase-9 builds. */
  enabled: boolean;
  /** Active enforcement mode. */
  mode: PolicyMode;
  /** Per-tx threshold in lythoshi. Field name is retained for IPC/storage. */
  limitWei: bigint;
  /** Daily total threshold in lythoshi. Field name is retained for IPC/storage. */
  dailyCapWei: bigint;
}

/** Fresh policy at registration time — disabled by default with sane
 *  defaults populated. Caller can flip `enabled: true` after the user
 *  registers their first credential. */
export function defaultPasskeyPolicy(): PasskeyPolicy {
  return {
    enabled: false,
    mode: "per-tx",
    limitWei: DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
    dailyCapWei: DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
  };
}

/** Per-vault passkey container — what `VaultRecordV4.passkey` holds. */
export interface VaultPasskeyState {
  credentials: PasskeyCredential[];
  policy: PasskeyPolicy;
}

/** Fresh state for a vault that has no passkey configured yet. */
export function emptyVaultPasskeyState(): VaultPasskeyState {
  return { credentials: [], policy: defaultPasskeyPolicy() };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

export type PolicyValidationError =
  | "limit-below-floor"
  | "limit-above-ceiling"
  | "daily-cap-below-floor"
  | "daily-cap-above-ceiling"
  | "daily-cap-below-per-tx";

/** Reject bogus user input on policy authoring. Returns `null` if
 *  the policy is well-formed, otherwise the specific reason — the UI
 *  uses that to render a targeted error. */
export function validatePasskeyPolicy(
  p: PasskeyPolicy,
): PolicyValidationError | null {
  if (p.limitWei < MIN_PASSKEY_LIMIT_LYTHOSHI) return "limit-below-floor";
  if (p.limitWei > MAX_PASSKEY_LIMIT_LYTHOSHI) return "limit-above-ceiling";
  if (p.dailyCapWei < MIN_PASSKEY_LIMIT_LYTHOSHI) return "daily-cap-below-floor";
  if (p.dailyCapWei > MAX_PASSKEY_LIMIT_LYTHOSHI) return "daily-cap-above-ceiling";
  // A daily cap below the per-tx limit is internally inconsistent —
  // a single tx at the per-tx limit would already exceed the daily cap.
  if (p.dailyCapWei < p.limitWei) return "daily-cap-below-per-tx";
  return null;
}

export function validateCredentialName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

// ────────────────────────────────────────────────────────────────────────────
// Policy enforcement at the IPC boundary
// ────────────────────────────────────────────────────────────────────────────

/** Result of evaluating a tx against the passkey policy. */
export type PolicyDecision =
  /** Policy allows passkey unlock for this tx. */
  | { kind: "passkey-ok" }
  /** Policy is disabled or no credential registered — fall back to
   *  the existing password unlock path. */
  | { kind: "password-required"; reason: "disabled" | "no-credential" }
  /** Tx value exceeds the configured threshold — password unlock
   *  required. `threshold` is what the UI surfaces in the explainer. */
  | {
      kind: "over-limit";
      mode: PolicyMode;
      threshold: bigint;
      attempted: bigint;
    };

/** Per-vault running ledger for `"daily"` mode. The wallet appends
 *  one entry per passkey-unlocked tx; entries older than 24h are
 *  pruned before each evaluation. Kept tiny by design — a daily-cap
 *  setting with many entries is itself a smell. */
export interface PasskeyUsageEntry {
  /** Date.now() at signing time. */
  at: number;
  /** Tx native value in lythoshi. Field name is retained for IPC callers. */
  valueWei: bigint;
}

/** Window over which the daily cap is summed. 24 hours, sliding. */
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Drop entries outside the sliding window. Pure; caller persists. */
export function pruneUsage(
  entries: ReadonlyArray<PasskeyUsageEntry>,
  now: number,
): PasskeyUsageEntry[] {
  const cutoff = now - DAILY_CAP_WINDOW_MS;
  return entries.filter((e) => e.at >= cutoff);
}

/** Sum the in-window usage. */
export function sumUsage(entries: ReadonlyArray<PasskeyUsageEntry>): bigint {
  let acc = 0n;
  for (const e of entries) acc += e.valueWei;
  return acc;
}

/** The core IPC-boundary decision: given a tx value and the current
 *  policy + credentials + recent usage, decide whether passkey unlock
 *  is acceptable, or password unlock is required.
 *
 *  Caller passes `now` so tests can pin time. */
export function evaluatePolicy(args: {
  state: VaultPasskeyState;
  /** Native tx value in lythoshi. Field name remains `valueWei` at IPC. */
  valueWei: bigint;
  recentUsage: ReadonlyArray<PasskeyUsageEntry>;
  now: number;
}): PolicyDecision {
  const { state, valueWei, recentUsage, now } = args;
  if (!state.policy.enabled) {
    return { kind: "password-required", reason: "disabled" };
  }
  if (state.credentials.length === 0) {
    return { kind: "password-required", reason: "no-credential" };
  }
  if (state.policy.mode === "per-tx") {
    if (valueWei > state.policy.limitWei) {
      return {
        kind: "over-limit",
        mode: "per-tx",
        threshold: state.policy.limitWei,
        attempted: valueWei,
      };
    }
    return { kind: "passkey-ok" };
  }
  // daily mode
  const pruned = pruneUsage(recentUsage, now);
  const used = sumUsage(pruned);
  const projected = used + valueWei;
  if (projected > state.policy.dailyCapWei) {
    return {
      kind: "over-limit",
      mode: "daily",
      threshold: state.policy.dailyCapWei,
      attempted: projected,
    };
  }
  return { kind: "passkey-ok" };
}

// ────────────────────────────────────────────────────────────────────────────
// Challenge construction
// ────────────────────────────────────────────────────────────────────────────

/** Deterministic challenge for `navigator.credentials.get()`.
 *
 *  Binding the challenge to the tx hash + a domain tag means:
 *   - A successful assertion cannot be replayed against an
 *     unrelated tx (same authenticator, different challenge).
 *   - A captured assertion from another wallet's WebAuthn use
 *     cannot be replayed here (different domain tag).
 *
 *  Returns a 32-byte buffer suitable for the WebAuthn `challenge`
 *  field (`BufferSource`). When `txHash` is `null` (the unlock-only
 *  flavour for registration / future no-tx contexts) the challenge
 *  is `H(domain || timestamp_bytes)` — still unique-per-call so
 *  authenticators with replay defenses are happy. */
export function buildPasskeyChallenge(
  txHash: Uint8Array | null,
  nonce: Uint8Array,
): Uint8Array {
  // Domain bytes are first so a prefix-injection over txHash cannot
  // collide with a different domain.
  const domain = new TextEncoder().encode(CHALLENGE_DOMAIN);
  const txBytes = txHash ?? new Uint8Array(0);
  const buf = new Uint8Array(domain.length + txBytes.length + nonce.length);
  buf.set(domain, 0);
  buf.set(txBytes, domain.length);
  buf.set(nonce, domain.length + txBytes.length);
  return keccak_256(buf);
}

// ────────────────────────────────────────────────────────────────────────────
// Vault-state mutations (pure)
// ────────────────────────────────────────────────────────────────────────────

/** Append a fresh credential to a vault's passkey state. Returns the
 *  new state without touching the input. Rejects with a typed
 *  Error if the credential cap is hit or the name is invalid. */
export function appendCredential(
  state: VaultPasskeyState,
  cred: PasskeyCredential,
): VaultPasskeyState {
  if (!validateCredentialName(cred.name)) {
    throw new Error("invalid credential name");
  }
  if (state.credentials.length >= MAX_CREDENTIALS_PER_VAULT) {
    throw new Error("credential cap reached");
  }
  if (state.credentials.some((c) => c.credentialId === cred.credentialId)) {
    throw new Error("duplicate credentialId");
  }
  return {
    ...state,
    credentials: [...state.credentials, { ...cred, name: cred.name.trim() }],
  };
}

/** Remove a credential by id. No-op if not present. When the last
 *  credential goes away we also disable the policy — there's nothing
 *  to unlock with anymore, and silently leaving `enabled: true` would
 *  trip the `"no-credential"` decision on every signed tx. */
export function removeCredential(
  state: VaultPasskeyState,
  credentialId: string,
): VaultPasskeyState {
  const filtered = state.credentials.filter(
    (c) => c.credentialId !== credentialId,
  );
  if (filtered.length === state.credentials.length) return state;
  const nextPolicy =
    filtered.length === 0
      ? { ...state.policy, enabled: false }
      : state.policy;
  return { credentials: filtered, policy: nextPolicy };
}

/** Replace the entire policy. Validates first; throws on bad input
 *  rather than half-applying. */
export function setPolicy(
  state: VaultPasskeyState,
  next: PasskeyPolicy,
): VaultPasskeyState {
  const err = validatePasskeyPolicy(next);
  if (err) throw new Error(`invalid policy: ${err}`);
  return { ...state, policy: next };
}
