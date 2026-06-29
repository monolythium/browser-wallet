// Wallet security controls — auto-lock timer, window mode (sidebar / popup /
// full screen), lock-now, and reset. Shared between the Security page (full
// set, in its own card) and the Settings "Security" card (bare, timer +
// window-mode pickers only). Single source of truth; behaviour/IPC unchanged.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { Modal } from "./Modal";
import {
  bgGetAutoLockMinutes,
  bgGetUiOpenMode,
  bgKeystoreLock,
  bgSetAutoLockMinutes,
  bgSetUiOpenMode,
  type UiOpenMode,
} from "../bg";

const FALLBACK_OPTIONS: readonly number[] = [5, 15, 30, 60];

/** True when changing the auto-lock from `current` to `next` is an INCREASE
 *  (a longer, weaker-security window) that must be confirmed before applying. A
 *  decrease or the same value never warns; a null `current` (not yet loaded)
 *  never warns. The predicate only fires on a NEW pick, so an existing higher
 *  value is never warned retroactively (grandfathered). Exported for unit tests. */
export function autoLockIncreaseNeedsConfirm(
  current: number | null,
  next: number,
): boolean {
  return current !== null && next > current;
}

const subLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: 6,
};

/** Shared style for the auto-lock + window-mode option buttons. */
const modeBtn = (active: boolean): CSSProperties => ({
  padding: "8px 4px",
  borderRadius: 8,
  border: active ? "1px solid var(--gold)" : "1px solid var(--fg-700)",
  background: active ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
  color: active ? "var(--gold)" : "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: "pointer",
  transition: "all 150ms var(--e-out)",
});

interface WalletSecurityControlsProps {
  /** Routes to the ResetWallet page (destructive). Only used when
   *  showLockReset is true. */
  onResetWallet?: () => void;
  /** Show the lock-now + reset buttons. Default true (the Security page shows
   *  the full set); Settings embeds only the timer + window-mode pickers. */
  showLockReset?: boolean;
  /** Render without the outer card wrapper, for embedding inside another card
   *  (the Settings "Security" card). Default false. */
  bare?: boolean;
}

