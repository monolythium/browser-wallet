// Phase 11.5 Commit 7 — chain reader for `lyth_upcomingDuties`
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
import { sprintnetJsonRpc } from "./tx-mldsa.js";

export const DEFAULT_UPCOMING_DUTIES_AUTHORITY = 0;
/** Chain clamps at 1000 (MAX_UPCOMING_DUTIES_HORIZON); ask for the
 *  full window so the keyRotation epoch boundary is captured even
 *  when it's far. */
export const DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS = 1000;

const MOCK_DUTIES: UpcomingDuties = {
  schemaVersion: 1,
  authorityIndex: DEFAULT_UPCOMING_DUTIES_AUTHORITY,
  currentRound: 0,
  horizonRounds: DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS,
  duties: {
    attestation: { startRound: 0, endRound: 0, kind: "mock" },
    blockProduction: { reason: "mock" },
    sync: { reason: "mock" },
    keyRotation: { reason: "mock" },
  },
};

export const UPCOMING_DUTIES_PLACEHOLDER: Readonly<UpcomingDuties> = MOCK_DUTIES;

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
  return withChainFallback<UpcomingDuties>(
    async () => {
      const { result } = await sprintnetJsonRpc<UpcomingDuties>(
        "lyth_upcomingDuties",
        [authorityIndex, horizonRounds],
      );
      return result;
    },
    {
      mockValue: { ...MOCK_DUTIES, authorityIndex, horizonRounds },
      notLiveAs: "not-deployed",
      label: "lyth_upcomingDuties",
      timeoutMs: 5000,
      isValid: isUpcomingDuties,
    },
  );
}
