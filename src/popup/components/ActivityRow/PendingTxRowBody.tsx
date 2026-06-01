// Pending-row body: wallet-synthesized row from the Send
// broadcast hook (commit 8). Shown above confirmed rows until the
// indexer surfaces the matching tx_send (heuristic match in commit 1)
// or the 5-minute PENDING_TTL_MS backstop fires.
//
// The .ext-pending-dot class (ext.css, added in commit 12) gives the
// rotating amber ring indicator.

import { Icon, type IconName } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import { notificationTitle } from "../../../shared/notifications.js";
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
  // Confirmed via the real-time receipt but the indexer hasn't surfaced the
  // canonical row yet — render it as a confirmed send (no spinner, theme-accent
  // icon, "block N") so the confirm shows at chain speed instead of sitting on
  // "Pending" through the indexer's materialization delay. This row is replaced
  // by the indexer's tx_send within a few seconds (reconcilePending drops it),
  // so it mirrors TxSendRowBody for a seamless swap.
  if (row.confirmedBlockHeight !== undefined) {
    const opKind = row.opKind;
    const isSend = opKind === undefined || opKind === "send";
    const isDelegation =
      opKind === "delegate" ||
      opKind === "undelegate" ||
      opKind === "redelegate";
    const iconName: IconName = isDelegation
      ? "stake"
      : opKind === "claim" || opKind === "complete-redemption"
        ? "receive"
        : "send";
    const showAmount = !/^0(\.0+)?$/.test(row.amountDecimal);
    // Cluster target for delegations (the tx `to` is the module, not the
    // cluster); the real *.cluster.mono name when captured, else #id.
    const clusterTarget = isDelegation
      ? (row.clusterName ?? (row.clusterId !== undefined ? `cluster #${row.clusterId}` : null))
      : null;
    return (
      <div className="ext-act-row">
        {/* Sends keep the theme-accent (sent-ok) like TxSendRowBody, for a
            seamless swap when the indexer's tx_send replaces this row. */}
        <div className={isSend ? "dir out sent-ok" : "dir out"}>
          <Icon name={iconName} size={13} />
        </div>
        <div className="ext-act-row__main">
          <div className="ext-act-row__who">
            {isSend ? (
              <>
                Sent {row.amountDecimal} LYTH to{" "}
                {renderCounterparty(row.to, counterpartyLabel)}
              </>
            ) : (
              <>
                {notificationTitle(opKind ?? "send", "confirmed")}
                {showAmount ? ` ${row.amountDecimal} LYTH` : ""}
                {clusterTarget ? ` · ${clusterTarget}` : ""}
              </>
            )}
          </div>
          <div className="ext-act-row__meta">
            <span>{txTypeLabel(row)}</span>
            <span>·</span>
            <span>block {row.confirmedBlockHeight.toLocaleString("en-US")}</span>
          </div>
        </div>
        <div className="ext-act-row__right">
          {isSend ? (
            <>
              <div className="amt">-{row.amountDecimal}</div>
              <div className="sym">LYTH</div>
            </>
          ) : showAmount ? (
            <>
              <div className="amt">{row.amountDecimal}</div>
              <div className="sym">LYTH</div>
            </>
          ) : null}
        </div>
      </div>
    );
  }
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
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
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
