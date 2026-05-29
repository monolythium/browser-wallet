// Round 7 TASK 4 — MetaMask-style hamburger main menu.
//
// One screen, three logical sections:
//   1. Quick action — "Switch to popup/sidebar" mode toggle.
//   2. Manage — Contacts, Connected sites, Networks, Multisig.
//   3. Settings — Settings page, About.
//   4. Danger — Lock wallet (red).
//
// Routing lives in App.tsx via a screen-stack so back-navigation from
// any sub-screen reached via this menu returns HERE, not to home. See
// Round 7 TASK 4 acceptance notes.

import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../Icon";
import type { UiOpenMode } from "../bg";

interface MainMenuProps {
  /** Current ui-mode (sidebar vs popup) so the toggle item can label
   *  itself as the OPPOSITE option ("Switch to popup" when currently
   *  in sidebar, vice versa). */
  uiMode: UiOpenMode | null;
  onBack: () => void;
  onSwitchMode: () => void;
  /** Round 8 TASK 3 — open the wallet in a regular Chrome tab via
   *  chrome.tabs.create with ?mode=fullscreen. Always available. */
  onOpenFullscreen: () => void;
  onContacts: () => void;
  onConnectedSites: () => void;
  onNetworks: () => void;
  /** Optional — landing page for the Round 7 TASK 7 Multisig top-level
   *  list. When omitted the menu item is hidden (TASK 4 ships TASK 7
   *  in a follow-up commit). */
  onMultisig?: () => void;
  /** Optional — §18.8 agent spending-policy management. When omitted
   *  the menu item is hidden (advanced agent-commerce UX). */
  onAgentPolicy?: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onLockWallet: () => void;
  /** Round 11 TASK 3 — destructive reset entry at the very bottom of
   *  the menu. Reuses the existing ResetWallet screen (password reauth
   *  + DELETE confirm); the hamburger surface only navigates there. */
  onResetWallet: () => void;
}

export function MainMenu({
  uiMode,
  onBack,
  onSwitchMode,
  onOpenFullscreen,
  onContacts,
  onConnectedSites,
  onNetworks,
  onMultisig,
  onAgentPolicy,
  onSettings,
  onAbout,
  onLockWallet,
  onResetWallet,
}: MainMenuProps) {
  const switchLabel =
    uiMode === null
      ? "Switch window mode"
      : uiMode === "popup"
        ? "Switch to sidebar"
        : "Switch to popup";

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
          Menu
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body" style={{ paddingTop: 4 }}>
        <MenuSection>
          <MenuItem
            icon="expand"
            label="Open full screen"
            onClick={onOpenFullscreen}
          />
          <MenuItem icon="display" label={switchLabel} onClick={onSwitchMode} />
        </MenuSection>

        <MenuSection title="Manage">
          <MenuItem
            icon="book"
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
            icon="bridge"
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
          {onAgentPolicy && (
            <MenuItem
              icon="settings"
              label="Agent spending policy"
              onClick={onAgentPolicy}
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
          <MenuItem icon="info" label="About" onClick={onAbout} hasChevron />
        </MenuSection>

        <MenuSection>
          <MenuItem
            icon="lock"
            label="Lock wallet"
            onClick={onLockWallet}
            danger
          />
          {/* Round 11 TASK 3 — destructive reset. Routes to the
             existing ResetWallet screen which already requires
             password reauth + a typed "DELETE" confirm before the
             wipe runs. The hamburger entry just navigates there; no
             extra modal needed since the existing screen has a
             stronger gate than a checkbox ack would. */}
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
}

function MenuItem({
  icon,
  label,
  onClick,
  hasChevron,
  danger,
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
