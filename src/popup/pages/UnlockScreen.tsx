import { useEffect, useState } from "react";
import {
  bgKeystoreUnlock,
  bgKeystoreWipeUnauth,
  type ChainEntry,
} from "../bg";
import { ChainStatusBanner } from "../components";
import { Modal } from "../components/Modal";
import { PasswordInput } from "../components/PasswordInput";
import { WalletLockLogo } from "../components/WalletLockLogo";
import { bech32mDisplay } from "../../shared/bech32m";
import { WIPE_CONFIRM_WORD as RESET_CONFIRM_WORD } from "../../shared/constants";

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
  /** "Forgot your password?" → "Import wallet" path.
   *  Caller routes to the existing ForgotPassword screen which handles
   *  the wipe + re-import flow. Omit (along with onForgotReset) to hide
   *  the Forgot link entirely — used by the approval-window unlock
   *  prompt where forgot-password isn't an appropriate escape hatch. */
  onForgotImport?: () => void;
  /** "I don't know my Phrase" path. Caller routes to
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

  // Modal stack. forgotOpen is the entry modal
  // (Import / I don't know my Phrase). idkOpen is the stronger
  // "Yes, reset wallet" confirmation reached from the I-don't-know
  // button. Only one is rendered at a time.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [idkOpen, setIdkOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // Type-DELETE-to-confirm gate for the I-don't-know-my-phrase wipe.
  const [resetConfirmInput, setResetConfirmInput] = useState("");
  const resetConfirmOk =
    resetConfirmInput.trim().toUpperCase() === RESET_CONFIRM_WORD;

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
    setResetConfirmInput("");
    setIdkOpen(true);
  };

  const handleConfirmReset = async () => {
    // Defense-in-depth behind the disabled button: never wipe without the
    // typed confirmation, even if the button gate is somehow bypassed.
    if (resetting || !resetConfirmOk) return;
    setResetting(true);
    setResetError(null);
    try {
      const r = await bgKeystoreWipeUnauth(resetConfirmInput.trim().toUpperCase());
      if (!r.ok) {
        setResetError(
          r.reason === "rate_limited"
            ? "Please wait a few seconds before retrying."
            : (r.reason ?? "Reset failed."),
        );
        return;
      }
      setResetConfirmInput("");
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
        <WalletLockLogo size={56} />
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
        <PasswordInput
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
          disabled={secondsRemaining > 0}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
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

        {/* Forgot password? entry. Hidden in the
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

      {/* Forgot password entry modal. Two options:
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
          24-word recovery phrase associated with it.
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

      {/* Strong "Don't have your recovery phrase?"
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
            setResetConfirmInput("");
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
          We can&apos;t recover your 24-word recovery phrase. You
          can reset the wallet to create a new one and import your
          accounts using a new recovery phrase.
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
        <label
          htmlFor="idk-reset-confirm-input"
          style={{ fontSize: 11.5, color: "var(--fg-300)", marginTop: 2 }}
        >
          Type{" "}
          <strong style={{ color: "var(--fg-100)" }}>
            {RESET_CONFIRM_WORD}
          </strong>{" "}
          to confirm
        </label>
        <input
          id="idk-reset-confirm-input"
          type="text"
          value={resetConfirmInput}
          onChange={(e) => setResetConfirmInput(e.target.value)}
          disabled={resetting}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={RESET_CONFIRM_WORD}
          aria-label={`Type ${RESET_CONFIRM_WORD} to confirm resetting this wallet`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && resetConfirmOk && !resetting) {
              void handleConfirmReset();
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
              setResetConfirmInput("");
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
            disabled={resetting || !resetConfirmOk}
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
              cursor: resetting || !resetConfirmOk ? "default" : "pointer",
              opacity: resetting || !resetConfirmOk ? 0.5 : 1,
            }}
          >
            {resetting ? "Resetting…" : "Yes, reset wallet"}
          </button>
        </div>
      </Modal>
    </>
  );
}
