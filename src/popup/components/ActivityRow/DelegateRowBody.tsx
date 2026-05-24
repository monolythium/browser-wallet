// Delegate row. Cluster id rendered as `C-NNN.cluster.mono` per the
// §22.8 hierarchical naming convention — the literal cluster name
// (e.g. "halcyon.cluster.mono") arrives when the indexer ships
// hierarchical resolution; until then we use the `C-NNN` placeholder
// matching the existing Home stake-cluster display convention.

import { Icon } from "../../Icon.js";
import type { DelegateRow } from "../../../shared/activity.js";

export interface DelegateRowBodyProps {
  row: DelegateRow;
}

function clusterName(id: number): string {
  return `C-${String(id + 1).padStart(3, "0")}.cluster.mono`;
}

export function DelegateRowBody({ row }: DelegateRowBodyProps) {
  const bps = row.weightBps;
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Delegated{bps !== null ? ` ${(bps / 100).toFixed(2)}%` : ""} to{" "}
          {clusterName(row.cluster)}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
          <span>·</span>
          <span>tx {row.txIndex}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{bps !== null ? `${bps} bps` : "—"}</div>
        <div className="sym">delegated</div>
      </div>
    </div>
  );
}
