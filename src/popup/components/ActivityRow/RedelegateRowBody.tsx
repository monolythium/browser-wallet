// Redelegate row. When `toCluster` is null (activity-stream fallback per
// commit 1), renders without a destination — "Moved delegation from
// C-NNN.cluster.mono" only. The DelegationHistoryRecord path always
// surfaces toCluster.

import { Icon } from "../../Icon.js";
import type { RedelegateRow } from "../../../shared/activity.js";

export interface RedelegateRowBodyProps {
  row: RedelegateRow;
}

function clusterName(id: number): string {
  return `C-${String(id + 1).padStart(3, "0")}.cluster.mono`;
}

export function RedelegateRowBody({ row }: RedelegateRowBodyProps) {
  const bps = row.weightBps;
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Moved delegation from {clusterName(row.cluster)}
          {row.toCluster !== null ? ` to ${clusterName(row.toCluster)}` : ""}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{bps !== null ? `${bps} bps` : "—"}</div>
        <div className="sym">redelegated</div>
      </div>
    </div>
  );
}
