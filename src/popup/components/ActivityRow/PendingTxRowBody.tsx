// Pending-row body: wallet-synthesized row from the Phase 4.4 Send
// broadcast hook (commit 8). Shown above confirmed rows until the
// indexer surfaces the matching tx_send (heuristic match in commit 1)
// or the 5-minute PENDING_TTL_MS backstop fires.
//
// The .ext-pending-dot class (ext.css, added in commit 12) gives the
// rotating amber ring indicator.

import { Icon } from "../../Icon.js";
import { renderCounterparty } from "../ActivityRow.js";
import type { PendingTxRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";

export interface PendingTxRowBodyProps {
  row: PendingTxRow;
  counterpartyLabel: NameLabel | undefined;
}

function relativeMs(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function PendingTxRowBody({ row, counterpartyLabel }: PendingTxRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir out" style={{ position: "relative" }}>
        <Icon name="send" size={13} />
        <span className="ext-pending-dot" aria-label="pending" />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Pending · {row.amountDecimal} LYTH to{" "}
          {renderCounterparty(row.to, counterpartyLabel)}
        </div>
        <div className="ext-act-row__meta">
          <span>{relativeMs(row.broadcastedAtMs, Date.now())}</span>
          <span>·</span>
          <span>via {row.via}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{row.amountDecimal}</div>
        <div className="sym">LYTH</div>
      </div>
    </div>
  );
}
