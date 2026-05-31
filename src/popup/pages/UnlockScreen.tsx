import { useEffect, useState } from "react";
import {
  bgKeystoreUnlock,
  bgKeystoreWipeUnauth,
  type ChainEntry,
} from "../bg";
import { ChainStatusBanner } from "../components";
import { Modal } from "../components/Modal";
import { WalletLogo } from "../components/WalletLogo";
import { bech32mDisplay } from "../../shared/bech32m";

interface UnlockScreenProps {
  /** Truncated address chip rendered above the password field, in bech32m form (e.g. "mono1abc…wxyz"). */
  address: string | null;
  /** Optional success hook. Primary success signal is the SW's walletLocked
   * push channel which the App-level chrome.storage.onChanged listener
   * already handles; this is just a backup for callers that want to react
   * synchronously after the IPC reply. */
  onUnlocked?: () => void;
  /** When rendered inside the approval window, the active chain is threaded
   * down so the unlock screen can show the same status banner the rest of
   * the approval flow renders. Omitted in normal-popup locked mode. */
  chain?: ChainEntry;
  /** Round 11 TASK 6 — "Forgot your password?" → "Import wallet" path.
   *  Caller routes to the existing ForgotPassword screen which handles
   *  the wipe + re-import flow. Omit (along with onForgotReset) to hide
   *  the Forgot link entirely — used by the approval-window unlock
   *  prompt where forgot-password isn't an appropriate escape hatch. */
  onForgotImport?: () => void;
  /** Round 11 TASK 7 — "I don't know my Phrase" path. Caller routes to
   *  the post-wipe landing (Welcome). This component fires the wipe
   *  IPC itself; the callback only handles the screen change. */
  onForgotReset?: () => void;
}

function shortAddress(addr: string | null): string {
  const display = bech32mDisplay(addr);
  if (display === "—" || display.length <= 12) return display;
  return `${display.slice(0, 8)}…${display.slice(-4)}`;
}

