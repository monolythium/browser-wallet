import { Icon } from "../../Icon.js";
import { renderCounterparty } from "../ActivityRow.js";
import type { TokenTransferRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";

export interface TokenTransferRowBodyProps {
  row: TokenTransferRow;
  counterpartyLabel: NameLabel | undefined;
}

function shortTokenId(tokenId: string): string {
  if (tokenId.length <= 14) return tokenId;
  return `${tokenId.slice(0, 8)}…${tokenId.slice(-4)}`;
}

export function TokenTransferRowBody({ row, counterpartyLabel }: TokenTransferRowBodyProps) {
  const isOut = row.direction === "out";
  const isIn = row.direction === "in";
  const verb = isOut ? "Sent" : isIn ? "Received" : "Transferred";
  const prep = isOut ? "to" : isIn ? "from" : "with";
  return (
    <div className="ext-act-row">
      <div className={`dir ${isIn ? "in" : "out"}`}>
        <Icon name="swap" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          {verb} tokens ({shortTokenId(row.tokenId)}) {prep}{" "}
          {renderCounterparty(row.counterparty, counterpartyLabel)}
        </div>
        <div className="ext-act-row__meta">
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
          <span>·</span>
          <span>tx {row.txIndex}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className={`amt ${isIn ? "in" : ""}`}>
          {row.amountDecimal
            ? `${isOut ? "-" : isIn ? "+" : ""}${row.amountDecimal}`
            : "—"}
        </div>
        <div className="sym">{shortTokenId(row.tokenId)}</div>
      </div>
    </div>
  );
}
