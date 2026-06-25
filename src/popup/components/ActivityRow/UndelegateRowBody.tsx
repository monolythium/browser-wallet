import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { UndelegateRow } from "../../../shared/activity.js";
import { resolveClusterLabel, formatWeightBpsPercent } from "../../../shared/staking.js";

export interface UndelegateRowBodyProps {
  row: UndelegateRow;
  /** Cluster directory (id → name); falls back to the captured name then
   *  `Cluster #<id>`. */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
}

export function UndelegateRowBody({ row, clusterNameById }: UndelegateRowBodyProps) {
  const label = `Undelegated from ${resolveClusterLabel(row.cluster, row.clusterName, clusterNameById)}`;
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="unstake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who" title={label}>
          {label}
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
