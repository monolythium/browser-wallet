import { useState } from "react";
import { Icon } from "../Icon";
import { bgKeystoreWipeUnauth } from "../bg";

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
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 14px",
            display: "grid",
            placeItems: "center",
            borderRadius: "var(--r-xl)",
            background: "rgba(124,127,255,0.1)",
            border: "1px solid var(--fg-700)",
            color: "var(--fg-200)",
            fontSize: 24,
          }}
          aria-hidden="true"
        >
          🔑
        </div>
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
          Resetting will delete the wallet from this browser. You&apos;ll
          then re-import using your phrase and choose a new password.
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
        <button
          className="prim"
          onClick={() => void handleResetAndImport()}
          disabled={submitting}
          style={
            submitting ? { opacity: 0.45, cursor: "not-allowed" } : undefined
          }
        >
          {submitting ? "Resetting…" : "Reset & Import"}
        </button>
      </div>
    </>
  );
}
