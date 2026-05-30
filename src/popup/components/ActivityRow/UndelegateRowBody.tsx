import { Icon } from "../../Icon.js";
import type { UndelegateRow } from "../../../shared/activity.js";
import { formatWeightBpsPercent } from "../../../shared/staking.js";

export interface UndelegateRowBodyProps {
  row: UndelegateRow;
}

function clusterName(id: number): string {
  return `C-${String(id + 1).padStart(3, "0")}.cluster.mono`;
}

export function UndelegateRowBody({ row }: UndelegateRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir in">
        <Icon name="stake" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Withdrew delegation from {clusterName(row.cluster)}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
          <span>·</span>
          <span>tx {row.txIndex}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{formatWeightBpsPercent(row.weightBps)}</div>
        <div className="sym">weight</div>
      </div>
    </div>
  );
}
