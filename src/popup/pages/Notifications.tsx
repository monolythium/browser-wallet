// Phase 3 — Notifications center.
//
// Global inbox surface: reads every `mono.notifications.history.*`
// envelope's entries (merged newest-first by SW-side
// `listAllNotifications`) and renders one row per record. Unread rows
// carry a small blue dot at the bottom-left. The header CTA flips every
// record across every scope to `read: true` via `bgMarkAllNotificationsRead`,
// then re-fetches so the dots clear immediately and the toolbar pip
// updates (the SW fires `refreshUnreadBadge` after the mark).
//
// Phase 4 (C5) wires the per-row ▸ expander → `NotificationDetail` popup.
// Phase 5 may add a per-item read-on-view + a settings toggle.
//
// §0.4 holds: this page is READ-ONLY against the notifications store —
// it never creates a notification. The store's write IPC surface is
// just `notifications-mark-all-read`; record creation stays SW-only.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon, type IconName } from "../Icon";
import {
  bgListNotifications,
  bgMarkAllNotificationsRead,
  type NotificationRecord,
  type TxOpKind,
} from "../bg";
import { bech32mDisplay } from "../../shared/bech32m";
import { notificationTitle } from "../../shared/notifications";

interface NotificationsProps {
  onBack: () => void;
}

/** Middle-truncate any string (hash / bech32m / 0x) for compact display.
 *  Pure — never throws. Identical to the helper currently inlined in
 *  `ActivityDetail.tsx`; C4 extracts both into a shared module. */
function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Relative timestamp ("2m ago" / "3h ago" / "yesterday"). Identical to
 *  the helper currently inlined in `ActivityDetail.tsx`; C4 extracts
 *  both into a shared module. */
function relativeMs(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 3_600_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = Math.floor(delta / (24 * 3_600_000));
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Per-kind glyph for the row's leading badge. */
function iconForKind(kind: TxOpKind): IconName {
  switch (kind) {
    case "send":
      return "send";
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

/** Status-tinted ring around the badge. Confirmed = green (--ok),
 *  failed = red (--err). Keeps the row scannable at a glance. */
function badgeRingColor(status: "confirmed" | "failed"): string {
  return status === "failed" ? "var(--err, #dc5050)" : "var(--ok, #7ee3c1)";
}

/** True for amount strings that mean "zero LYTH". The body omits the
 *  amount in this case so a 0-LYTH claim/agent-policy reads cleanly.
 *  Mirrors the helper in `background/notifications-os.ts`. */
function isZeroAmount(amountDecimal: string): boolean {
  if (amountDecimal.length === 0) return true;
  return /^0(\.0+)?$/.test(amountDecimal);
}

export function Notifications({ onBack }: NotificationsProps) {
  const [records, setRecords] = useState<NotificationRecord[] | null>(null);
  const [marking, setMarking] = useState(false);

  const refresh = useCallback(async () => {
    const r = await bgListNotifications();
    setRecords(r.ok ? r.records : []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleMarkAllRead = useCallback(async () => {
    setMarking(true);
    await bgMarkAllNotificationsRead();
    await refresh();
    setMarking(false);
  }, [refresh]);

  const hasUnread = (records ?? []).some((r) => !r.read);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Notifications
        </div>
        {hasUnread ? (
          <button
            type="button"
            onClick={() => void handleMarkAllRead()}
            disabled={marking}
            style={markAllReadBtn}
            title="Mark all as read"
          >
            Mark all as read
          </button>
        ) : (
          <div style={{ width: 28 }} />
        )}
      </div>

      <div className="ext-body">
        {records === null ? (
          <div style={loadingStyle}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={emptyStyle}>No notifications yet</div>
        ) : (
          <div className="ext-card" style={{ padding: "4px 12px" }}>
            {records.map((rec) => (
              <NotificationRow key={rec.id} record={rec} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function NotificationRow({ record }: { record: NotificationRecord }) {
  const title = notificationTitle(record.kind, record.status);
  const short = truncMiddle(bech32mDisplay(record.counterparty));
  const showAmount = !isZeroAmount(record.amountDecimal);

  return (
    <div className="ext-act-row" style={{ position: "relative" }}>
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
          color: badgeRingColor(record.status),
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <Icon name={iconForKind(record.kind)} size={13} />
      </div>

      <div className="ext-act-row__main" style={{ minWidth: 0 }}>
        <div
          className="ext-act-row__who"
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
          {showAmount ? `${record.amountDecimal} LYTH · ${short}` : short}
        </div>
      </div>

      <div
        className="ext-act-row__right"
        style={{
          fontSize: 10.5,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
        }}
      >
        {relativeMs(record.createdAtMs)}
      </div>

      {!record.read && <span className="ext-unread" aria-label="Unread" />}
    </div>
  );
}

const markAllReadBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--gold, #f4c97a)",
  fontSize: 11.5,
  fontFamily: "var(--f-sans)",
  fontWeight: 600,
  cursor: "pointer",
  padding: "4px 6px",
};

const loadingStyle: CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  color: "var(--fg-400)",
  fontSize: 12,
  fontFamily: "var(--f-mono)",
};

const emptyStyle: CSSProperties = {
  padding: "48px 16px",
  textAlign: "center",
  color: "var(--fg-400)",
  fontSize: 12.5,
  fontFamily: "var(--f-sans)",
};
