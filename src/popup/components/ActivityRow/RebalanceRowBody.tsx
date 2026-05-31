// Auto-rebalance row (§23.7 cap tightening). Reserved kind — the chain
// does not currently emit these events on Sprintnet. The union member
// exists so future cap-schedule transitions can render without a
// wallet code change.

import { Icon } from "../../Icon.js";
import type { RebalanceRow } from "../../../shared/activity.js";

export interface RebalanceRowBodyProps {
  row: RebalanceRow;
}

export function RebalanceRowBody({ row }: RebalanceRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir out">
        <Icon name="swap" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">Auto-rebalanced (cap tightening)</div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">
          {row.weightBps !== null ? `${row.weightBps} bps` : "—"}
        </div>
        <div className="sym">rebalance</div>
      </div>
    </div>
  );
}
