// Phase 10 Commit 3 — SlhDsaBackupRevealModal.
//
// Drives the §30.1 cold-storage reveal flow inside the popup window.
// Two distinct entry modes:
//
//   - `"generate"` — fresh keygen path. Step 0 explains what the
//     backup IS; step 1 calls `bgSlhDsaBackupGenerate` to run the
//     SW-side keypair + record-persist + return the mnemonic; step 2
//     hold-to-reveal the mnemonic in a `MnemonicGrid`; step 3 the
//     user attests via "I have written this down" checkbox and the
//     wallet flips `coldStorageConfirmed` to true.
//
//   - `"re-export"` — flow for a vault that already has a backup
//     record. Skips keygen (the existing keypair stays — chain
//     registration is one-time per address). Calls
//     `bgSlhDsaBackupRecoverMnemonic` which decrypts the stored
//     entropy slot + re-derives the 24-word phrase. Same reveal +
//     attestation UI; the attestation is idempotent if already
//     confirmed.
//
// Hold-to-reveal: the user must press-and-hold the reveal button for
// 1.5 seconds before the mnemonic appears. Same defensive UX as
// Phase 3.5's RevealPhrase. Pinned at this duration so a brief
// accidental tap (e.g. fat-fingered) does not flash the seed. The
// timer cancels cleanly on mouseup / pointerup / blur.
//
// Clipboard: copying auto-clears after 60 seconds. Per Phase 3.5's
// convention, we overwrite the clipboard with an empty string so a
// later paste in another window can't recover the mnemonic.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import { MnemonicGrid } from "./MnemonicGrid";
import {
  bgSlhDsaBackupConfirmColdStorage,
  bgSlhDsaBackupGenerate,
  bgSlhDsaBackupRecoverMnemonic,
} from "../bg";

/** Duration the user must hold the reveal button before the
 *  mnemonic renders. 1.5 s — short enough to feel responsive,
 *  long enough to prevent accidental taps from leaking the seed. */
const HOLD_REVEAL_MS = 1_500;

/** Auto-clear delay after a successful clipboard copy. Mirrors
 *  Phase 3.5's RevealPhrase (60 s — long enough for the user to
 *  paste into a password manager, short enough that an unattended
 *  popup doesn't sit with the seed in the buffer). */
const CLIPBOARD_AUTO_CLEAR_MS = 60_000;

/** Entry mode discriminant — see module header. */
export type RevealMode = "generate" | "re-export";

export interface SlhDsaBackupRevealModalProps {
  open: boolean;
  mode: RevealMode;
  /** Active vault id — the IPC takes vaultId as its only payload. */
  vaultId: string;
  /** Short-form address (e.g. `mono1abc…xyz` or `0x12…34`) to
   *  include in the downloaded text file's header. */
  vaultAddressLabel: string;
  /** Dismiss without persisting any state change. The SW-side
   *  `chainRegistrationStatus` + `coldStorageConfirmed` flags are
   *  untouched until the user explicitly attests + closes. */
  onClose: () => void;
  /** Fired after the user attests via the "I've written this down"
   *  checkbox + presses "Continue". Caller refreshes its read of
   *  the vault's backup state. */
  onConfirmed: () => void;
}

type ScreenState =
  | { kind: "explainer" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "reveal"; mnemonic: string; held: boolean }
  | { kind: "confirmed" };

