// Shared notification/tx row — the polished `.ext-act-row` row used by both
// the Notifications center and the Activity list's failed-tx rows. Renders a
// status-ringed kind badge, the friendly title (notificationTitle), an
// amount · counterparty meta line, a relative timestamp + chevron, and an
// optional unread dot. Tapping it opens the shared `NotificationDetail` popup
// at the call site.

import { Icon, type IconName } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import {
  notificationTitle,
  type NotificationRecord,
  type TxOpKind,
} from "../../shared/notifications";
import { txTypeLabelForOpKind } from "../../shared/tx-type-label";
import { relativeMs } from "./_detailModalParts";

/** Middle-truncate any string (hash / bech32m / 0x) for compact display. */
function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Per-kind glyph for the row's leading badge. */
function iconForKind(kind: TxOpKind): IconName {
  switch (kind) {
    case "send":
      return "send";
    case "receive":
      return "receive";
    case "delegate":
    case "undelegate":
    case "redelegate":
      return "stake";
    case "claim":
      return "receive";
    case "emergency-key":
      return "shield";
    case "agent-policy":
      return "settings";
    case "contract_call":
    default:
      return "contract";
  }
}

/** Status-tinted ring around the badge. Confirmed = green (--ok), failed =
 *  red (--err). Keeps the row scannable at a glance. */
function badgeRingColor(status: "confirmed" | "failed"): string {
  return status === "failed" ? "var(--err, #dc5050)" : "var(--ok, #7ee3c1)";
}

/** Item 6 — an OUTGOING + CONFIRMED (successful sent) record's icon glyph takes
 *  the theme accent (var(--gold)). The status ring stays green; failed (red)
 *  and incoming ("receive", green) are untouched. All current op kinds are
 *  outgoing; the `receive` kind (Item 7a) is excluded so incoming stays green. */
function isOutgoingConfirmed(record: NotificationRecord): boolean {
  return record.status === "confirmed" && record.kind !== "receive";
}

/** True for amount strings that mean "zero LYTH" — the body omits the amount
 *  so a 0-LYTH claim / agent-policy reads cleanly. */
function isZeroAmount(amountDecimal: string): boolean {
  if (amountDecimal.length === 0) return true;
  return /^0(\.0+)?$/.test(amountDecimal);
}

export function NotificationRow({
  record,
  onOpen,
  /** Show the unread dot (notification center). The Activity list passes
   *  false — it isn't the read surface. */
  showUnread = true,
}: {
  record: NotificationRecord;
  onOpen: () => void;
  showUnread?: boolean;
}) {
  const title = notificationTitle(record.kind, record.status);
  // Delegation rows (delegate/undelegate/redelegate) target a cluster, but the
  // tx `to` is the delegation module — prefer the captured cluster name (or
  // #id) over the raw module address. Fall back to the address when a record
  // predates cluster capture (no metadata) — never blank.
  const isDelegation =
    record.kind === "delegate" ||
    record.kind === "undelegate" ||
    record.kind === "redelegate";
  const clusterLabel =
    isDelegation && record.clusterId !== undefined
      ? (record.clusterName ?? `#${record.clusterId}`)
      : null;
  const short = clusterLabel ?? truncMiddle(bech32mDisplay(record.counterparty));
  const showAmount = !isZeroAmount(record.amountDecimal);
  // Type-noun on the meta line (Outgoing transfer / Stake / …), before the
  // amount · counterparty. Same vocabulary the Activity detail + rows use.
  const typeNoun = txTypeLabelForOpKind(record.kind);
  const metaText = showAmount
    ? `${typeNoun} · ${record.amountDecimal} LYTH · ${short}`
    : `${typeNoun} · ${short}`;

  return (
    <div
      className="ext-act-row"
      style={{ position: "relative" }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div
        className="dir"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: `1px solid ${badgeRingColor(record.status)}`,
          color: isOutgoingConfirmed(record)
            ? "var(--gold)"
            : badgeRingColor(record.status),
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <Icon name={iconForKind(record.kind)} size={13} />
      </div>

      <div className="ext-act-row__main" style={{ minWidth: 0 }}>
        <div
          className="ext-act-row__who"
          title={title}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg-100)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div
          className="ext-act-row__meta"
          title={metaText}
          style={{
            fontSize: 10.5,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {metaText}
        </div>
      </div>

      <div
        className="ext-act-row__right"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10.5,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
        }}
      >
        <span>{relativeMs(record.createdAtMs)}</span>
        <span aria-hidden style={{ display: "inline-flex", color: "var(--fg-400)" }}>
          <Icon name="chev" size={12} />
        </span>
      </div>

      {showUnread && !record.read && (
        <span className="ext-unread" aria-label="Unread" />
      )}
    </div>
  );
}
