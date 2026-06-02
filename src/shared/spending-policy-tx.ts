// spending-policy-tx. Calldata encoders for the §18.8 spending-policy
// precompile (`0x110C`), plus a `buildSpendingPolicyArgs` form→args
// helper and the claim-bound-message composer.
//
// Mirrors the shape of `staking-tx.ts` (the canonical SDK-encoder
// wrapper module): import the chain-canonical SDK 0.3.10 encoders,
// re-export them under wallet-named thin wrappers, and pin them to the
// SDK output + chain selectors via `spending-policy-tx.test.ts` golden
// vectors.
//
// The §18.8 spending-policy precompile lets a managing PRINCIPAL bind a
// caps/allow-list policy to a controlled agent SUB-ACCOUNT. The
// fresh-claim path is a two-key dance:
//   1. The sub-account's OWN ML-DSA-65 key signs the bytes returned by
//      `composeClaimBoundMessage(chainId, args)` (domain-separated by
//      SET_POLICY_CLAIM_DOMAIN_TAG = "lyth.spending-policy.claim.v1").
//   2. The principal submits `encodeSetPolicyClaim(args, subPubkey,
//      subSig)` (selector 0x35531f6c) to 0x110C via `bgWalletSendTx`;
//      the principal's key signs the OUTER tx, the sub-account's pubkey
//      (1952 B) + signature (3309 B) ride inside the calldata.
// `encodeSetPolicyClaimCalldata` throws `SpendingPolicyError` when the
// pubkey/sig lengths are wrong — the wallet surfaces that verbatim
// rather than building a silently-rejected calldata.
//
// CRITICAL: this is the §18.8 CONSENSUS precompile path (0x110C). It is
// NOT the agent-actions 0x1003 forwarder
// (`encodeNativeAgentSetSpendingPolicyCall`) — that surface is a
// different ABI and a different precompile. §18.8 == spending-policy.ts
// only.
//
// The spending-policy precompile may be milestone-GATED on the live
// testnet (`lyth_listActivePrecompiles`). The wallet does not pre-empt
// that — it submits and surfaces whatever typed precompile-gate error
// the chain returns verbatim.

import {
  spendingPolicyAddressHex,
  encodeSetPolicyCalldata,
  encodeSetPolicyClaimCalldata,
  encodeClaimPolicyByAddressCalldata,
  encodeEnableCalldata,
  encodeDisableCalldata,
  composeClaimBoundMessage,
  packTimeWindow,
  decodeTimeWindow,
  type SpendingPolicyArgs,
} from "@monolythium/core-sdk";
import { NATIVE_LYTH_DECIMALS } from "@monolythium/core-sdk";
import { LYTHOSHI_PER_LYTH } from "./native-amount.js";

/** Spending-policy precompile address — Whitepaper §18.8
 *  (mono-core `SPENDING_POLICY_ADDRESS`, `0x110C`). Resolved from the
 *  SDK so the wallet and chain can never drift on the address. */
export const SPENDING_POLICY_PRECOMPILE = spendingPolicyAddressHex();

// Native LYTH decimal places sourced from the SDK (single source of truth).
// Chain migrated 8 → 18 decimals (1 lythoshi == 1 wei); SDK 0.3.15 carries
// `NATIVE_LYTH_DECIMALS = 18` and `1 LYTH = 10^18 lythoshi`.

/** Conservative execution-unit budget for the claim path. The calldata
 *  carries the sub-account's 1952-byte pubkey + 3309-byte signature
 *  (~5.3 KB of ABI words) on top of the policy dimensions, so the
 *  delegation-path budgets are far too small. The precompile's exact
 *  execution-unit cost is not measured on-chain yet
 *  (TODO(monolythium-vision): pin the spending-policy claim
 *  execution-unit cost once the precompile is metered) — this is a
 *  generous overhead-aware ceiling. */
export const SPENDING_POLICY_CLAIM_UNIT_LIMIT_HEX = "0x7A120"; // 500000

/** Conservative execution-unit budget for the enable/disable paths.
 *  Both carry only the 20-byte sub-account address — selector-sized. */
export const SPENDING_POLICY_TOGGLE_UNIT_LIMIT_HEX = "0x14820"; // 84000

/** Conservative execution-unit budget for the re-claim (`setPolicy`)
 *  path — policy dimensions, no embedded pubkey/sig. */
