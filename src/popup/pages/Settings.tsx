import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import {
  bgGetAutoLockMinutes,
  bgKeystoreLock,
  bgSetAutoLockMinutes,
  type SignAlgo,
} from "../bg";
import { RevealableAddressBlock } from "../components/RevealableAddressBlock";

interface SettingsProps {
  onBack: () => void;
  address: string;
  algo: SignAlgo;
  /** Routes to the RevealPhrase page. v4 strict guarantees every vault
   *  is revealable, so this is always wired. */
  onShowPhrase: () => void;
  /** Routes to the ResetWallet page (destructive). */
  onResetWallet: () => void;
  /** Routes to the Sprintnet operators sub-page (Phase 4.3). */
  onOpenOperators: () => void;
}

const ALGO_LABEL: Record<SignAlgo, string> = {
  mldsa: "ML-DSA-65 (post-quantum)",
  slhdsa: "SLH-DSA-128s (post-quantum)",
  secp256k1: "secp256k1 (legacy)",
};

const FALLBACK_OPTIONS: readonly number[] = [5, 15, 30, 60];

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
  onResetWallet,
  onOpenOperators,
}: SettingsProps) {
  const [autoLock, setAutoLock] = useState<number | null>(null);
  const [options, setOptions] = useState<readonly number[]>(FALLBACK_OPTIONS);
  const [savingAutoLock, setSavingAutoLock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgGetAutoLockMinutes();
      if (cancelled) return;
      setAutoLock(r.autoLockMinutes);
      setOptions(r.options);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePickAutoLock = async (minutes: number) => {
    if (savingAutoLock || minutes === autoLock) return;
    setSavingAutoLock(true);
    const r = await bgSetAutoLockMinutes(minutes);
    if (r.ok) setAutoLock(r.autoLockMinutes);
    setSavingAutoLock(false);
  };

  const handleLockNow = async () => {
    await bgKeystoreLock();
    // The SW writes walletLocked=true; App.tsx's chrome.storage.onChanged
    // listener (Yarı 1) flips the screen back to Unlock — no local nav
    // needed here.
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
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Account</h3>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {address ? (
              <RevealableAddressBlock addr0x={address} />
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
                marginTop: 4,
                letterSpacing: "0.05em",
              }}
            >
              Signing: <span style={{ color: "var(--gold)" }}>{ALGO_LABEL[algo]}</span>
            </div>
            <button
              onClick={onShowPhrase}
              style={{
                marginTop: 6,
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

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Security</h3>
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Auto-lock after
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${options.length}, 1fr)`,
              gap: 6,
              marginBottom: 14,
            }}
          >
            {options.map((m) => {
              const active = m === autoLock;
              return (
                <button
                  key={m}
                  onClick={() => void handlePickAutoLock(m)}
                  disabled={savingAutoLock}
                  style={{
                    padding: "8px 4px",
                    borderRadius: 8,
                    border: active
                      ? "1px solid var(--gold)"
                      : "1px solid var(--fg-700)",
                    background: active
                      ? "var(--gold-bg)"
                      : "rgba(255,255,255,0.04)",
                    color: active ? "var(--gold)" : "var(--fg-100)",
                    fontFamily: "var(--f-sans)",
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    transition: "all 150ms var(--e-out)",
                  }}
                >
                  {m} min
                </button>
              );
            })}
          </div>

          <button
            onClick={() => void handleLockNow()}
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
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Icon name="lock" size={13} />
            Lock wallet now
          </button>

          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid var(--fg-700)",
            }}
          >
            <button
              onClick={onResetWallet}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(220,80,80,0.4)",
                background: "rgba(220,80,80,0.08)",
                color: "var(--err)",
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
              <Icon name="warn" size={13} />
              Reset wallet
            </button>
          </div>
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
            Override the Sprintnet operator RPC list with your own validator
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
            }}
          >
            Monolythium Wallet v{version}
            <br />
            Sovereign post-quantum browser wallet.
          </div>
        </div>
      </div>
    </>
  );
}
