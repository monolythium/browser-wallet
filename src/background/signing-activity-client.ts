// Chain reader for `lyth_signingActivity`
// (MD-CORE-0004 / mono-core @dd05511).
//
// The chain handler at protocore.rs:3003 takes
//   [authorityIndex: u16, limit?: u32 default 200]
// and returns an OperatorSigningActivity payload describing the
// recent BLS-cert signing entries for that authority. The wallet
// uses this for a *chain-wide* signing-health card on the Operators
// page — not per-operator-RPC, because the wallet's Operators page
// manages RPC endpoint URLs (transport-layer) and the chain method
// is keyed on the BLS validator-set authority slot (consensus-layer).
//
// Per-operator (RPC-endpoint) signing-activity attribution would
// require `lyth_resolveOperatorAuthority(operatorId)` chained per
// row, where operatorId is keccak256(bls_pubkey) exposed via
// `lyth_clusterStatus.members[].operatorId`. The wallet doesn't
// currently surface operatorId per RPC endpoint, so that two-step
// chain is deferred to a future commit. The chain-wide health card
// still gives the user transparency into signing liveness without
// pretending the wallet knows which RPC = which validator.
//
// Default authority index: 0 (the canonical first validator). The
// IPC accepts an override so future UI can let the user sweep the
// validator set. Default limit: 20 entries (~enough to render a
// "last seen" view without blowing the cost budget — chain method
// cost weight is 30 per call).

import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  isOperatorSigningActivity,
  type OperatorSigningActivity,
} from "../shared/audit-followup-types.js";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

/** Default sample authority. The first validator slot is a
 *  reasonable single-point sample for "is signing healthy on the
 *  chain at all" — multi-authority sweeps land in a future commit. */
export const DEFAULT_SIGNING_ACTIVITY_AUTHORITY = 0;
/** Default window size. Small enough to keep the cost budget tight,
 *  large enough to render a meaningful "latest entry" view. */
export const DEFAULT_SIGNING_ACTIVITY_LIMIT = 20;

export interface ReadSigningActivityArgs {
  authorityIndex?: number;
  limit?: number;
}

export async function readSigningActivity(
  args: ReadSigningActivityArgs = {},
): Promise<ChainOutcome<OperatorSigningActivity>> {
  const authorityIndex =
    typeof args.authorityIndex === "number" && args.authorityIndex >= 0
      ? Math.floor(args.authorityIndex)
      : DEFAULT_SIGNING_ACTIVITY_AUTHORITY;
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.floor(args.limit)
      : DEFAULT_SIGNING_ACTIVITY_LIMIT;

  // Empty sentinel for `withChainFallback`'s required `mockValue` slot.
  // ChainSigningHealthCard (Operators.tsx) hides itself on any non-`live`
  // outcome so this never reaches the UI. Per
  // `_dev-notes/_principles/no-mock-fallbacks.md` no synthesized activity
  // entries are exposed.
  const noDataSentinel: OperatorSigningActivity = {
    schemaVersion: 1,
    authorityIndex,
    currentRound: 0,
    limit,
    supportedStatuses: [],
    reservedStatuses: [],
    entries: [],
  };

  return withChainFallback<OperatorSigningActivity>(
    async () => {
      const { result } = await sprintnetJsonRpc<OperatorSigningActivity>(
        "lyth_signingActivity",
        [authorityIndex, limit],
      );
      return result;
    },
    {
      mockValue: noDataSentinel,
      notLiveAs: "not-deployed",
      label: "lyth_signingActivity",
      timeoutMs: 5000,
      isValid: isOperatorSigningActivity,
    },
  );
}
