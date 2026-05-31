// Delegate row. Cluster id rendered as `C-NNN.cluster.mono` per the
// §22.8 hierarchical naming convention — the literal cluster name
// (e.g. "halcyon.cluster.mono") arrives when the indexer ships
// hierarchical resolution; until then we use the `C-NNN` placeholder
// matching the existing Home stake-cluster display convention.

import { Icon } from "../../Icon.js";
import type { DelegateRow } from "../../../shared/activity.js";
import { formatWeightBpsPercent } from "../../../shared/staking.js";

export interface DelegateRowBodyProps {
  row: DelegateRow;
}

function clusterName(id: number): string {
  return `C-${String(id + 1).padStart(3, "0")}.cluster.mono`;
}

export function DelegateRowBody({ row }: DelegateRowBodyProps) {
  // weightBps is a delegation WEIGHT share (basis points), not a LYTH amount —
  // render it as a percentage. The LYTH principal is surfaced in the tx-detail
  // popup via a block-lookup of the delegate tx value.
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Delegated to {clusterName(row.cluster)}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{formatWeightBpsPercent(row.weightBps)}</div>
        <div className="sym">weight</div>
      </div>
    </div>
  );
}
