import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import { renderCounterparty, counterpartyText } from "../ActivityRow.js";
import type { TxSendRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";

export interface TxSendRowBodyProps {
  row: TxSendRow;
  counterpartyLabel: NameLabel | undefined;
}

export function TxSendRowBody({ row, counterpartyLabel }: TxSendRowBodyProps) {
  const title = `Sent ${row.amountDecimal ?? "?"} LYTH to ${counterpartyText(row.counterparty, counterpartyLabel)}`;
  return (
    <div className="ext-act-row">
      <div className="dir out sent-ok">
        <Icon name="send" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who" title={title}>
          Sent {row.amountDecimal ?? "?"} LYTH to{" "}
          {renderCounterparty(row.counterparty, counterpartyLabel)}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{row.amountDecimal ? `-${row.amountDecimal}` : "—"}</div>
        <div className="sym">LYTH</div>
      </div>
    </div>
  );
}
