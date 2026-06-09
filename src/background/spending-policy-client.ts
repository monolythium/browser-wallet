// spending-policy-client. SW-side reader + agent sub-account helpers for
// the §18.8 spending-policy precompile (0x110C).
//
// Two surfaces:
//
//   1. readSpendingPolicy(subAccount) — RPC read of the live policy via
//      `testnetJsonRpc("lyth_getSpendingPolicy", [bech32mSubAccount])`,
//      returned in the same `StakingResult<T>` envelope the staking
//      readers use (ok:false on transport/shape error, no mock
//      fallback). The popup renders the SpendingPolicyView summary card.
//
//   2. buildSpendingPolicyClaim(form) — the agent sub-account lifecycle:
//        - CREATE: generate a fresh PQM-1 mnemonic + ML-DSA-65 keypair
//          the principal controls (its OWN keypair, NOT a vault — the
//          24-word mnemonic is returned once so the principal can fund
//          / re-manage it). This is the sub-account.
//        - REGISTER: sign `composeClaimMessage(chainId, args)` with the
//          SUB-ACCOUNT's ML-DSA-65 key (the bytes are domain-separated +
//          chain-id-bound), then build `encodeSetPolicyClaim(args,
//          subPubkey, subSig)` (selector 0x35531f6c). The PRINCIPAL (the
//          active wallet) signs + submits the OUTER tx via the existing
//          `wallet-send-tx` handler — a two-key dance.
//      FUND is an ordinary native LYTH transfer (principal →
//      sub-account address) and rides the existing `wallet-send-tx`
//      handler with `to = subAccount`, `value = amount` — NO new SDK
//      symbol.
//
// The fresh sub-account seed is zeroized immediately after signing; the
// SDK backend holds the secret key in a private field that becomes
// GC-eligible once the reference drops.
//
// CONSENSUS-CRITICAL: a §18.8 policy violation is rejected AT
// ADMISSION. Correctness here is pinned offline by
// shared/spending-policy-tx.test.ts golden vectors (selectors,
// 1952/3309 length guards, chain-id binding). The precompile may be
// milestone-GATED on the live testnet; the SW does not pre-empt that —
// it submits via wallet-send-tx and surfaces the typed precompile-gate
// error verbatim.

import { testnetJsonRpc } from "./tx-mldsa.js";
import {
  generatePqm1Mnemonic,
  pqm1MnemonicToMlDsa65Seed,
  bytesToHex,
} from "@monolythium/core-sdk/crypto";
import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import { randomBytes } from "@noble/hashes/utils.js";
import type { SpendingPolicyView } from "@monolythium/core-sdk";
import {
  SPENDING_POLICY_PRECOMPILE,
  buildSpendingPolicyArgs,
  composeClaimMessage,
  encodeSetPolicyClaim,
  type SpendingPolicyForm,
} from "../shared/spending-policy-tx.js";
import { userAddressForNativeRpc } from "../shared/address-format.js";
import type { StakingResult } from "../shared/staking.js";

// ─────────────────────────────────────────────────────────────────────────────
// Read — lyth_getSpendingPolicy
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: SpendingPolicyView from `lyth_getSpendingPolicy`. The
// wire form below loosens every field to optional so a misbehaving
// operator can't crash the parser; the runtime check validates the
// minimal shape (`address` + `exists`) before normalisation. The cast
// target is the SDK type so a chain-side rename surfaces in the wallet
// typecheck the next time the SDK rebuilds.
type RawSpendingPolicyView = Partial<SpendingPolicyView>;

/** Read the live §18.8 spending policy for a controlled sub-account via
 *  `lyth_getSpendingPolicy`. Returns the SpendingPolicyView verbatim on
 *  success (camelCase chain JSON), `ok: false` on transport / shape
 *  error — per `_dev-notes/_principles/no-mock-fallbacks.md`. The
 *  `subAccount` may be a `0x` address (converted to typed `mono`
 *  bech32m) or an already-typed bech32m string. */
