// Pending-row body: wallet-synthesized row from the Send
// broadcast hook (commit 8). Shown above confirmed rows until the
// indexer surfaces the matching tx_send (heuristic match in commit 1)
// or the 5-minute PENDING_TTL_MS backstop fires.
//
// The .ext-pending-dot class (ext.css, added in commit 12) gives the
// rotating amber ring indicator.

import { Icon, type IconName } from "../../Icon.js";
import { useFeature } from "../../hooks/useFeature.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import { notificationTitle } from "../../../shared/notifications.js";
import { formatFiat } from "../../../shared/fiat.js";
import { DISPLAY_CURRENCY_DEFAULT } from "../../../shared/constants.js";
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
  const devMode = useFeature("DEVELOPER_MODE");
  const opKind = row.opKind;
  // A reward claim's standard `amountDecimal` is "0" (value 0x0) and is
  // suppressed below; the claimed reward rides on the distinct `claimedAmount`
  // field (C3). The fiat sibling uses the FROZEN rate + currency captured at
  // claim time — null rate → the honest dash ("$—"), never a fabricated $0.
  const isClaim = opKind === "claim";
  const claimFig =
    isClaim && row.claimedAmount != null && row.claimedAmount !== "0"
      ? row.claimedAmount
      : null;
  const claimFiat =
    claimFig !== null
      ? formatFiat(
          claimFig,
          row.currency ?? DISPLAY_CURRENCY_DEFAULT,
          row.rateAtClaim ?? null,
        )
      : null;
  // `complete-redemption` + `emergency-key` are 0-value OUTGOING precompile
  // calls — on THIS row the user neither sends nor receives LYTH, so a
  // "0 LYTH" amount is meaningless and reads as "0 received". Suppress the
  // amount entirely (per the no-mock rule a wrong `0` is worse than none).
  // When the chain exposes the returned redemption principal as a tx_receive,
  // it auto-surfaces as a SEPARATE "Received N LYTH" incoming row — so this
  // call row must never carry an amount of its own.
  const suppressAmount =
    opKind === "complete-redemption" || opKind === "emergency-key";

  // Confirmed via the real-time receipt but the indexer hasn't surfaced the
  // canonical row yet — render it as a confirmed send (no spinner, theme-accent
  // icon, "block N") so the confirm shows at chain speed instead of sitting on
  // "Pending" through the indexer's materialization delay. This row is replaced
  // by the indexer's tx_send within a few seconds (reconcilePending drops it),
  // so it mirrors TxSendRowBody for a seamless swap.
  if (row.confirmedBlockHeight !== undefined) {
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
    const showAmount =
      !suppressAmount && !/^0(\.0+)?$/.test(row.amountDecimal);
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
                {claimFig
                  ? ` ${claimFig} LYTH`
                  : showAmount
                    ? ` ${row.amountDecimal} LYTH`
                    : ""}
                {claimFiat ? (
                  <span style={{ opacity: 0.75, marginLeft: 4 }}>({claimFiat})</span>
                ) : null}
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
          ) : claimFig ? (
            <>
              <div className="amt">{claimFig}</div>
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
  // Sealed (encrypted-mempool) txs are hidden from the indexer/Monoscan until
  // threshold reveal (~12–25s) — label that window explicitly so the row reads
  // as "in progress" rather than a bare, seemingly-stuck "Pending".
  const pendingPrefix =
    row.sealed && row.confirmedBlockHeight === undefined
      ? "Pending · awaiting reveal"
      : "Pending";
  return (
    <div className="ext-act-row">
      <div className="dir out" style={{ position: "relative" }}>
        <Icon name={isClaim ? "receive" : "send"} size={13} />
        <span className="ext-pending-dot" aria-label="pending" />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          {suppressAmount ? (
            // No "0 LYTH to <precompile>" — the send-shaped template doesn't
            // fit a 0-value precompile call. Name it by its operation instead.
            <>{pendingPrefix} · {txTypeLabel(row)}</>
          ) : isClaim ? (
            // A claim's value is 0x0 — show the claimed reward (claimedAmount)
            // not "0 LYTH to <precompile>". Fiat sibling = dash until the oracle.
            <>
              {pendingPrefix} · {notificationTitle("claim", "confirmed")}
              {claimFig ? ` ${claimFig} LYTH` : ""}
              {claimFiat ? (
                <span style={{ opacity: 0.75, marginLeft: 4 }}>({claimFiat})</span>
              ) : null}
            </>
          ) : (
            <>
              {pendingPrefix} · {row.amountDecimal} LYTH to{" "}
              {renderCounterparty(row.to, counterpartyLabel)}
            </>
          )}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>{relativeMs(row.broadcastedAtMs, Date.now())}</span>
          {devMode && (
            <>
              <span>·</span>
              <span>via {row.via}</span>
            </>
          )}
        </div>
      </div>
      <div className="ext-act-row__right">
        {isClaim ? (
          claimFig ? (
            <>
              <div className="amt">{claimFig}</div>
              <div className="sym">LYTH</div>
            </>
          ) : null
        ) : !suppressAmount ? (
          <>
            <div className="amt">{row.amountDecimal}</div>
            <div className="sym">LYTH</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
