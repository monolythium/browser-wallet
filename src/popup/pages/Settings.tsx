import { useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import { type SignAlgo } from "../bg";
import { CheckIcon, ClipboardIcon } from "../components/AddressLine";
import { WalletSecurityControls } from "../components/WalletSecurityControls";
import { DeveloperModeToggle } from "../components/DeveloperModeToggle";

interface SettingsProps {
  onBack: () => void;
  address: string;
  algo: SignAlgo;
  /** Routes to the RevealPhrase page. v4 strict guarantees every vault
   *  is revealable, so this is always wired. */
  onShowPhrase: () => void;
  /** Routes to the ConnectedSites page. */
  onShowConnectedSites: () => void;
  /** Routes to the Sprintnet operators sub-page. */
  onOpenOperators: () => void;
  /** Routes to the NotificationSettings sub-page (the four notification
   *  toggles, relocated behind "Manage notifications"). */
  onOpenNotificationSettings: () => void;
  /** Routes to the MRV native contract plan preview surface. */
  onOpenMrvNative: () => void;
  /** Routes to the About page — version stack,
   *  operator health, genesis hash, §28.5 differentiation pitch. */
  onOpenAbout: () => void;
  /** Routes to the Delegations dashboard — active
   *  stake breakdown, pending rewards, unstake / redelegate / claim
   *  actions per §23. */
  onOpenDelegations: () => void;
  /** Routes to the Security page (passkey policy
   *  authoring per §28.5 Q30+Q31). Optional so legacy callers / non-
   *  ML-DSA states render without it; when present, Settings shows
   *  the "Passkey policy" card. */
  onOpenSecurity?: () => void;
  /** Routes to the Features page (two-tier UX
   *  toggles per §28.5 Q29). Optional for the same reasons. */
  onOpenFeatures?: () => void;
  /** Routes to the Theme page (appearance / theme picker, promoted to
   *  its own top-level category). Always wired — theme is not vault-gated. */
  onOpenTheme: () => void;
  /** Passed only when the active vault is a multisig vault.
   *  When set, Settings renders the Multisig card with M-of-N pill +
   *  pending count + entry points to the Pending dashboard and
   *  Governance pages. */
  multisig?: {
    signerCount: number;
    threshold: number;
    pendingCount: number;
    onOpenPending: () => void;
    onOpenGovernance: () => void;
  };
}

const ALGO_LABEL: Record<SignAlgo, string> = {
  mldsa: "ML-DSA-65 (post-quantum)",
  slhdsa: "SLH-DSA-SHA2-128s (post-quantum)",
  secp256k1: "secp256k1 (legacy)",
};

function getExtensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "0.0.1";
  }
}

