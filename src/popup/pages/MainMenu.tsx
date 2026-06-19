// MetaMask-style hamburger main menu.
//
// One screen, logical sections:
//   1. Quick action — Notifications, full screen, popup/sidebar toggle.
//   2. Manage — Contacts, Connected sites, Networks, Multisig, RISC-V.
//   3. Security — Security, Features, Emergency recovery.
//   4. Settings — Settings, Display & Preferences, Operators.
//   5. Info — About, Resources, Why Monolythium.
//   6. Danger — Lock wallet, Reset wallet (red).
//
// Routing lives in App.tsx via a screen-stack so back-navigation from
// any sub-screen reached via this menu returns HERE, not to home. See
// returns HERE, not to home.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../Icon";
import type { UiOpenMode } from "../bg";
import { bgGetUnread } from "../bg";

interface MainMenuProps {
  /** Current ui-mode (sidebar vs popup) so the toggle item can label
   *  itself as the OPPOSITE option ("Switch to popup" when currently
   *  in sidebar, vice versa). */
  uiMode: UiOpenMode | null;
  onBack: () => void;
  onSwitchMode: () => void;
  /** Open the wallet in a regular Chrome tab via
   *  chrome.tabs.create with ?mode=fullscreen. Always available. */
  onOpenFullscreen: () => void;
  onContacts: () => void;
  onConnectedSites: () => void;
  onNetworks: () => void;
  /** Open the Operators directory (read-only operator health + risk
   *  legend, with a link through to the RPC-override editor). */
  onOperators: () => void;
  /** Optional — landing page for the Multisig top-level
   *  list. When omitted the menu item is hidden (Multisig is
   *  in a follow-up commit). */
  onMultisig?: () => void;
  /** Optional — automation spending-limits management. Dev-gated; when
   *  omitted (or developer mode is off) the menu item is hidden. */
  onAgentPolicy?: () => void;
  onSettings: () => void;
  /** Opens the Display & Preferences hub (theme / language / display
   *  currency) — the same hub the Settings page routes to. */
  onDisplayPreferences: () => void;
  onAbout: () => void;
  /** Optional — passkey / security policy page (§28.5). Vault-gated, so the
   *  row hides when no active vault is selected. */
  onOpenSecurity?: () => void;
  /** Optional — two-tier UX feature-flag toggles page. */
  onOpenFeatures?: () => void;
  /** Optional — RISC-V (MRV native) contract plan preview page. */
  onOpenRiscv?: () => void;
  /** Optional — SLH-DSA emergency-recovery page. Vault-gated (the editor
   *  needs an active vault), so the row hides without one. */
  onEmergencyRecovery?: () => void;
  /** External resources / links page (docs, explorer, repo). */
  onResources: () => void;
  /** "About Monolythium" page — the §28.5 differentiation pitch. */
  onWhyMonolythium: () => void;
  onLockWallet: () => void;
  /** Destructive reset entry at the very bottom of
   *  the menu. Reuses the existing ResetWallet screen (password reauth
   *  + DELETE confirm); the hamburger surface only navigates there. */
  onResetWallet: () => void;
  /** Notifications — open the Notifications page. When omitted
   *  the bell row is hidden (test harnesses / pre-wired callers). */
  onNotifications?: () => void;
}