export const SPENDING_POLICY_SET_UNIT_LIMIT_HEX = "0x30D40"; // 200000

// ─────────────────────────────────────────────────────────────────────────────
// Method encoders (delegated to the chain-canonical SDK 0.3.10 encoders)
// ─────────────────────────────────────────────────────────────────────────────

/** `setPolicyClaim` calldata (chain-canonical selector `0x35531f6c`)
 *  for a FRESH sub-account whose ML-DSA-65 pubkey is not yet on-chain.
 *  `subAccountPubkey` must be 1952 bytes and `subAccountSig` 3309 bytes
 *  (the SDK throws `SpendingPolicyError` otherwise — surfaced verbatim).
 *  Returns a 0x-prefixed hex string ready for `bgWalletSendTx({ data })`,
 *  submitted to {@link SPENDING_POLICY_PRECOMPILE} with `value: 0x0`. */
export function encodeSetPolicyClaim(
  args: SpendingPolicyArgs,
  subAccountPubkey: Uint8Array,
  subAccountSig: Uint8Array,
): string {
  return encodeSetPolicyClaimCalldata(args, subAccountPubkey, subAccountSig);
}

/** `claimPolicyByAddress` calldata (selector `0x0c21376c`) for a
 *  sub-account whose pubkey is ALREADY recorded on-chain (pubkey
 *  registry). Only the sub-account signature (3309 bytes) rides in the
 *  calldata — no pubkey. */
export function encodeClaimByAddress(
  args: SpendingPolicyArgs,
  subAccountSig: Uint8Array,
): string {
  return encodeClaimPolicyByAddressCalldata(args, subAccountSig);
}

/** `setPolicy` calldata (selector `0x8da1a765`) — the RE-CLAIM / legacy
 *  path used once the principal is already recorded against the
 *  sub-account on-chain. No embedded pubkey/sig. */
export function encodeSetPolicy(args: SpendingPolicyArgs): string {
  return encodeSetPolicyCalldata(args);
}

/** `enable` calldata (selector `0x5bfa1b68`) — un-revoke a previously
 *  disabled policy for `subAccount` (typed `mono` bech32m). */
export function encodeEnable(subAccount: string): string {
  return encodeEnableCalldata(subAccount);
}

/** `disable` calldata (selector `0xe6c09edf`) — REVOKE the policy for
 *  `subAccount`. There is no on-chain "delete"; revoke == disable. */
export function encodeDisable(subAccount: string): string {
  return encodeDisableCalldata(subAccount);
}

/** The exact bytes the sub-account ML-DSA-65 key must `sign()` for the
 *  fresh-claim path. Domain-separated (SET_POLICY_CLAIM_DOMAIN_TAG) and
 *  bound to `chainId` + the policy args + the precompile address, so a
 *  signature captured for one chain/policy cannot be replayed against
 *  another. Pass the full message to `MlDsa65Backend.sign(message)` (NOT
 *  `signPrehash`) — the chain hashes the full bytes itself. */
export function composeClaimMessage(
  chainId: bigint | number | string,
  args: SpendingPolicyArgs,
): Uint8Array {
  return composeClaimBoundMessage(chainId, args);
}

// Re-export the SDK time-window codec so the page imports one module.
export { packTimeWindow, decodeTimeWindow };
export type { SpendingPolicyArgs };

// ─────────────────────────────────────────────────────────────────────────────
// Form → SpendingPolicyArgs
// ─────────────────────────────────────────────────────────────────────────────

/** A single counterparty/category root for the MVP. The §18.8 dims are
 *  32-byte Merkle roots; for the wallet MVP we accept either an
 *  already-computed 32-byte root (0x-hex) or leave it empty to mean "no
 *  constraint" (the zero root). Multi-entry Merkle-tree construction is
 *  a follow-up (TODO(monolythium-vision): build counterparty/category
 *  Merkle trees client-side; MVP carries a single pre-computed root or
 *  the no-constraint zero root). */
const ZERO_ROOT_32 = "0x" + "00".repeat(32);

/** The popup form shape. LYTH caps are decimal strings (8 dp max);
 *  empty/"0" means "no cap". Roots are optional 0x-hex 32-byte words
 *  (empty == no constraint). The time window is opt-in. Expiry is an
 *  optional unix-seconds timestamp (0/undefined == never expires). */
