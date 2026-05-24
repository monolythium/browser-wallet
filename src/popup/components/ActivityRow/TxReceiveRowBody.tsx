import { Icon } from "../../Icon.js";
import { renderCounterparty } from "../ActivityRow.js";
import type { TxReceiveRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";

export interface TxReceiveRowBodyProps {
  row: TxReceiveRow;
  counterpartyLabel: NameLabel | undefined;
}

export function TxReceiveRowBody({ row, counterpartyLabel }: TxReceiveRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir in">
        <Icon name="receive" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Received {row.amountDecimal ?? "?"} LYTH from{" "}
          {renderCounterparty(row.counterparty, counterpartyLabel)}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
          <span>·</span>
          <span>tx {row.txIndex}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt in">{row.amountDecimal ? `+${row.amountDecimal}` : "—"}</div>
        <div className="sym">LYTH</div>
      </div>
    </div>
  );
}