export function UnlockScreen({
  address,
  onUnlocked,
  chain,
  onForgotImport,
  onForgotReset,
}: UnlockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Round 11 TASK 6 + 7 — modal stack. forgotOpen is the entry modal
  // (Import / I don't know my Phrase). idkOpen is the stronger
  // "Yes, reset wallet" confirmation reached from the I-don't-know
  // button. Only one is rendered at a time.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [idkOpen, setIdkOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // The Forgot link is only meaningful when the parent provided the
  // routing callbacks. In the approval-window unlock prompt neither is
  // passed, so the link stays hidden — the user closes the approval
  // window instead.
  const showForgotLink =
    onForgotImport !== undefined || onForgotReset !== undefined;

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

  const handleImportClicked = () => {
    setForgotOpen(false);
    onForgotImport?.();
  };

  const handleOpenIdk = () => {
    setForgotOpen(false);
    setResetError(null);
    setIdkOpen(true);
  };

  const handleConfirmReset = async () => {
    if (resetting) return;
    setResetting(true);
    setResetError(null);
    try {
      const r = await bgKeystoreWipeUnauth();
      if (!r.ok) {
        setResetError(
          r.reason === "rate_limited"
            ? "Please wait a few seconds before retrying."
            : (r.reason ?? "Reset failed."),
        );
        return;
      }
      setIdkOpen(false);
      onForgotReset?.();
    } catch (e) {
      setResetError((e as Error).message ?? "Reset failed.");
    } finally {
      setResetting(false);
    }
  };

  const disabled = submitting || secondsRemaining > 0 || password.length === 0;

  return (
    <>
      {chain && <ChainStatusBanner network={chain} />}
      <div style={{ padding: "44px 22px 8px", textAlign: "center" }}>
        <div
          style={{
            position: "relative",
            width: 56,
            height: 56,
            margin: "0 auto 14px",
          }}
          aria-hidden="true"
        >
          {/* Wallet logo — the gradient squircle + Monolythium "M" mark
             (shared WalletLogo; theme-driven fill + mark). The lock badge
             below is composed as an overlay on its bottom-right corner. */}
          <WalletLogo size={56} />
          {/* Lock badge — bottom-right corner, slightly overlapping the
             squircle. Fill is the logo's exact accent (var(--gold)); a 2px
             ring in the page background (var(--ink-000)) separates it from
             the squircle. The padlock glyph uses the brand near-white text
             token (var(--fg-100)). */}
          <div
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "var(--gold)",
              border: "2px solid var(--ink-000)",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24">
              <path
                d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"
                fill="none"
                stroke="var(--fg-100)"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <rect
                x="6"
                y="10.5"
                width="12"
                height="9"
                rx="2.2"
                fill="var(--fg-100)"
              />
            </svg>
          </div>
        </div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Unlock Monolythium Wallet
        </h2>
        {/* Top-tier address privacy: while locked the SW returns no address
           (getUnlockedAddressV4 is null when locked), so render no chip at
           all — never hint the active address before unlock. */}
        {address && (
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
        )}
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

        {/* Round 11 TASK 6 — Forgot password? entry. Hidden in the
           approval-window unlock prompt (no callbacks passed). */}
        {showForgotLink && (
          <button
            type="button"
            onClick={() => setForgotOpen(true)}
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              border: "none",
              padding: "4px 0",
              color: "var(--gold)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Forgot your password?
          </button>
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

      {/* Round 11 TASK 6 — Forgot password entry modal. Two options:
         Import wallet (routes to the existing ForgotPassword screen
         which handles wipe + re-import) or I don't know my Phrase
         (opens the stronger reset confirm below). */}
      <Modal
        open={forgotOpen}
        onClose={() => setForgotOpen(false)}
        title="Forgot your password?"
      >
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          We can&apos;t recover your password for you.
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Add your wallet back to Monolythium by entering the
          24-word PQM-1 recovery phrase associated with it.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 6,
          }}
        >
          <button
            type="button"
            disabled={!onForgotImport}
            onClick={handleImportClicked}
            style={{
              padding: "11px 12px",
              borderRadius: 10,
              border: "1px solid var(--gold)",
              background: "linear-gradient(180deg, var(--gold-hi), var(--gold))",
              color: "var(--ink-000)",
              fontFamily: "var(--f-sans)",
              fontSize: 13,
              fontWeight: 600,
              cursor: onForgotImport ? "pointer" : "not-allowed",
              opacity: onForgotImport ? 1 : 0.5,
            }}
          >
            Import wallet
          </button>
          <button
            type="button"
            disabled={!onForgotReset}
            onClick={handleOpenIdk}
            style={{
              padding: "11px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 13,
              fontWeight: 500,
              cursor: onForgotReset ? "pointer" : "not-allowed",
              opacity: onForgotReset ? 1 : 0.5,
            }}
          >
            I don&apos;t know my Phrase
          </button>
        </div>
      </Modal>

      {/* Round 11 TASK 7 — strong "Don't have your recovery phrase?"
         confirmation. The Yes button fires bgKeystoreWipeUnauth which
         clears the encrypted vault container + every per-vault
         setup-state record. After success the parent's onForgotReset
         lands the user on Welcome (fresh-install state). */}
      <Modal
        open={idkOpen}
        onClose={() => {
          if (!resetting) {
            setIdkOpen(false);
            setResetError(null);
          }
        }}
      >
        <div style={{ textAlign: "center", padding: "4px 4px 0" }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "8px auto 10px",
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--r-xl)",
              background: "rgba(220,80,80,0.10)",
              border: "1px solid rgba(220,80,80,0.4)",
              color: "var(--err)",
              fontSize: 26,
            }}
            aria-hidden="true"
          >
            ⚠️
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--fg-100)",
              marginBottom: 8,
            }}
          >
            Don&apos;t have your recovery phrase?
          </div>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-300)",
            lineHeight: 1.55,
          }}
        >
          We can&apos;t recover your 24-word PQM-1 recovery phrase. You
          can reset the wallet to create a new one and import your
          accounts using a new PQM-1 phrase.
        </div>
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: "rgba(220,80,80,0.08)",
            border: "1px solid rgba(220,80,80,0.35)",
            fontSize: 12,
            color: "var(--fg-100)",
            lineHeight: 1.55,
          }}
        >
          Resetting will <strong>permanently delete</strong> all wallet
          data in Monolythium on this device.{" "}
          <strong>
            It will not impact the assets within your wallet on-chain.
          </strong>
        </div>
        {resetError && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--err)",
              lineHeight: 1.4,
            }}
          >
            {resetError}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 6,
          }}
        >
          <button
            type="button"
            onClick={() => {
              if (resetting) return;
              setIdkOpen(false);
              setResetError(null);
            }}
            disabled={resetting}
            style={{
              flex: 1,
              padding: "11px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 13,
              fontWeight: 500,
              cursor: resetting ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmReset()}
            disabled={resetting}
            style={{
              flex: 1,
              padding: "11px 12px",
              borderRadius: 10,
              border: "1px solid var(--err)",
              background: "var(--err)",
              color: "white",
              fontFamily: "var(--f-sans)",
              fontSize: 13,
              fontWeight: 600,
              cursor: resetting ? "default" : "pointer",
              opacity: resetting ? 0.7 : 1,
            }}
          >
            {resetting ? "Resetting…" : "Yes, reset wallet"}
          </button>
        </div>
      </Modal>
    </>
  );
}
