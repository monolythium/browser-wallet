// Chain reader for `lyth_upcomingDuties`
// (MD-CORE-0005 / mono-core @dd05511, ref 026d925a deterministic
// upcoming-duties surface + 02a26cf0 committee context attach).
//
// The chain handler at protocore.rs:3184 takes
//   [authorityIndex: u16, horizonRounds?: u32 default 1000]
// and returns an UpcomingDuties payload that the wallet renders as
// an "Upcoming duties" card on the Operators page. The wallet uses
// the canonical first authority (0) by default — same chain-wide
// sampling rationale as Commits 3 and 5. The chain doc explicitly
// notes that block-production and sync surfaces are typed-null
// (DutyAbsence with `reason`) because Starfish-C leader election
// is not predictable; only attestation + keyRotation are reliably
// scheduling-available.

import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  isUpcomingDuties,
  type UpcomingDuties,
} from "../shared/audit-followup-types.js";
import { testnetJsonRpc } from "./tx-mldsa.js";

export const DEFAULT_UPCOMING_DUTIES_AUTHORITY = 0;
/** Chain clamps at 1000 (MAX_UPCOMING_DUTIES_HORIZON); ask for the
 *  full window so the keyRotation epoch boundary is captured even
 *  when it's far. */
export const DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS = 1000;

export interface ReadUpcomingDutiesArgs {
  authorityIndex?: number;
  horizonRounds?: number;
}

export async function readUpcomingDuties(
  args: ReadUpcomingDutiesArgs = {},
): Promise<ChainOutcome<UpcomingDuties>> {
  const authorityIndex =
    typeof args.authorityIndex === "number" && args.authorityIndex >= 0
      ? Math.floor(args.authorityIndex)
      : DEFAULT_UPCOMING_DUTIES_AUTHORITY;
  const horizonRounds =
    typeof args.horizonRounds === "number" && args.horizonRounds > 0
      ? Math.floor(args.horizonRounds)
      : DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS;
  // Empty sentinel for `withChainFallback`'s required `mockValue` slot.
  // UpcomingDutiesCard (Operators.tsx) hides itself on any non-`live`
  // outcome so this never reaches the UI. Per
  // `_dev-notes/_principles/no-mock-fallbacks.md` no synthesized duty
  // entries are exposed. All four duty kinds use the chain's typed-null
  // shape (`reason: "unavailable"`) rather than fabricated rounds.
  const noDataSentinel: UpcomingDuties = {
    schemaVersion: 1,
    authorityIndex,
    currentRound: 0,
    horizonRounds,
    duties: {
      attestation: { startRound: 0, endRound: 0, kind: "unavailable" },
      blockProduction: { reason: "unavailable" },
      sync: { reason: "unavailable" },
      keyRotation: { reason: "unavailable" },
    },
  };
  return withChainFallback<UpcomingDuties>(
    async () => {
      const { result } = await testnetJsonRpc<UpcomingDuties>(
        "lyth_upcomingDuties",
        [authorityIndex, horizonRounds],
      );
      return result;
    },
    {
      mockValue: noDataSentinel,
      notLiveAs: "not-deployed",
      label: "lyth_upcomingDuties",
      timeoutMs: 5000,
      isValid: isUpcomingDuties,
    },
  );
}
