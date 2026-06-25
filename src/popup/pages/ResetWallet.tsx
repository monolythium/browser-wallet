import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { bgKeystoreReset } from "../bg";
import { PasswordInput } from "../components/PasswordInput";

interface ResetWalletProps {
  /** Returns to Settings (also used by the in-flow Cancel buttons). */
  onBack: () => void;
  /** Called once the SW confirms the wipe completed. App.tsx clears its
   *  state and routes to Welcome. */
  onSuccess: () => void;
}

type Step = "reauth" | "confirm";

const CONFIRM_WORD = "DELETE";

export function ResetWallet({ onBack, onSuccess }: ResetWalletProps) {
  const [step, setStep] = useState<Step>("reauth");
  // Captured during re-auth, consumed by the confirm step's keystore-reset
  // call. Cleared whenever we bounce back to re-auth so a wrong-password
  // bounce doesn't carry forward.
  const [password, setPassword] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Lockout countdown — mirrors UnlockScreen.
  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const t = setInterval(() => {
      setSecondsRemaining((s) => {
        const next = s - 1;
        if (next <= 0) {
          setError(null);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [secondsRemaining]);

  const handleAuthContinue = () => {
    if (password.length === 0 || secondsRemaining > 0) return;
    setError(null);
    setConfirmInput("");
    setStep("confirm");
  };

  const handleConfirmReset = async () => {
    if (submitting) return;
    if (confirmInput.trim().toUpperCase() !== CONFIRM_WORD) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgKeystoreReset(password);
      if (r.ok) {
        // Wipe successful — clear local state defensively before notifying
        // the parent (which will swap our screen anyway).
        setPassword("");
        setConfirmInput("");
        onSuccess();
        return;
      }
      const remaining =
        typeof r.secondsRemaining === "number" ? r.secondsRemaining : 0;
      // Wrong password / lockout — bounce back to re-auth with the error
      // displayed there. The lockout countdown picks up automatically via
      // the existing useEffect.
      if (r.reason === "rate_limited") {
        setError(`Too many attempts. Try again in ${remaining}s.`);
        setSecondsRemaining(remaining);
      } else if (r.reason === "wrong_password") {
        if (remaining > 0) {
          setError(`Wrong password. Locked for ${remaining}s.`);
          setSecondsRemaining(remaining);
        } else {
          setError("Wrong password.");
        }
      } else {
        setError(r.reason ?? "Reset failed.");
      }
      setPassword("");
      setConfirmInput("");
      setStep("reauth");
    } catch (e) {
      setError((e as Error).message ?? "Reset failed.");
      setStep("reauth");
    } finally {
      setSubmitting(false);
    }
  };

  if (step === "reauth") {
    const disabled =
      submitting || secondsRemaining > 0 || password.length === 0;
    return (
      <>
        <div className="ext-top">
          <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={15} />
          </button>
          <div
            style={{
              flex: 1,
              fontSize: 15,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            Reset wallet
          </div>
          <div style={{ width: 36 }} />
        </div>

        <div style={{ padding: "32px 22px 8px", textAlign: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 14px",
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--r-xl)",
              background: "rgba(220,80,80,0.08)",
              border: "1px solid rgba(220,80,80,0.4)",
              color: "var(--err)",
              fontSize: 24,
            }}
            aria-hidden="true"
          >
            ⚠️
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              maxWidth: 280,
              margin: "0 auto",
            }}
          >
            Confirm your password to start the reset flow.
          </div>
        </div>

        <div
          style={{
            padding: "16px 18px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <PasswordInput
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            autoFocus
            disabled={secondsRemaining > 0}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAuthContinue();
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
              {secondsRemaining > 0
                ? `Too many attempts. Try again in ${secondsRemaining}s.`
                : error}
            </div>
          )}
        </div>

        <div
          className="req-foot"
          style={{ marginTop: "auto", gridTemplateColumns: "1fr 1fr" }}
        >
          <button onClick={onBack}>Cancel</button>
          <button
            className="prim"
            disabled={disabled}
            onClick={handleAuthContinue}
            style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
          >
            Continue
          </button>
        </div>
      </>
    );
  }

  // step === "confirm"
  const confirmReady =
    confirmInput.trim().toUpperCase() === CONFIRM_WORD && !submitting;
  return (
    <>
      <div className="ext-top">
        <button
          className="ext-iconbtn"
          onClick={() => {
            setConfirmInput("");
            setStep("reauth");
          }}
          aria-label="Back"
        >
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Confirm reset
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        style={{
          padding: "20px 18px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: "rgba(220,80,80,0.08)",
            border: "1px solid rgba(220,80,80,0.4)",
            color: "var(--fg-100)",
            fontSize: 12.5,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            This permanently deletes your wallet from this browser.
          </div>
          Your funds are safe <strong>only if you have your 24-word
          recovery phrase</strong>. This action cannot be undone.
        </div>

        <label style={{ display: "block" }}>
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
            Type {CONFIRM_WORD} to confirm
          </div>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.3)",
              border: "1px solid var(--fg-700)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-mono)",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          />
        </label>
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr 1fr" }}
      >
        <button
          onClick={() => {
            setConfirmInput("");
            setStep("reauth");
          }}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          className="prim"
          onClick={() => void handleConfirmReset()}
          disabled={!confirmReady}
          style={{
            ...(confirmReady
              ? {
                  background: "var(--err)",
                  borderColor: "var(--err)",
                  color: "white",
                }
              : { opacity: 0.45, cursor: "not-allowed" }),
          }}
        >
          {submitting ? "Resetting…" : "Reset wallet"}
        </button>
      </div>
    </>
  );
}