export async function readSpendingPolicy(
  subAccount: string,
): Promise<StakingResult<SpendingPolicyView>> {
  const typed = userAddressForNativeRpc(subAccount);
  try {
    const { result, via } = await testnetJsonRpc<RawSpendingPolicyView>(
      "lyth_getSpendingPolicy",
      [typed],
    );
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.address !== "string" ||
      typeof result.exists !== "boolean"
    ) {
      return { ok: false, reason: "malformed lyth_getSpendingPolicy response" };
    }
    // Trust the SDK-shaped fields; the chain owns the canonical JSON. We
    // pass it through as the SpendingPolicyView the popup decodes.
    return { ok: true, via, data: result as SpendingPolicyView };
  } catch (e) {
    return {
      ok: false,
      reason: (e as Error)?.message ?? "lyth_getSpendingPolicy unreachable",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent sub-account create + claim-message signing
// ─────────────────────────────────────────────────────────────────────────────

/** The popup form for a fresh-claim registration. The principal is the
 *  active wallet's `0x` address (converted to typed bech32m here); the
 *  sub-account address + bech32m are produced by this helper from the
 *  freshly-generated keypair, so the caller does NOT supply them. */
export interface BuildClaimRequest {
  /** Active-wallet (principal) address — `0x` hex or typed bech32m. */
  principal: string;
  /** Active chain id (hex or decimal) — bound into the claim message. */
  chainId: string | number;
  perTxCapLyth: string;
  dailyCapLyth: string;
  weeklyCapLyth: string;
  monthlyCapLyth: string;
  allowRoot?: string;
  denyRoot?: string;
  categoryAllowRoot?: string;
  timeWindow?: { startHour: number; endHour: number } | null;
  policyExpiryUnixSeconds?: number;
}

/** Result of {@link buildSpendingPolicyClaim}: everything the popup
 *  needs to (a) show the user the fresh sub-account recovery phrase,
 *  (b) fund the sub-account address with a native transfer, and (c)
 *  submit the claim calldata to 0x110C. */
export interface BuildClaimResult {
  ok: true;
  /** Where to submit the claim (0x110C). */
  to: string;
  /** `value` for the claim tx — always `0x0` (claim carries no LYTH). */
  valueWeiHex: "0x0";
  /** Encoded `setPolicyClaim` calldata (selector 0x35531f6c). */
  data: string;
  /** The fresh sub-account address (`0x` hex). */
  subAccountAddress: string;
  /** The fresh sub-account address (typed `mono` bech32m). */
  subAccountBech32m: string;
  /** The sub-account's 24-word PQM-1 recovery phrase — ONE-TIME. The
   *  principal must save this to fund / re-manage the sub-account
   *  later; it is the sub-account's only key. */
  subAccountMnemonic: string;
}

export type BuildClaimOutcome = BuildClaimResult | { ok: false; reason: string };

/**
 * Generate a fresh agent sub-account keypair, sign the §18.8
 * claim-bound message with it, and build the `setPolicyClaim` calldata.
 *
 * The sub-account is a brand-new ML-DSA-65 keypair (fresh PQM-1
 * mnemonic) the principal controls — it is NOT one of the principal's
 * wallet vaults. The returned mnemonic is the only copy of the
 * sub-account's key; the popup surfaces it once for the user to save.
 *
 * Throws nothing — returns a typed `{ ok: false, reason }` on any
 * encode/validation error (e.g. a malformed Merkle root) so the popup
 * renders an honest failure rather than a fake success.
 */
export async function buildSpendingPolicyClaim(
  req: BuildClaimRequest,
): Promise<BuildClaimOutcome> {
  // 1. Fresh sub-account keypair.
  const mnemonic = generatePqm1Mnemonic((out) => {
    out.set(randomBytes(out.length));
  });
  const seed = pqm1MnemonicToMlDsa65Seed(mnemonic);
  let backend: MlDsa65Backend;
  try {
    backend = MlDsa65Backend.fromSeed(seed);
  } finally {
    // The backend keeps its own copy of the key material derived from
    // the seed; zero the transient seed buffer immediately.
    seed.fill(0);
  }

  const subAccountAddress = backend.getAddress(); // 0x-hex
  const subAccountBech32m = userAddressForNativeRpc(subAccountAddress);
  const principalBech32m = userAddressForNativeRpc(req.principal);

  // 2. Build the §18.8 args (caps → lythoshi, roots, window, expiry).
  const form: SpendingPolicyForm = {
    subAccount: subAccountBech32m,
    principal: principalBech32m,
    perTxCapLyth: req.perTxCapLyth,
    dailyCapLyth: req.dailyCapLyth,
    weeklyCapLyth: req.weeklyCapLyth,
    monthlyCapLyth: req.monthlyCapLyth,
    ...(req.allowRoot !== undefined ? { allowRoot: req.allowRoot } : {}),
    ...(req.denyRoot !== undefined ? { denyRoot: req.denyRoot } : {}),
    ...(req.categoryAllowRoot !== undefined
      ? { categoryAllowRoot: req.categoryAllowRoot }
      : {}),
    timeWindow: req.timeWindow ?? null,
    ...(req.policyExpiryUnixSeconds !== undefined
      ? { policyExpiryUnixSeconds: req.policyExpiryUnixSeconds }
      : {}),
  };

  let data: string;
  try {
    const args = buildSpendingPolicyArgs(form);
    // 3. The sub-account signs the domain-separated, chain-id-bound
    //    claim message. `sign()` (NOT signPrehash) — the chain hashes
    //    the full message itself.
    const message = composeClaimMessage(req.chainId, args);
    const sig = backend.sign(message); // 3309 bytes
    const pubkey = backend.publicKey(); // 1952 bytes
    // 4. Build the outer calldata. encodeSetPolicyClaim throws
    //    SpendingPolicyError if pubkey/sig are the wrong length — that
    //    would be an internal bug here (sizes are SDK-canonical), but
    //    the try/catch surfaces it honestly rather than masking.
    data = encodeSetPolicyClaim(args, pubkey, sig);
  } catch (e) {
    return {
      ok: false,
      reason: (e as Error)?.message ?? "failed to build spending-policy claim",
    };
  } finally {
    // S1-01: wipe the fresh sub-account signer's secret after the claim is built
    // (covers both the success path and the error-return above).
    backend.dispose();
  }

  return {
    ok: true,
    to: SPENDING_POLICY_PRECOMPILE,
    valueWeiHex: "0x0",
    data,
    subAccountAddress,
    subAccountBech32m,
    subAccountMnemonic: mnemonic,
  };
}

/** Re-exported for the popup-side preview (the pubkey hex helper isn't
 *  load-bearing for submit, but the page shows a short fingerprint of
 *  the sub-account pubkey in the confirm card). */
export function pubkeyFingerprintHex(pubkey: Uint8Array): string {
  return "0x" + bytesToHex(pubkey.slice(0, 8));
}
