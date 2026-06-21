// Shared reward-claim capture (popup-side).
//
// Both claim broadcast sites (Stake.tsx + Delegations.tsx) call buildClaimMeta
// at broadcast so they cannot diverge (C3 — centralized). The claimed amount is
// NOT captured here: the submit-time pending-rewards snapshot
// (settledPendingLythoshi) is wrong — settled-only and pre-execution, so it
// under-counts and reads 0 right after a prior claim (see
// 2026-06-20_claim-amount-wrong-inspect.md). The authoritative amount is decoded
// from the receipt's `Claimed` log AFTER confirmation, in the activity-get
// bridge (shared/claimed-log.ts). So `claimedAmount` is null at submit and is
// populated only by that decode (no-mock — never a wrong pre-confirmation
// figure). The fiat rate is captured + FROZEN here so confirmed-history fiat
// survives every indexer rebuild; getLythFiatRate returns null until the oracle
// ships, so rateAtClaim is null today and the fiat sibling renders the honest
// dash — never a fabricated value.

import { loadDisplayCurrency } from "./display-prefs.js";
import { getLythFiatRate } from "../shared/fiat.js";
import type { CurrencyCode } from "../shared/iso4217.js";

/** Metadata threaded into `bgWalletSendTx` for a reward claim — PENDING-ROW
 *  METADATA ONLY, never part of the signed tx. */
export interface ClaimMeta {
  /** Always null at submit. The real claimed amount (decimal LYTH) is decoded
   *  from the receipt's `Claimed` log after confirmation, in the bridge. */
  claimedAmount: string | null;
  /** Frozen LYTH→fiat rate at claim time (null until the oracle exists). */
  rateAtClaim: number | null;
  /** Display currency the rate was captured in. */
  currency: CurrencyCode;
}

/** Capture the claim's frozen fiat rate + currency at broadcast. The amount is
 *  left null — it is decoded from the `Claimed` log once the receipt lands
 *  (decodeClaimedAmountLythoshi, applied in the activity-get bridge). */
export async function buildClaimMeta(): Promise<ClaimMeta> {
  const currency = await loadDisplayCurrency();
  return { claimedAmount: null, rateAtClaim: getLythFiatRate(currency), currency };
}
