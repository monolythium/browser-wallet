// Phase 11.5 Commit 5 — chain reader for `lyth_operatorRisk`
// (MD-CORE-0006 / mono-core @dd05511, ref 017cab9 operator
// pending-change risk previews).
//
// Scope swap from the original Phase 11.5 task (which named
// `lyth_getServiceProbe`):
//
//   lyth_getServiceProbe(peerId: [u8;32], serviceMask: u32) requires
//   a 32-byte node-registry peer id per row. The wallet's Operators
//   page surfaces RPC URLs; there is no peerId attached to them and
//   resolving one would mean chaining lyth_listProviders or
//   lyth_peerSummary per row, which is out of scope for Phase 11.5.
//
//   lyth_operatorRisk is the sibling MD-CORE-0006 surface (same
//   commit family — 017cab9) that delivers the same intent — "real
//   chain-side operator health" — without needing a separate peerId
//   resolution. It is keyed on consensus authority index (u16), so
//   it slots into the same pattern as Commit 3's signing-activity
//   reader. The chain-wide single-authority sample is documented
//   in the popup's card title so users don't misread it as per-RPC
//   attribution.
//
// What `lyth_operatorRisk` returns (OperatorRiskWire):
//   - missedRounds / observedRounds — the raw cert participation
//     counters over `windowRounds`.
//   - missRateBps — the rate the chain itself computed.
//   - thresholdBps — the liveness-slash threshold (operator becomes a
//     slash candidate above this rate).
//   - remainingHeadroomBps — how much rate the authority can absorb
//     before crossing the threshold. The wallet renders this as
//     the "headroom" pill.
//   - jailStatus — either { jailed, tombstoned, jailedUntilHeight,
//     unjailCount } when the runtime jail registry is wired, or
//     { reason: "..." } when not.
//   - reasons[] — stable codes (e.g. "near_threshold") layered on
//     top of the miss-rate.

import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  isOperatorRiskWire,
  type OperatorRiskWire,
} from "../shared/audit-followup-types.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

/** Default sample authority — same canonical first validator slot
 *  as the signing-activity sampler. */
export const DEFAULT_OPERATOR_RISK_AUTHORITY = 0;
/** Default risk window in rounds. Chain clamps at
 *  MAX_OPERATOR_RISK_WINDOW=1000 anyway; we ask for 200 rounds
 *  which is a few minutes of consensus history — short enough to
 *  reflect current state, long enough to dampen single-round noise. */
export const DEFAULT_OPERATOR_RISK_WINDOW_ROUNDS = 200;

export interface ReadOperatorRiskArgs {
  authorityIndex?: number;
  windowRounds?: number;
}

export async function readOperatorRisk(
  args: ReadOperatorRiskArgs = {},
): Promise<ChainOutcome<OperatorRiskWire>> {
  const authorityIndex =
    typeof args.authorityIndex === "number" && args.authorityIndex >= 0
      ? Math.floor(args.authorityIndex)
      : DEFAULT_OPERATOR_RISK_AUTHORITY;
  const windowRounds =
    typeof args.windowRounds === "number" && args.windowRounds > 0
      ? Math.floor(args.windowRounds)
      : DEFAULT_OPERATOR_RISK_WINDOW_ROUNDS;
  // Empty sentinel for `withChainFallback`'s required `mockValue` slot.
  // The popup hides the AuthorityRisk card on any non-`live` outcome
  // (Operators.tsx) so this value never reaches the UI — kept only to
  // satisfy the `T` constraint. Per
  // `_dev-notes/_principles/no-mock-fallbacks.md` no synthesized risk
  // figures are exposed to consumers.
  const noDataSentinel: OperatorRiskWire = {
    schemaVersion: 1,
    authorityIndex,
    dataHeight: 0,
    windowRounds,
    missedRounds: 0,
    observedRounds: 0,
    missRateBps: 0,
    thresholdBps: 0,
    remainingHeadroomBps: 0,
    jailStatus: { reason: "unavailable" },
    reasons: [],
  };
  return withChainFallback<OperatorRiskWire>(
    async () => {
      const { result } = await sprintnetJsonRpc<OperatorRiskWire>(
        "lyth_operatorRisk",
        [authorityIndex, windowRounds],
      );
      return result;
    },
    {
      mockValue: noDataSentinel,
      notLiveAs: "not-deployed",
      label: "lyth_operatorRisk",
      timeoutMs: 5000,
      isValid: isOperatorRiskWire,
    },
  );
}

// deriveOperatorRiskTier + OperatorRiskTier moved to
// ../shared/audit-followup-types.ts so the popup can import the
// derivation without pulling the SW-side RPC stub into its chunk.
