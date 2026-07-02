// Shared, plain-text label strings for the staking activity / notification
// surfaces — the pending rows, the confirmed redelegate row, and the detail
// view all consume the SAME builder so the wording stays consistent.
//
// DISPLAY-ONLY: nothing here touches the signed tx, the amount, or the bps —
// these are the rendered strings only. The `%` reuses `formatWeightBpsPercent`
// and the cluster names are resolved by the CALLER (the pending rows use the
// captured name via `clusterLabel`; the confirmed rows use the live directory
// via `resolveClusterLabel`) so this module stays a pure string assembler.

import { formatWeightBpsPercent } from "./staking.js";

/** "12.50% " or "" — the weight-% prefix, omitted cleanly when the bps is
 *  absent (legacy rows captured none → no-mock, no fabricated figure). */
function pctPrefix(bps: number | null | undefined): string {
  return bps != null ? `${formatWeightBpsPercent(bps)} ` : "";
}

/** Pending-claim label (the claim's `amountDecimal` is "0"; the reward figure
 *  rides on `claimedAmount`, appended by the row body). */
export const CLAIM_PENDING_LABEL = "Claiming rewards";

/** Present-continuous label for a PENDING delegation row. `srcLabel` (and, for
 *  redelegate, `dstLabel`) are already resolved by the caller to the real
 *  `*.cluster.mono` name or an honest `Cluster #<id>`. */
export function delegationPendingLabel(
  opKind: "delegate" | "undelegate" | "redelegate",
  bps: number | null | undefined,
  srcLabel: string,
  dstLabel?: string,
): string {
  const pct = pctPrefix(bps);
  switch (opKind) {
    case "delegate":
      return `Delegating ${pct}to ${srcLabel}`;
    case "undelegate":
      return `Undelegating ${pct}from ${srcLabel}`;
    case "redelegate":
      return dstLabel !== undefined
        ? `Redelegating ${pct}from ${srcLabel} to ${dstLabel}`
        : `Redelegating ${pct}from ${srcLabel}`;
  }
}

/** Past-tense label for the CONFIRMED redelegate row (replaces the old
 *  "Moved delegation from <src> to <dst>"). `srcLabel`/`dstLabel` resolved by
 *  the caller. */
export function redelegateConfirmedLabel(
  bps: number | null | undefined,
  srcLabel: string,
  dstLabel?: string,
): string {
  const pct = pctPrefix(bps);
  return dstLabel !== undefined
    ? `Redelegated ${pct}from ${srcLabel} to ${dstLabel}`
    : `Redelegated ${pct}from ${srcLabel}`;
}
