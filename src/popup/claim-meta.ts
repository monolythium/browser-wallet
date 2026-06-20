// Shared reward-claim capture (popup-side).
//
// Both claim broadcast sites (Stake.tsx + Delegations.tsx) call buildClaimMeta
// at broadcast so they cannot diverge (C3 — centralized). The claimed amount is
// known ONLY at claim time as the wallet's live settledPendingLythoshi (the
// chain/indexer never surface it; the claim tx value is 0x0). The fiat rate is
// captured + FROZEN here so confirmed-history fiat survives every indexer
// rebuild; getLythFiatRate returns null until the oracle ships, so rateAtClaim
// is null today and the fiat sibling renders the honest dash — never a
// fabricated value (no-mock).

import { loadDisplayCurrency } from "./display-prefs.js";
import { getLythFiatRate } from "../shared/fiat.js";
import { lythoshiDecimalToLythDecimal } from "../shared/lyth-units.js";
import type { CurrencyCode } from "../shared/iso4217.js";
import type { PendingRewardsView } from "../shared/staking.js";

/** Metadata threaded into `bgWalletSendTx` for a reward claim — PENDING-ROW
 *  METADATA ONLY, never part of the signed tx. */
export interface ClaimMeta {
  /** Claimed reward in decimal LYTH, or null when unavailable (no-mock). */
  claimedAmount: string | null;
  /** Frozen LYTH→fiat rate at claim time (null until the oracle exists). */
  rateAtClaim: number | null;
  /** Display currency the rate was captured in. */
  currency: CurrencyCode;
}

/** Capture the claim's reward amount + frozen fiat rate at broadcast.
 *  - `claimedAmount`: the live `settledPendingLythoshi` (decimal lythoshi →
 *    decimal LYTH); null when rewards are absent/mock (no-mock — never invent
 *    an amount).
 *  - `rateAtClaim`: `getLythFiatRate(currency)` — null today (no oracle).
 *  - `currency`: the stored display-currency preference. */
export async function buildClaimMeta(
  rewards: PendingRewardsView | null,
  rewardsMock: boolean,
): Promise<ClaimMeta> {
  const currency = await loadDisplayCurrency();
  const claimedAmount =
    rewards && !rewardsMock && typeof rewards.settledPendingLythoshi === "string"
      ? lythoshiDecimalToLythDecimal(rewards.settledPendingLythoshi)
      : null;
  return { claimedAmount, rateAtClaim: getLythFiatRate(currency), currency };
}
