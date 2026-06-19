// Notifications center.
//
// Global inbox surface: reads every `mono.notifications.history.*`
// envelope's entries (merged newest-first by SW-side
// `listAllNotifications`) and renders one row per record. Unread rows
// carry a small blue dot at the bottom-left. The header CTA flips every
// record across every scope to `read: true` via `bgMarkAllNotificationsRead`,
// then re-fetches so the dots clear immediately and the toolbar pip
// updates (the SW fires `refreshUnreadBadge` after the mark).
//
// The per-row ▸ expander opens the `NotificationDetail` popup.
// A per-item read-on-view + a settings toggle may be added later.
//
// §0.4 holds: this page is READ-ONLY against the notifications store —
// it never creates a notification. The store's write IPC surface is
// just `notifications-mark-all-read`; record creation stays SW-only.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import {
  bgListNotifications,
  bgMarkAllNotificationsRead,
  bgMarkNotificationRead,
  type NotificationRecord,
} from "../bg";
import { NotificationDetail } from "../components/NotificationDetail";
import { NotificationRow } from "../components/NotificationRow";

interface NotificationsProps {
  onBack: () => void;
}

export function Notifications({ onBack }: NotificationsProps) {
  const [records, setRecords] = useState<NotificationRecord[] | null>(null);
  const [marking, setMarking] = useState(false);
  const [selected, setSelected] = useState<NotificationRecord | null>(null);

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

  // Opening a record's detail also marks JUST that record
  // read. The SW fires refreshUnreadBadge on a successful flip; here we
  // optimistically update the local list so the row's blue dot clears
  // before the chrome.storage.onChanged callback rolls around (the
  // top-bar bell dot updates via that listener on its own).
  const handleOpenRecord = useCallback((rec: NotificationRecord) => {
    setSelected(rec);
    if (rec.read) return;
    void (async () => {
      const r = await bgMarkNotificationRead(rec.id);
      if (r.ok && r.flipped) {
        setRecords((prev) =>
          prev
            ? prev.map((x) => (x.id === rec.id ? { ...x, read: true } : x))
            : prev,
        );
      }
    })();
  }, []);

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
            fontSize: 16,
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
              <NotificationRow
                key={rec.id}
                record={rec}
                onOpen={() => handleOpenRecord(rec)}
              />
            ))}
          </div>
        )}
      </div>

      {selected !== null && (
        <NotificationDetail
          record={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
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