export function WalletSecurityControls({
  onResetWallet,
  showLockReset = true,
  bare = false,
}: WalletSecurityControlsProps) {
  const [autoLock, setAutoLock] = useState<number | null>(null);
  const [options, setOptions] = useState<readonly number[]>(FALLBACK_OPTIONS);
  const [savingAutoLock, setSavingAutoLock] = useState(false);
  // The minutes value awaiting confirmation when the user picks a LONGER
  // auto-lock (a weaker-security increase). null = no dialog open.
  const [pendingIncreaseMinutes, setPendingIncreaseMinutes] = useState<
    number | null
  >(null);

  const [uiMode, setUiMode] = useState<UiOpenMode | null>(null);
  const [savingUiMode, setSavingUiMode] = useState(false);
  const [uiModePending, setUiModePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgGetAutoLockMinutes();
      if (cancelled) return;
      setAutoLock(r.autoLockMinutes);
      setOptions(r.options);
    })();
    void (async () => {
      const r = await bgGetUiOpenMode();
      if (cancelled) return;
      if (r.ok) setUiMode(r.mode);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyAutoLock = async (minutes: number) => {
    setSavingAutoLock(true);
    const r = await bgSetAutoLockMinutes(minutes);
    if (r.ok) setAutoLock(r.autoLockMinutes);
    setSavingAutoLock(false);
  };

  const handlePickAutoLock = (minutes: number) => {
    if (savingAutoLock || minutes === autoLock) return;
    // Warn + require explicit confirm when INCREASING the auto-lock window (a
    // longer unlocked window is weaker security). A decrease (or same value)
    // applies directly. Existing higher values are grandfathered — the dialog
    // only gates a NEW increase action, never retroactively. Cancel reverts
    // automatically: the active button tracks `autoLock`, which only changes on
    // a successful apply.
    if (autoLockIncreaseNeedsConfirm(autoLock, minutes)) {
      setPendingIncreaseMinutes(minutes);
      return;
    }
    void applyAutoLock(minutes);
  };

  const confirmIncrease = () => {
    const m = pendingIncreaseMinutes;
    setPendingIncreaseMinutes(null);
    if (m !== null) void applyAutoLock(m);
  };

  const handlePickUiMode = async (mode: UiOpenMode) => {
    if (savingUiMode || mode === uiMode) return;
    setSavingUiMode(true);
    const r = await bgSetUiOpenMode(mode);
    if (r.ok) {
      setUiMode(r.mode);
      // The chrome.action / chrome.sidePanel binding is live immediately, but
      // the CURRENTLY-OPEN surface keeps its mode until next icon click.
      setUiModePending(true);
    }
    setSavingUiMode(false);
  };

  const handleLockNow = async () => {
    await bgKeystoreLock();
    // The SW writes walletLocked=true; App.tsx's chrome.storage.onChanged
    // listener flips the screen back to Unlock — no local nav needed here.
  };

  // "Full screen" window mode — opens the wallet in a regular Chrome tab
  // (one-shot, same as the menu's "Open full screen"). Not a persisted mode.
  const openFullscreen = () => {
    void chrome.tabs
      .create({
        url: chrome.runtime.getURL("src/popup/index.html?mode=fullscreen"),
      })
      .then(() => window.close());
  };

  const inner = (
    <>
      <div style={subLabel}>Auto-lock after</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${options.length}, 1fr)`,
          gap: 6,
          marginBottom: 14,
        }}
      >
        {options.map((m) => (
          <button
            key={m}
            onClick={() => void handlePickAutoLock(m)}
            disabled={savingAutoLock}
            style={modeBtn(m === autoLock)}
          >
            {m} min
          </button>
        ))}
      </div>

      {/* Window mode. Sidebar/Popup persist via bgSetUiOpenMode; Full screen
         is a one-shot tab open (not a persisted mode). */}
      <div style={subLabel}>Window mode</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 6,
          marginBottom: uiModePending ? 6 : 14,
        }}
      >
        {(["sidepanel", "popup"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => void handlePickUiMode(mode)}
            disabled={savingUiMode || uiMode === null}
            style={modeBtn(mode === uiMode)}
          >
            {mode === "sidepanel" ? "Sidebar" : "Popup"}
          </button>
        ))}
        <button onClick={openFullscreen} style={modeBtn(false)}>
          Full screen
        </button>
      </div>
      {uiModePending && (
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-300)",
            marginBottom: 14,
            lineHeight: 1.4,
          }}
        >
          Close this window and click the wallet icon again to open in the new
          mode.
        </div>
      )}

      {showLockReset && (
        <>
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

          {onResetWallet && (
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
          )}
        </>
      )}

      <Modal
        open={pendingIncreaseMinutes !== null}
        onClose={() => setPendingIncreaseMinutes(null)}
        title="Longer auto-lock, weaker security"
        titleAccent="var(--gold)"
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--fg-200)",
          }}
        >
          <p style={{ margin: 0 }}>
            You&apos;re about to keep your wallet unlocked for up to{" "}
            {pendingIncreaseMinutes} minutes of inactivity.
          </p>
          <p style={{ margin: 0 }}>
            During that window, anyone who can reach your device — shared,
            borrowed, lost, or left unattended — could send funds or sign
            transactions without your password.
          </p>
          <p style={{ margin: 0 }}>
            Only use a longer time on a personal device you keep secure. If
            anyone else might use it, a shorter auto-lock is safer.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            onClick={() => setPendingIncreaseMinutes(null)}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={confirmIncrease}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--gold)",
              background: "var(--gold-bg)",
              color: "var(--gold)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Use {pendingIncreaseMinutes} minutes
          </button>
        </div>
      </Modal>
    </>
  );

  if (bare) return inner;
  return (
    <div className="ext-card">
      <div className="ext-card__head">
        <h3>Wallet controls</h3>
      </div>
      {inner}
    </div>
  );
}
