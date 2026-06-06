// Redelegate row. The SOURCE cluster shows the real *.cluster.mono name the
// wallet captured at send time when known (clusterLabel), else an honest
// `Cluster #<id>`. The DESTINATION (toCluster) has no captured name — it shows
// `Cluster #<id>` (and is null on the activity-stream fallback, where the
// destination is unknown and the " to …" segment is omitted entirely). Never a
// fabricated name (§C: no cluster-name reader in mono-core).

import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { RedelegateRow } from "../../../shared/activity.js";
import { clusterLabel, formatWeightBpsPercent } from "../../../shared/staking.js";
import { useFeature } from "../../hooks/useFeature.js";

export interface RedelegateRowBodyProps {
  row: RedelegateRow;
}

export function RedelegateRowBody({ row }: RedelegateRowBodyProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  const bps = row.weightBps;
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Moved delegation from {clusterLabel(row.cluster, row.clusterName)}
          {row.toCluster !== null ? ` to ${clusterLabel(row.toCluster)}` : ""}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">
          {bps !== null
            ? devMode
              ? `${bps} bps`
              : formatWeightBpsPercent(bps)
            : "—"}
        </div>
        <div className="sym">redelegated</div>
      </div>
    </div>
  );
}