export function Settings({
  onBack,
  address,
  algo,
  onShowPhrase,
  onShowConnectedSites,
  onOpenOperators,
  onOpenNotificationSettings,
  onOpenMrvNative,
  onOpenAbout,
  onOpenDelegations,
  onOpenSecurity,
  onOpenFeatures,
  onOpenTheme,
  multisig,
}: SettingsProps) {
  // Account section inline copy state.
  const [addrCopied, setAddrCopied] = useState(false);
  const handleAddrCopy = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!address) return;
    void navigator.clipboard.writeText(bech32mDisplay(address)).then(
      () => {
        setAddrCopied(true);
        setTimeout(() => setAddrCopied(false), 1500);
      },
      () => {},
    );
  };

  const version = getExtensionVersion();

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Settings
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        {/* Developer-mode toggle — first card at the top of Settings. */}
        <DeveloperModeToggle />
        <div
          style={{
            height: 1,
            background: "rgba(255,255,255,0.06)",
            margin: "10px 0 12px",
          }}
        />
        {/* Account section compacted. Row gap was 8 px
            with the address+copy on two stacked rows (RevealableAddressBlock
            renders the AddressLine + a separate copy button below). Now
            the address sits inline with a copy button (single row),
            row gap drops to 6 px, and the section claims roughly half
            the vertical space it did before. */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Account</h3>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {address ? (
              <div
                onClick={handleAddrCopy}
                title={addrCopied ? "Copied" : "Click to copy"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "copy",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "var(--f-mono)",
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: addrCopied ? "var(--ok, #5fc97a)" : "var(--fg-100)",
                    letterSpacing: "-0.04em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "clip",
                    userSelect: "all",
                  }}
                >
                  {bech32mDisplay(address)}
                </span>
                <button
                  type="button"
                  onClick={handleAddrCopy}
                  aria-label="Copy address"
                  title={addrCopied ? "Copied" : "Copy address"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    padding: 0,
                    background: "transparent",
                    border: "none",
                    color: addrCopied ? "var(--ok, #5fc97a)" : "var(--fg-400)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {addrCopied ? <CheckIcon /> : <ClipboardIcon />}
                </button>
              </div>
            ) : (
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 11,
                  color: "var(--fg-400)",
                }}
              >
                —
              </div>
            )}
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.05em",
              }}
            >
              Signing: <span style={{ color: "var(--gold)" }}>{ALGO_LABEL[algo]}</span>
            </div>
            <button
              onClick={onShowPhrase}
              style={{
                marginTop: 4,
                alignSelf: "flex-start",
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 11.5,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Icon name="eye" size={11} />
              Show recovery phrase
            </button>
          </div>
        </div>

        {/* Section order: Account, Multisig (conditional), Security,
           Notifications, Theme, Staking, Developer tools, Network operators,
           About. Multisig kept in slot 2 (account-adjacent) since the spec
           didn't mention it but its content is logically about access
           control on the active vault. */}
        {multisig && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Multisig</h3>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(124,127,255,0.4)",
                  background: "rgba(124,127,255,0.08)",
                  color: "var(--fg-100)",
                  fontFamily: "var(--f-mono)",
                  fontSize: 11,
                }}
              >
                {multisig.threshold} of {multisig.signerCount}
              </div>
              {multisig.pendingCount > 0 && (
                <div
                  style={{
                    padding: "3px 8px",
                    borderRadius: 6,
                    border: "1px solid rgba(242,180,65,0.4)",
                    background: "rgba(242,180,65,0.08)",
                    color: "var(--fg-100)",
                    fontFamily: "var(--f-mono)",
                    fontSize: 11,
                  }}
                >
                  {multisig.pendingCount} pending
                </div>
              )}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              This vault is a multisig — sends create proposals that
              the signer committee approves before execution.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={multisig.onOpenPending}
                style={multisigBtnStyle}
              >
                <span>Pending proposals</span>
                <Icon name="chev" size={12} />
              </button>
              <button
                onClick={multisig.onOpenGovernance}
                style={multisigBtnStyle}
              >
                <span>Signers + governance</span>
                <Icon name="chev" size={12} />
              </button>
            </div>
          </div>
        )}

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Security</h3>
          </div>
          <WalletSecurityControls bare showLockReset={false} />
          <button
            onClick={onShowConnectedSites}
            style={{
              width: "100%",
              marginTop: 8,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Icon name="shield" size={13} />
            Connected sites
          </button>

          {onOpenSecurity && (
            <button
              onClick={onOpenSecurity}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="passkey" size={13} />
              Passkey policy
            </button>
          )}

          {onOpenFeatures && (
            <button
              onClick={onOpenFeatures}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="shield" size={13} />
              Features
            </button>
          )}

        </div>

        {/* Notifications — relocated behind "Manage notifications" (mirrors
           the Network operators card+submenu) to keep this page short. The
           four toggles live on the NotificationSettings sub-page; their
           values / IPC / gating are unchanged. */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Notifications</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Control system notifications, what details they show, and how they
            behave while the wallet is locked.
          </div>
          <button
            onClick={onOpenNotificationSettings}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>Manage notifications</span>
            <Icon name="chev" size={12} />
          </button>
        </div>

        {/* Theme — promoted out of the Security card into its own
           top-level category. The picker lives on the Theme sub-page so
           it stays a single source shared with the hamburger entry. */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Theme</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Choose the wallet&apos;s colour theme — light, dark, and accent
            palettes.
          </div>
          <button
            onClick={onOpenTheme}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="contrast" size={13} />
              Appearance
            </span>
            <Icon name="chev" size={12} />
          </button>
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Staking</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            View active delegations, pending rewards, and manage existing
            positions across clusters.
          </div>
          <button
            onClick={onOpenDelegations}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>Delegations dashboard</span>
            <Icon name="chev" size={12} />
          </button>
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Developer tools</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Preview RISC-V (MRV native) contract deploy and call transaction
            plans with execution-unit and lythoshi fee fields.
          </div>
          <button
            onClick={onOpenMrvNative}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="contract" size={13} />
              RISC-V contracts
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 8.5,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--fg-400)",
                  border: "1px solid var(--fg-700)",
                  borderRadius: 3,
                  padding: "0 4px",
                }}
              >
                MRV
              </span>
            </span>
            <Icon name="chev" size={12} />
          </button>
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Network operators</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Override the Monolythium Testnet operator RPC list with your own operator
            nodes. Defaults use the 7 published operators in round-robin.
          </div>
          <button
            onClick={onOpenOperators}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>Manage operators</span>
            <Icon name="chev" size={12} />
          </button>
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>About</h3>
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Monolythium Browser Wallet v{version} · sovereign post-quantum browser
            wallet.
          </div>
          <button
            onClick={onOpenAbout}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>Version, operators, links</span>
            <Icon name="chev" size={12} />
          </button>
        </div>
      </div>
    </>
  );
}

const multisigBtnStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

