import { useEffect, useState } from "react";
import { bgKeystoreUnlock } from "../bg";

interface UnlockScreenProps {
  /** Truncated address chip rendered above the password field, e.g. "0xabcd…ef01". */
  address: string | null;
  /** Optional success hook. Primary success signal is the SW's walletLocked
   * push channel which the App-level chrome.storage.onChanged listener
   * already handles; this is just a backup for callers that want to react
   * synchronously after the IPC reply. */
  onUnlocked?: () => void;
}

function shortAddress(addr: string | null): string {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export function UnlockScreen({ address, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Countdown — when the SW returns secondsRemaining > 0, tick down once a
  // second. At zero, clear the rate-limit error and re-enable the submit.
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

  const handleSubmit = async () => {
    if (submitting || secondsRemaining > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgKeystoreUnlock(password);
      if (r.ok) {
        setPassword("");
        onUnlocked?.();
        return;
      }
      const remaining =
        typeof r.secondsRemaining === "number" ? r.secondsRemaining : 0;
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
        setError(r.reason ?? "Unlock failed.");
      }
    } catch (e) {
      setError((e as Error).message ?? "Unlock failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = submitting || secondsRemaining > 0 || password.length === 0;

  return (
    <>
      <div style={{ padding: "44px 22px 8px", textAlign: "center" }}>
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
          🔒
        </div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Unlock wallet
        </h2>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--fg-400)",
            marginTop: 8,
            letterSpacing: "0.04em",
          }}
        >
          {shortAddress(address)}
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
            Password
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            autoFocus
            disabled={secondsRemaining > 0}
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
              opacity: secondsRemaining > 0 ? 0.5 : 1,
            }}
          />
        </label>

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
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button
          className="prim"
          disabled={disabled}
          onClick={() => void handleSubmit()}
          style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
        >
          {submitting ? "Unlocking…" : "Unlock"}
        </button>
      </div>
    </>
  );
}
