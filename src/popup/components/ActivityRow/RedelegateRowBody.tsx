// Redelegate row. The SOURCE cluster shows the real *.cluster.mono name the
// wallet captured at send time when known (resolveClusterLabel), else an honest
// `Cluster #<id>`. The DESTINATION (toCluster) has no captured name — it shows
// the live directory name or `Cluster #<id>` (and is null on the activity-stream
// fallback, where the destination is unknown and the " to …" segment is omitted
// entirely). Never a fabricated name (§C: no cluster-name reader in mono-core).
//
// The label is the shared `redelegateConfirmedLabel` ("Redelegated <pct> from
// <src> to <dst>"), so the % rides IN the line — the old right-side weight badge
// is dropped to avoid a duplicate figure.

import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { RedelegateRow } from "../../../shared/activity.js";
import { resolveClusterLabel } from "../../../shared/staking.js";
import { redelegateConfirmedLabel } from "../../../shared/activity-label.js";

export interface RedelegateRowBodyProps {
  row: RedelegateRow;
  /** Cluster directory (id → name); falls back to the captured name then
   *  `Cluster #<id>`. The destination cluster has no captured name → directory
   *  or `Cluster #<id>`. */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
}

export function RedelegateRowBody({ row, clusterNameById }: RedelegateRowBodyProps) {
  const srcLabel = resolveClusterLabel(row.cluster, row.clusterName, clusterNameById);
  const dstLabel =
    row.toCluster !== null
      ? resolveClusterLabel(row.toCluster, null, clusterNameById)
      : undefined;
  const label = redelegateConfirmedLabel(row.weightBps, srcLabel, dstLabel);
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="swap" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who" title={label}>{label}</div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
    </div>
  );
}