export function MainMenu({
  uiMode,
  onBack,
  onSwitchMode,
  onOpenFullscreen,
  onContacts,
  onConnectedSites,
  onNetworks,
  onOperators,
  onMultisig,
  onAgentPolicy,
  onSettings,
  onDisplayPreferences,
  onAbout,
  onOpenSecurity,
  onOpenFeatures,
  onOpenRiscv,
  onEmergencyRecovery,
  onResources,
  onWhyMonolythium,
  onLockWallet,
  onResetWallet,
  onNotifications,
}: MainMenuProps) {
  const switchLabel =
    uiMode === null
      ? "Switch window mode"
      : uiMode === "popup"
        ? "Switch to sidebar"
        : "Switch to popup";

  // Unread count for the bell row's pill. Fetched once on
  // mount; the value is read-only here (mutation lives on the
  // Notifications page via "Mark all as read"). Stays `null` until the
  // IPC resolves so the pill doesn't flash a zero on every menu open.
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!onNotifications) return;
    let cancelled = false;
    void (async () => {
      const r = await bgGetUnread();
      if (cancelled) return;
      setUnread(r.ok ? r.count : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [onNotifications]);

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
          Menu
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body" style={{ paddingTop: 4 }}>
        <MenuSection>
          {onNotifications && (
            <MenuItem
              icon="bell"
              label="Notifications"
              onClick={onNotifications}
              hasChevron
              rightSlot={
                unread !== null && unread > 0 ? (
                  <UnreadPill count={unread} />
                ) : undefined
              }
            />
          )}
          <MenuItem
            icon="display"
            label="Open full screen"
            onClick={onOpenFullscreen}
          />
          <MenuItem icon="expand" label={switchLabel} onClick={onSwitchMode} />
        </MenuSection>

        <MenuSection title="Manage">
          <MenuItem
            icon="contacts"
            label="Contacts"
            onClick={onContacts}
            hasChevron
          />
          <MenuItem
            icon="globe"
            label="Connected sites"
            onClick={onConnectedSites}
            hasChevron
          />
          <MenuItem
            icon="network"
            label="Networks"
            onClick={onNetworks}
            hasChevron
          />
          {onMultisig && (
            <MenuItem
              icon="multisig"
              label="Multisig wallets"
              onClick={onMultisig}
              hasChevron
            />
          )}
          {onOpenRiscv && (
            <MenuItem
              icon="contract"
              label="RISC-V"
              onClick={onOpenRiscv}
              hasChevron
            />
          )}
          {onAgentPolicy && (
            <MenuItem
              icon="settings"
              label="Automation spending limits"
              onClick={onAgentPolicy}
              hasChevron
            />
          )}
        </MenuSection>

        <MenuSection title="Security">
          {onOpenSecurity && (
            <MenuItem
              icon="shield"
              label="Security"
              onClick={onOpenSecurity}
              hasChevron
            />
          )}
          {onOpenFeatures && (
            <MenuItem
              icon="sliders"
              label="Features"
              onClick={onOpenFeatures}
              hasChevron
            />
          )}
          {onEmergencyRecovery && (
            <MenuItem
              icon="tpm"
              label="Emergency recovery"
              onClick={onEmergencyRecovery}
              hasChevron
            />
          )}
        </MenuSection>

        <MenuSection title="Settings">
          <MenuItem
            icon="settings"
            label="Settings"
            onClick={onSettings}
            hasChevron
          />
          <MenuItem
            icon="palette"
            label="Display & Preferences"
            onClick={onDisplayPreferences}
            hasChevron
          />
          <MenuItem
            icon="server"
            label="Operators"
            onClick={onOperators}
            hasChevron
          />
        </MenuSection>

        <MenuSection title="Info">
          <MenuItem icon="info" label="About" onClick={onAbout} hasChevron />
          <MenuItem
            icon="external"
            label="Resources"
            onClick={onResources}
            hasChevron
          />
          <MenuItem
            icon="gem"
            label="Why Monolythium"
            onClick={onWhyMonolythium}
            hasChevron
          />
        </MenuSection>

        <MenuSection>
          <MenuItem
            icon="lock"
            label="Lock wallet"
            onClick={onLockWallet}
            danger
          />
          {/* Destructive reset. Routes to the existing ResetWallet screen
             (password reauth + typed "DELETE" confirm); the hamburger entry
             only navigates there. */}
          <MenuItem
            icon="trash"
            label="Reset wallet"
            onClick={onResetWallet}
            danger
            hasChevron
          />
        </MenuSection>
      </div>
    </>
  );
}

function MenuSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "8px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {title && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-400)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "6px 14px 4px",
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

interface MenuItemProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  hasChevron?: boolean;
  danger?: boolean;
  /** Optional content rendered BEFORE the chevron (e.g. an
   *  unread-count pill on the bell row). */
  rightSlot?: ReactNode;
}

function MenuItem({
  icon,
  label,
  onClick,
  hasChevron,
  danger,
  rightSlot,
}: MenuItemProps) {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    padding: "12px 14px",
    background: "transparent",
    border: "none",
    color: danger ? "var(--err, #ff8a9a)" : "var(--fg-100)",
    fontSize: 13.5,
    fontWeight: 500,
    fontFamily: "var(--f-sans)",
    cursor: "pointer",
    transition: "background 0.15s",
    textAlign: "left",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.04)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      style={style}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          color: danger ? "var(--err, #ff8a9a)" : "var(--fg-300)",
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={16} />
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {rightSlot !== undefined && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {rightSlot}
        </span>
      )}
      {hasChevron && (
        <span
          style={{
            color: "var(--fg-400)",
            display: "inline-flex",
            flexShrink: 0,
          }}
        >
          <Icon name="chev" size={12} />
        </span>
      )}
    </button>
  );
}

/** Small red pill rendering the unread notification count next to the
 *  bell row. Matches the toolbar badge palette (`#dc5050`); kept inline
 *  so it ships with the menu and stays a single source of truth for
 *  the pill chrome. */
function UnreadPill({ count }: { count: number }) {
  // Cap at 99+ so a hypothetical large inbox doesn't blow the layout.
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 6px",
        borderRadius: 9,
        background: "#dc5050",
        color: "#fff",
        fontSize: 10.5,
        fontWeight: 700,
        fontFamily: "var(--f-sans)",
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  );
}
