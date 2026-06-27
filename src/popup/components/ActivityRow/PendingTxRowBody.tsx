// Pending-row body: wallet-synthesized row from the Send
// broadcast hook (commit 8). Shown above confirmed rows until the
// indexer surfaces the matching tx_send (heuristic match in commit 1)
// or the 5-minute PENDING_TTL_MS backstop fires.
//
// The .ext-pending-dot class (ext.css, added in commit 12) gives the
// rotating amber ring indicator.

import { Icon, iconForDelegationKind, type IconName } from "../../Icon.js";
import { useFeature } from "../../hooks/useFeature.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import { notificationTitle } from "../../../shared/notifications.js";
import { formatFiat } from "../../../shared/fiat.js";
import { formatLythDecimalDisplay } from "../../../shared/lyth-units.js";
import { DISPLAY_CURRENCY_DEFAULT } from "../../../shared/constants.js";
import { renderCounterparty, counterpartyText } from "../ActivityRow.js";
import { clusterLabel } from "../../../shared/staking.js";
import {
  CLAIM_PENDING_LABEL,
  delegationPendingLabel,
} from "../../../shared/activity-label.js";
import type { PendingTxRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";

export interface PendingTxRowBodyProps {
  row: PendingTxRow;
  counterpartyLabel: NameLabel | undefined;
  /** Dismiss a TERMINAL (`dropped`/`expired`) row from the list. Shown ONLY for
   *  those states — a `pending`/`slow` row is still possibly live and is never
   *  dismissible. */
  onDismiss?: () => void;
}

function relativeMs(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function PendingTxRowBody({ row, counterpartyLabel, onDismiss }: PendingTxRowBodyProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  const opKind = row.opKind;
  // Drop-detection lifecycle (display/state): the row stays VISIBLE through
  // these states instead of silently vanishing at the old 5-min TTL. A terminal
  // state drops the in-flight spinner + offers a dismiss; a `pending`/`slow` row
  // is still live (spinner stays, no dismiss).
  const lifecycle = row.lifecycle ?? "pending";
  const isTerminalLifecycle = lifecycle === "dropped" || lifecycle === "expired";
  const lifecycleNote =
    lifecycle === "slow"
      ? "taking longer than usual"
      : lifecycle === "dropped"
        ? "Didn't confirm (replaced or dropped)"
        : lifecycle === "expired"
          ? "Status unknown — taking unusually long"
          : null;
  const isDelegationKind =
    opKind === "delegate" || opKind === "undelegate" || opKind === "redelegate";
  // Pending delegation labels resolve the cluster via the CAPTURED name (the
  // pending row carries no live directory) → the real *.cluster.mono name or an
  // honest `Cluster #<id>`. Redelegate also carries the captured destination.
  const pendingSrcLabel =
    row.clusterId !== undefined
      ? clusterLabel(row.clusterId, row.clusterName)
      : (row.clusterName ?? "the cluster");
  const pendingDstLabel =
    row.toClusterId !== undefined
      ? clusterLabel(row.toClusterId, row.toClusterName)
      : undefined;
  // A reward claim's standard `amountDecimal` is "0" (value 0x0) and is
  // suppressed below; the claimed reward rides on the distinct `claimedAmount`
  // field (C3). The fiat sibling uses the FROZEN rate + currency captured at
  // claim time — null rate → the honest dash ("$—"), never a fabricated $0.
  const isClaim = opKind === "claim";
  // Treat null / undefined / "" / "0" as "no figure yet" (the amount is decoded
  // from the receipt's Claimed log after confirmation) — never render a "0".
  const claimFig =
    isClaim && row.claimedAmount && row.claimedAmount !== "0"
      ? row.claimedAmount
      : null;
  // Display the claimed reward truncated to the wallet's 4-dp standard (the full
  // value stays canonical in the store); fiat still uses the precise figure.
  const claimFigDisplay =
    claimFig !== null ? formatLythDecimalDisplay(claimFig, 4) : null;
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
      ? iconForDelegationKind(opKind as "delegate" | "undelegate" | "redelegate")
      : opKind === "claim"
        ? "reward"
        : opKind === "complete-redemption"
          ? "receive"
          : "send";
    const showAmount =
      !suppressAmount && !/^0(\.0+)?$/.test(row.amountDecimal);
    // Cluster target for delegations (the tx `to` is the module, not the
    // cluster); the real *.cluster.mono name when captured, else #id.
    const clusterTarget = isDelegation
      ? (row.clusterName ?? (row.clusterId !== undefined ? `cluster #${row.clusterId}` : null))
      : null;
    // Plain-text label for the `title` hover (mirrors the rendered line).
    const bridgedTitle = isSend
      ? `Sent ${row.amountDecimal} LYTH to ${counterpartyText(row.to, counterpartyLabel)}`
      : `${notificationTitle(opKind ?? "send", "confirmed")}${
          claimFigDisplay
            ? ` +${claimFigDisplay} LYTH`
            : showAmount
              ? ` ${row.amountDecimal} LYTH`
              : ""
        }${clusterTarget ? ` · ${clusterTarget}` : ""}`;
    return (
      <div className="ext-act-row">
        {/* Sends keep the theme-accent (sent-ok) like TxSendRowBody, for a
            seamless swap when the indexer's tx_send replaces this row. */}
        <div
          className={
            isClaim ? "dir in" : isSend ? "dir out sent-ok" : "dir out"
          }
        >
          <Icon name={iconName} size={13} />
        </div>
        <div className="ext-act-row__main">
          <div className="ext-act-row__who" title={bridgedTitle}>
            {isSend ? (
              <>
                Sent {row.amountDecimal} LYTH to{" "}
                {renderCounterparty(row.to, counterpartyLabel)}
              </>
            ) : (
              <>
                {notificationTitle(opKind ?? "send", "confirmed")}
                {claimFigDisplay
                  ? ` +${claimFigDisplay} LYTH`
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
          ) : claimFigDisplay ? (
            <>
              <div className="amt in">+{claimFigDisplay}</div>
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
  const pendingPrefix = "Pending";
  // Plain-text label for the `title` hover (mirrors the rendered pending line).
  const pendingWhoTitle = suppressAmount
    ? `${pendingPrefix} · ${txTypeLabel(row)}`
    : isClaim
      ? `${CLAIM_PENDING_LABEL}${claimFigDisplay ? ` +${claimFigDisplay} LYTH` : ""}`
      : isDelegationKind
        ? delegationPendingLabel(
            opKind as "delegate" | "undelegate" | "redelegate",
            row.delegationWeightBps,
            pendingSrcLabel,
            pendingDstLabel,
          )
        : `Sending · ${row.amountDecimal} LYTH to ${counterpartyText(row.to, counterpartyLabel)}`;
  return (
    <div className="ext-act-row">
      <div className={isClaim ? "dir in" : "dir out"} style={{ position: "relative" }}>
        <Icon
          name={
            isClaim
              ? "reward"
              : isDelegationKind
                ? iconForDelegationKind(opKind as "delegate" | "undelegate" | "redelegate")
                : "send"
          }
          size={13}
        />
        {/* In-flight spinner only while still possibly live; a terminal
            (dropped/expired) row is settled, so the spinner is dropped. */}
        {!isTerminalLifecycle && (
          <span className="ext-pending-dot" aria-label="pending" />
        )}
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who" title={pendingWhoTitle}>
          {suppressAmount ? (
            // No "0 LYTH to <precompile>" — the send-shaped template doesn't
            // fit a 0-value precompile call. Name it by its operation instead.
            <>{pendingPrefix} · {txTypeLabel(row)}</>
          ) : isClaim ? (
            // A claim's value is 0x0 — show the claimed reward (claimedAmount)
            // not "0 LYTH to <precompile>". Fiat sibling = dash until the oracle.
            <>
              {CLAIM_PENDING_LABEL}
              {claimFigDisplay ? ` +${claimFigDisplay} LYTH` : ""}
              {claimFiat ? (
                <span style={{ opacity: 0.75, marginLeft: 4 }}>({claimFiat})</span>
              ) : null}
            </>
          ) : isDelegationKind ? (
            // Delegation tx: value 0 + the `to` is the module, so the "0 LYTH to
            // <module>" template is meaningless — name the action + the cluster
            // (+ the % when captured) via the shared present-continuous builder.
            delegationPendingLabel(
              opKind as "delegate" | "undelegate" | "redelegate",
              row.delegationWeightBps,
              pendingSrcLabel,
              pendingDstLabel,
            )
          ) : (
            <>
              Sending · {row.amountDecimal} LYTH to{" "}
              {renderCounterparty(row.to, counterpartyLabel)}
            </>
          )}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>{relativeMs(row.broadcastedAtMs, Date.now())}</span>
          {lifecycleNote && (
            <>
              <span>·</span>
              <span
                style={
                  isTerminalLifecycle ? { color: "var(--err)" } : undefined
                }
              >
                {lifecycleNote}
              </span>
            </>
          )}
          {devMode && (
            <>
              <span>·</span>
              <span>via {row.via}</span>
            </>
          )}
        </div>
        {/* Terminal rows are kept VISIBLE (never a silent vanish) and offer a
            dismiss; they also auto-clear after the bounded retain window. */}
        {isTerminalLifecycle && onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            style={{
              marginTop: 4,
              alignSelf: "flex-start",
              padding: "2px 8px",
              fontSize: 10.5,
              borderRadius: 6,
              border: "1px solid var(--fg-700)",
              background: "transparent",
              color: "var(--fg-300)",
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="ext-act-row__right">
        {isClaim ? (
          claimFigDisplay ? (
            <>
              <div className="amt in">+{claimFigDisplay}</div>
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
