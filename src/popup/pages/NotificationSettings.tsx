// Notification settings sub-page — the four notification toggles relocated
// from the main Settings list behind "Manage notifications", mirroring the
// Network operators -> Manage operators card+submenu pattern (Operators.tsx).
//
// Pure UI relocation: the toggles, their storage keys
// (mono.notifications.{os-enabled,show-details,notify-when-locked,
// badge-when-locked}.v1), their get/set IPC, and the toast/badge gating are
// all unchanged from c03e15e/ab36da3 — only WHERE they render moved.

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import {
  bgGetBadgeWhenLocked,
  bgGetIncomingEnabled,
  bgGetNotificationsOsEnabled,
  bgGetNotifyWhenLocked,
  bgGetShowDetails,
  bgSetBadgeWhenLocked,
  bgSetIncomingEnabled,
  bgSetNotificationsOsEnabled,
  bgSetNotifyWhenLocked,
  bgSetShowDetails,
} from "../bg";

interface NotificationSettingsProps {
  onBack: () => void;
}

// The Phase-5 master ("os") + three GAP-N1 toggles. The setter map keeps
// handlePickNotif a one-liner; each value mirrors its bg wrapper's signature.
type NotifKey = "os" | "details" | "notifyLocked" | "badgeLocked" | "incoming";
const NOTIF_SETTERS: Record<
  NotifKey,
  (enabled: boolean) => Promise<
    { ok: true; enabled: boolean } | { ok: false; reason?: string }
  >
> = {
  os: bgSetNotificationsOsEnabled,
  details: bgSetShowDetails,
  notifyLocked: bgSetNotifyWhenLocked,
  badgeLocked: bgSetBadgeWhenLocked,
  incoming: bgSetIncomingEnabled,
};

export function NotificationSettings({ onBack }: NotificationSettingsProps) {
  // `null` = still loading. All default ON; gate only the on-screen surfaces
  // (toast + badge) — the in-app record is always kept. Local-only.
  const [notifSettings, setNotifSettings] = useState<
    Record<NotifKey, boolean | null>
  >({ os: null, details: null, notifyLocked: null, badgeLocked: null, incoming: null });
  const [savingNotif, setSavingNotif] = useState<NotifKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Fail-open default ON if the IPC failed / SW unreachable — mirrors the
      // SW-side fail-open read so the UI never misrepresents the flags.
      const [os, details, notifyLocked, badgeLocked, incoming] = await Promise.all([
        bgGetNotificationsOsEnabled(),
        bgGetShowDetails(),
        bgGetNotifyWhenLocked(),
        bgGetBadgeWhenLocked(),
        bgGetIncomingEnabled(),
      ]);
      if (cancelled) return;
      setNotifSettings({
        os: os.ok ? os.enabled : true,
        details: details.ok ? details.enabled : true,
        notifyLocked: notifyLocked.ok ? notifyLocked.enabled : true,
        badgeLocked: badgeLocked.ok ? badgeLocked.enabled : true,
        incoming: incoming.ok ? incoming.enabled : true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePickNotif = async (key: NotifKey, next: boolean) => {
    if (savingNotif !== null || notifSettings[key] === next) return;
    setSavingNotif(key);
    const r = await NOTIF_SETTERS[key](next);
    if (r.ok) setNotifSettings((s) => ({ ...s, [key]: r.enabled }));
    setSavingNotif(null);
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Notifications
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <NotifToggleRow
            label="System notifications"
            description="Show a system notification when a transaction confirms or fails. In-app notifications are always kept."
            value={notifSettings.os}
            saving={savingNotif === "os"}
            onPick={(v) => void handlePickNotif("os", v)}
          />
          <NotifToggleRow
            label="Show transaction details"
            description="Include the amount and address in notifications. Off shows only 'Transaction confirmed' — safer on shared screens. In-app details are unaffected."
            value={notifSettings.details}
            saving={savingNotif === "details"}
            onPick={(v) => void handlePickNotif("details", v)}
          />
          <NotifToggleRow
            label="Notify while locked"
            description="Notify for transactions that confirm while the wallet is locked. Off holds them until you next unlock. In-app records are always kept."
            value={notifSettings.notifyLocked}
            saving={savingNotif === "notifyLocked"}
            onPick={(v) => void handlePickNotif("notifyLocked", v)}
          />
          <NotifToggleRow
            label="Unread badge while locked"
            description="Show the unread count on the toolbar icon while locked. The count never reveals transaction details."
            value={notifSettings.badgeLocked}
            saving={savingNotif === "badgeLocked"}
            onPick={(v) => void handlePickNotif("badgeLocked", v)}
          />
          <NotifToggleRow
            label="Incoming transfers"
            description="Show a system notification when LYTH arrives. Detected while the wallet is open; the in-app record is always kept."
            value={notifSettings.incoming}
            saving={savingNotif === "incoming"}
            onPick={(v) => void handlePickNotif("incoming", v)}
            last
          />
        </div>
      </div>
    </>
  );
}

/** One labelled On/Off toggle row. Reuses the Phase-5 pill-pair pattern;
 *  `value === null` while the setting is loading. */
function NotifToggleRow({
  label,
  description,
  value,
  saving,
  onPick,
  last,
}: {
  label: string;
  description: string;
  value: boolean | null;
  saving: boolean;
  onPick: (next: boolean) => void;
  last?: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: last ? 0 : 16,
        paddingBottom: last ? 0 : 16,
        borderBottom: last ? "none" : "1px solid var(--fg-700)",
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--fg-100)",
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-300)",
          lineHeight: 1.45,
          marginBottom: 8,
        }}
      >
        {description}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {([true, false] as const).map((val) => {
          const active = value === val;
          return (
            <button
              key={val ? "on" : "off"}
              onClick={() => onPick(val)}
              disabled={saving || value === null}
              style={{
                padding: "8px 4px",
                borderRadius: 8,
                border: active
                  ? "1px solid var(--gold)"
                  : "1px solid var(--fg-700)",
                background: active ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
                color: active ? "var(--gold)" : "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                transition: "all 150ms var(--e-out)",
              }}
            >
              {val ? "On" : "Off"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