export interface SpendingPolicyForm {
  /** Sub-account address (typed `mono` bech32m). */
  subAccount: string;
  /** Managing principal address (typed `mono` bech32m). */
  principal: string;
  perTxCapLyth: string;
  dailyCapLyth: string;
  weeklyCapLyth: string;
  monthlyCapLyth: string;
  /** Counterparty allow-list root (0x-hex 32 bytes) or "" for none. */
  allowRoot?: string;
  /** Counterparty deny-list root (0x-hex 32 bytes) or "" for none. */
  denyRoot?: string;
  /** Category allow-list root (0x-hex 32 bytes) or "" for none. */
  categoryAllowRoot?: string;
  /** Time-of-day window (hours 0..=23), or null for no window. */
  timeWindow?: { startHour: number; endHour: number } | null;
  /** Policy expiry unix seconds, or 0/undefined for never-expires. */
  policyExpiryUnixSeconds?: number;
}

/**
 * Convert a decimal LYTH amount string to lythoshi (`bigint`).
 * Precision-safe — splits on `.` and builds the BigInt from integer +
 * zero-padded fractional parts so `0.000000000000000001` (1 lythoshi)
 * round-trips exactly. Empty / "0" returns 0n ("no cap"). Throws on
 * malformed input or more than 18 decimal places (callers pre-validate).
 */
export function lythToLythoshi(amountStr: string): bigint {
  const trimmed = amountStr.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  if (!/^\d*(\.\d*)?$/.test(trimmed)) {
    throw new Error("amount must be a non-negative decimal");
  }
  const dot = trimmed.indexOf(".");
  const intPart = dot < 0 ? trimmed : trimmed.slice(0, dot);
  const fracPartRaw = dot < 0 ? "" : trimmed.slice(dot + 1);
  if (fracPartRaw.length > NATIVE_LYTH_DECIMALS) {
    throw new Error(`amount has more than ${NATIVE_LYTH_DECIMALS} decimal places`);
  }
  const fracPadded = (fracPartRaw + "0".repeat(NATIVE_LYTH_DECIMALS)).slice(
    0,
    NATIVE_LYTH_DECIMALS,
  );
  const intBig = BigInt(intPart === "" ? "0" : intPart);
  const fracBig = BigInt(fracPadded === "" ? "0" : fracPadded);
  return intBig * LYTHOSHI_PER_LYTH + fracBig;
}

/** Normalise an optional 0x-hex 32-byte root, defaulting to the
 *  zero/no-constraint root. Throws on a non-32-byte value so a typo
 *  fails before reaching the chain. */
function normaliseRoot(root: string | undefined): string {
  const v = (root ?? "").trim();
  if (v === "") return ZERO_ROOT_32;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error("Merkle root must be a 0x-prefixed 32-byte hex word");
  }
  return v.toLowerCase();
}

/**
 * Build the §18.8 `SpendingPolicyArgs` from the popup form. Caps convert
 * LYTH→lythoshi; roots default to the no-constraint zero root; the time
 * window packs via {@link packTimeWindow} (or the zero word when
 * unset); expiry is unix seconds (0 == never). The returned args feed
 * `encodeSetPolicyClaim` / `composeClaimMessage` unchanged.
 */
export function buildSpendingPolicyArgs(
  form: SpendingPolicyForm,
): SpendingPolicyArgs {
  const timeWindow =
    form.timeWindow == null
      ? packTimeWindow(false, 0, 0)
      : packTimeWindow(true, form.timeWindow.startHour, form.timeWindow.endHour);
  return {
    subAccount: form.subAccount,
    principal: form.principal,
    perTxCapLythoshi: lythToLythoshi(form.perTxCapLyth),
    dailyCapLythoshi: lythToLythoshi(form.dailyCapLyth),
    weeklyCapLythoshi: lythToLythoshi(form.weeklyCapLyth),
    monthlyCapLythoshi: lythToLythoshi(form.monthlyCapLyth),
    allowRoot: normaliseRoot(form.allowRoot),
    denyRoot: normaliseRoot(form.denyRoot),
    categoryAllowRoot: normaliseRoot(form.categoryAllowRoot),
    timeWindow,
    policyExpiry: BigInt(form.policyExpiryUnixSeconds ?? 0),
  };
}