export function SlhDsaBackupRevealModal({
  open,
  mode,
  vaultId,
  vaultAddressLabel,
  onClose,
  onConfirmed,
}: SlhDsaBackupRevealModalProps) {
  const [screen, setScreen] = useState<ScreenState>({ kind: "explainer" });
  const [checkboxOn, setCheckboxOn] = useState(false);
  const [copied, setCopied] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmInFlight, setConfirmInFlight] = useState(false);

  // Reset every closed→open cycle so a re-open never inherits a
  // prior session's revealed mnemonic or checkbox state.
  useEffect(() => {
    if (open) return;
    setScreen({ kind: "explainer" });
    setCheckboxOn(false);
    setCopied(false);
    setConfirmInFlight(false);
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (clipboardTimerRef.current !== null) {
      clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
  }, [open]);

  // Cleanup pending timers on unmount.
  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      if (clipboardTimerRef.current !== null) {
        clearTimeout(clipboardTimerRef.current);
      }
    };
  }, []);

  const startKeygen = async () => {
    setScreen({ kind: "loading" });
    const fetcher =
      mode === "generate"
        ? bgSlhDsaBackupGenerate(vaultId)
        : bgSlhDsaBackupRecoverMnemonic(vaultId).then((r) =>
            r.ok
              ? // Re-export returns just the mnemonic — synthesise the
                // generate-shape so the screen-state machine is uniform.
                ({ ok: true as const, mnemonic: r.mnemonic, backup: null })
              : r,
          );
    const res = await fetcher;
    if (!res.ok) {
      setScreen({ kind: "error", message: res.reason });
      return;
    }
    setScreen({ kind: "reveal", mnemonic: res.mnemonic, held: false });
  };

  const onRevealPressStart = () => {
    if (screen.kind !== "reveal" || screen.held) return;
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      // Re-read screen state inside the timer — the user may have
      // released the press and a re-press scheduled a second timer.
      setScreen((s) =>
        s.kind === "reveal" ? { ...s, held: true } : s,
      );
      holdTimerRef.current = null;
    }, HOLD_REVEAL_MS);
  };

  const onRevealPressEnd = () => {
    // Cancel the timer if the user releases before the threshold.
    // Once `held: true` is set, the timer is null and this is a no-op.
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handleCopy = async () => {
    if (screen.kind !== "reveal" || !screen.held) return;
    try {
      await navigator.clipboard.writeText(screen.mnemonic);
      setCopied(true);
      if (clipboardTimerRef.current !== null) {
        clearTimeout(clipboardTimerRef.current);
      }
      clipboardTimerRef.current = setTimeout(() => {
        // Auto-clear: overwrite with an empty string. Same Phase 3.5
        // RevealPhrase discipline — best-effort; clipboard.writeText
        // can fail under focus-loss, swallow the rejection.
        void navigator.clipboard.writeText("").catch(() => {});
        setCopied(false);
        clipboardTimerRef.current = null;
      }, CLIPBOARD_AUTO_CLEAR_MS);
    } catch {
      // Clipboard write can fail in restricted contexts; stay quiet.
    }
  };

  const handleDownload = () => {
    if (screen.kind !== "reveal" || !screen.held) return;
    const shortLabel = vaultAddressLabel.replace(/[^a-z0-9]/gi, "");
    const filename = `monolythium-emergency-backup-${shortLabel.slice(0, 12)}.txt`;
    const body = buildDownloadText(screen.mnemonic, vaultAddressLabel);
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleConfirm = async () => {
    if (!checkboxOn || confirmInFlight) return;
    setConfirmInFlight(true);
    // Re-export mode: the record already exists. We still flip
    // `coldStorageConfirmed` to true (idempotent for already-
    // confirmed records) so a Re-export against a previously
    // unconfirmed record completes the attestation.
    const res = await bgSlhDsaBackupConfirmColdStorage(vaultId);
    if (!res.ok) {
      setScreen({ kind: "error", message: res.reason });
      setConfirmInFlight(false);
      return;
    }
    setScreen({ kind: "confirmed" });
    setConfirmInFlight(false);
    onConfirmed();
  };

  const title =
    mode === "generate"
      ? "Set up emergency recovery key"
      : "Re-export emergency recovery key";

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {screen.kind === "explainer" && (
        <ExplainerScreen
          mode={mode}
          onContinue={() => void startKeygen()}
          onCancel={onClose}
        />
      )}

      {screen.kind === "loading" && (
        <div
          style={{
            padding: "20px 0",
            textAlign: "center",
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--gold)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          {mode === "generate"
            ? "Generating SLH-DSA keypair…"
            : "Recovering mnemonic…"}
        </div>
      )}

      {screen.kind === "error" && (
        <>
          <div style={errBox}>{screen.message}</div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button onClick={onClose} style={btnGhost}>
              Close
            </button>
            <button onClick={() => void startKeygen()} style={btnPrimary}>
              Try again
            </button>
          </div>
        </>
      )}

      {screen.kind === "reveal" && (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            Press and hold to reveal your 24-word backup. Write it down on
            paper and store it offline. The wallet does <strong>not</strong>{" "}
            keep a copy you can recover after a wipe.
          </div>

          {!screen.held ? (
            <button
              onMouseDown={onRevealPressStart}
              onMouseUp={onRevealPressEnd}
              onMouseLeave={onRevealPressEnd}
              onTouchStart={onRevealPressStart}
              onTouchEnd={onRevealPressEnd}
              style={{
                width: "100%",
                padding: "20px 12px",
                borderRadius: 12,
                border: "1px dashed var(--gold)",
                background: "rgba(244,201,122,0.06)",
                color: "var(--gold)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              Hold to reveal (1.5 s)
            </button>
          ) : (
            <>
              {/* Round 11 TASK 4 — this modal has its own 60 s ghost
                 copy button below. Hide MnemonicGrid's default 30 s
                 copy to avoid two copy buttons with different timer
                 semantics. */}
              <MnemonicGrid mnemonic={screen.mnemonic} showCopyButton={false} />
              <div
                style={{ display: "flex", gap: 8, marginTop: 10 }}
              >
                <button onClick={() => void handleCopy()} style={btnGhost}>
                  <Icon name="eye" size={11} /> {copied ? "Copied (60 s)" : "Copy"}
                </button>
                <button onClick={handleDownload} style={btnGhost}>
                  Download .txt
                </button>
              </div>
            </>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              marginTop: 14,
              fontSize: 11.5,
              color: "var(--fg-100)",
              cursor: screen.held ? "pointer" : "default",
              opacity: screen.held ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={checkboxOn}
              disabled={!screen.held}
              onChange={(e) => setCheckboxOn(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I have written this down on paper (or stored it in a password
              manager) and understand that losing both this backup and my
              primary key means losing access to my account.
            </span>
          </label>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button onClick={onClose} style={btnGhost}>
              Cancel
            </button>
            <button
              onClick={() => void handleConfirm()}
              disabled={!checkboxOn || confirmInFlight}
              style={{
                ...btnPrimary,
                opacity: checkboxOn && !confirmInFlight ? 1 : 0.5,
                cursor: checkboxOn && !confirmInFlight ? "pointer" : "default",
              }}
            >
              Continue
            </button>
          </div>
        </>
      )}

      {screen.kind === "confirmed" && (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ok, #7ee3c1)",
              lineHeight: 1.5,
              padding: 10,
              border: "1px solid rgba(126,227,193,0.4)",
              borderRadius: 8,
              background: "rgba(126,227,193,0.08)",
            }}
          >
            Backup confirmed. Register it on chain from Settings →
            Security to anchor your emergency-recovery slot, or come
            back later — chain registration is one-time and works
            whenever you're ready.
          </div>
          <div
            style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}
          >
            <button onClick={onClose} style={btnPrimary}>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ExplainerScreen({
  mode,
  onContinue,
  onCancel,
}: {
  mode: RevealMode;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
        {mode === "generate" ? (
          <>
            Your emergency recovery key is a separate, post-quantum
            backup (SLH-DSA-SHA2-128s) registered alongside your primary
            key. If a future cryptographic break ever invalidates your
            primary key, this backup lets you keep control of your
            account.
            <ul style={{ paddingLeft: 18, marginTop: 8, marginBottom: 0 }}>
              <li>
                The wallet generates a fresh 24-word phrase. You write it
                down on paper and store it offline.
              </li>
              <li>
                You can register the public half on chain in one tx
                (one-time per account).
              </li>
              <li>
                The backup is <strong>only</strong> used in an emergency —
                normal transactions still sign with your primary key.
              </li>
            </ul>
          </>
        ) : (
          <>
            Re-export the 24-word backup phrase for this vault. The
            wallet decrypts the stored entropy and re-derives the same
            mnemonic you saw at first generation — the existing keypair
            and any on-chain registration are preserved.
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 14,
        }}
      >
        <button onClick={onCancel} style={btnGhost}>
          Cancel
        </button>
        <button onClick={onContinue} style={btnPrimary}>
          {mode === "generate" ? "Generate backup" : "Show backup"}
        </button>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ────────────────────────────────────────────────────────────────────────────

/** Build the downloaded .txt body. Plaintext with a security
 *  warning header so the file is obviously sensitive at a glance. */
export function buildDownloadText(
  mnemonic: string,
  vaultAddressLabel: string,
): string {
  const created = new Date().toISOString();
  return [
    "# Monolythium Wallet — Emergency Recovery Backup",
    "",
    "DO NOT share this file with anyone.",
    "DO NOT upload it to cloud storage, email, or chat.",
    "Anyone with this 24-word phrase can rotate to your emergency",
    "key and take over your account during a cryptographic emergency.",
    "",
    `Vault address: ${vaultAddressLabel}`,
    `Created at:    ${created}`,
    "Algorithm:     SLH-DSA-SHA2-128s (NIST FIPS 205)",
    "",
    "----- BEGIN BIP-39 (24 words) -----",
    mnemonic,
    "----- END BIP-39 -----",
    "",
    "Store this on paper in a fire-safe / safe-deposit box.",
    "Verify a copy before destroying the original.",
    "",
  ].join("\n");
}

const errBox: CSSProperties = {
  fontSize: 11.5,
  color: "var(--err)",
  lineHeight: 1.5,
  padding: 10,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
};

const btnGhost: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const btnPrimary: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
