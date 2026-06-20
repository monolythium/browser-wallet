// Delegate row. Shows the real *.cluster.mono name the wallet captured at send
// time (threaded onto the confirmed row by applyCapturedClusterNames) when
// known, else an honest `Cluster #<id>` (clusterLabel) — never a fabricated
// name. Indexer-sourced (non-originated) stakes carry only the numeric id
// (§C: no cluster name / reverse-resolver in mono-core) → they show
// `Cluster #<id>` until a chain name source exists.

import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { DelegateRow } from "../../../shared/activity.js";
import { resolveClusterLabel, formatWeightBpsPercent } from "../../../shared/staking.js";

export interface DelegateRowBodyProps {
  row: DelegateRow;
  /** Cluster directory (id → name); falls back to the captured name then
   *  `Cluster #<id>`. */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
}

export function DelegateRowBody({ row, clusterNameById }: DelegateRowBodyProps) {
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
          Delegated to {resolveClusterLabel(row.cluster, row.clusterName, clusterNameById)}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
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
