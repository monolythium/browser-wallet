import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { UndelegateRow } from "../../../shared/activity.js";
import { clusterLabel, formatWeightBpsPercent } from "../../../shared/staking.js";

export interface UndelegateRowBodyProps {
  row: UndelegateRow;
}

export function UndelegateRowBody({ row }: UndelegateRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir in">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Undelegated from {clusterLabel(row.cluster, row.clusterName)}
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
