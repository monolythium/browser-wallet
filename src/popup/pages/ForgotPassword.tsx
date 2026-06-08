import { useState } from "react";
import { Icon } from "../Icon";
import { WalletLockLogo } from "../components/WalletLockLogo";
import { Modal } from "../components/Modal";
import { bgKeystoreWipeUnauth } from "../bg";

/** The exact word the user must type to confirm the destructive wipe. */
const CONFIRM_WORD = "DELETE";

interface ForgotPasswordProps {
  /** Returns to Welcome (Cancel button + back arrow). */
  onBack: () => void;
  /** Called after the SW confirms the wipe. App.tsx routes to the Import
   *  flow so the user can restore from their 24-word phrase. */
  onWipedThenImport: () => void;
}

export function ForgotPassword({
  onBack,
  onWipedThenImport,
}: ForgotPasswordProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const confirmOk = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  const closeConfirm = () => {
    if (submitting) return; // never abandon a wipe mid-flight
    setConfirmOpen(false);
    setConfirmText("");
    setError(null);
  };

  const handleResetAndImport = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgKeystoreWipeUnauth();
      if (r.ok) {
        onWipedThenImport();
        return;
      }
      // Only realistic failure here is rate_limited (the SW throttles
      // accidental rapid-fire). Everything else is a bug — surface it.
      if (r.reason === "rate_limited") {
        setError("Please wait a few seconds before retrying.");
      } else {
        setError(r.reason ?? "Reset failed.");
      }
    } catch (e) {
      setError((e as Error).message ?? "Reset failed.");
    } finally {
      setSubmitting(false);
    }
  };

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
          Forgot password?
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div style={{ padding: "32px 22px 8px", textAlign: "center" }}>
        <WalletLockLogo badge="key" />
        <h2
          style={{
            margin: 0,
            fontSize: "var(--fs-15)",
            fontWeight: 600,
            color: "var(--fg-100)",
          }}
        >
          Recovery is your 24-word phrase
        </h2>
      </div>

      <div
        style={{
          padding: "16px 18px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
            color: "var(--fg-100)",
            fontSize: 12.5,
            lineHeight: 1.6,
          }}
        >
          If you&apos;ve lost your password, your funds are still safe{" "}
          <strong>only if you have your 24-word recovery phrase</strong>.
          The wallet cannot recover your password — Monolythium is
          non-custodial.
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--fg-400)",
            lineHeight: 1.6,
          }}
        >
          Resetting permanently deletes this wallet from this browser.
          You&apos;ll then re-import from your 24-word phrase and set a new
          password.
        </div>

        {error && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--err)",
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr 1fr" }}
      >
        <button onClick={onBack} disabled={submitting}>
          Cancel
        </button>
        <button className="prim" onClick={() => setConfirmOpen(true)}>
          Reset &amp; Import
        </button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        title="Delete this wallet?"
        titleAccent="var(--err)"
        showClose
      >
        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--fg-200)" }}>
          This permanently removes this wallet and its keys from this device.
          It <strong>cannot be undone.</strong>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--fg-200)" }}>
          Your funds stay on the blockchain, but the only way to reach them
          again is your <strong>24-word recovery phrase</strong>. If you
          haven&apos;t saved it, deleting this wallet permanently locks you out
          of your funds.
        </div>
        <div
          style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-400)" }}
        >
          Monolythium is non-custodial: no one — including Monolythium — can
          recover your wallet, password, keys, or funds for you.
        </div>
        <label
          htmlFor="reset-confirm-input"
          style={{ fontSize: 11.5, color: "var(--fg-300)", marginTop: 2 }}
        >
          Type{" "}
          <strong style={{ color: "var(--fg-100)" }}>{CONFIRM_WORD}</strong> to
          confirm
        </label>
        <input
          id="reset-confirm-input"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={submitting}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={CONFIRM_WORD}
          aria-label={`Type ${CONFIRM_WORD} to confirm deleting this wallet`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && confirmOk && !submitting) {
              void handleResetAndImport();
            }
          }}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid var(--fg-700)",
            background: "rgba(255,255,255,0.04)",
            color: "var(--fg-100)",
            fontFamily: "var(--f-mono)",
            fontSize: 13,
            letterSpacing: "0.1em",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        {error && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--err)",
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={closeConfirm}
            disabled={submitting}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "transparent",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleResetAndImport()}
            disabled={!confirmOk || submitting}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--err)",
              background: confirmOk ? "var(--err)" : "transparent",
              color: confirmOk ? "#fff" : "var(--err)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: confirmOk && !submitting ? "pointer" : "not-allowed",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Deleting…" : "Delete wallet"}
          </button>
        </div>
      </Modal>
    </>
  );
}
