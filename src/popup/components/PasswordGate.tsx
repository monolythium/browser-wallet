// Shared password re-verification gate.
//
// Three surfaces independently reimplement the same "re-auth step": the
// unlock screen, Settings -> Show recovery phrase (RevealPhrase's `reauth`
// step), and Settings -> Reset wallet (ResetWallet's `reauth` step). Each
// carries its own copy of the password field, the lockout countdown, and the
// same four-branch error mapping — ResetWallet's countdown effect is even
// commented "Lockout countdown — mirrors UnlockScreen."
//
// This component is the single implementation of that step. It is ADDITIVE:
// no existing surface is migrated onto it here. Consumers are the wallet-
// management surfaces that follow.
//
// What it deliberately does NOT do:
//   - It never inspects, stores, caches, or compares the password. The string
//     goes straight to `verify`, which hands it to the service worker; the
//     real check is an Argon2id re-derivation plus an authenticated decrypt
//     inside the keystore, and it fails closed. There is no local
//     "is this the right password" value at any point.
//   - It does not own the lockout counters. `secondsRemaining` is echoed back
//     from the service worker, which owns the shared
//     SESSION_KEY_UNLOCK_FAIL_COUNT / _UNTIL state.
//
// All user-facing strings are copied verbatim from the surfaces this
// generalises so the wording cannot drift; see the string table in the
// commit's report.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { PasswordInput } from "./PasswordInput";

/** Failure half of a gated operation's reply. Mirrors the shape the
 *  service worker's password-taking ops return (`keystore-unlock`,
 *  `keystore-export-seed`, `keystore-reset`). */
export interface PasswordGateFailure {
  ok: false;
  reason?: string;
  secondsRemaining?: number;
  failCount?: number;
}

/** A gated operation's reply. `T` is whatever the success case carries
 *  (e.g. `{ mnemonic: string }` for a seed export, `{}` for a pure check). */
export type PasswordGateVerdict<T> = ({ ok: true } & T) | PasswordGateFailure;

/** What the gate should display after a failed attempt.
 *
 *  Pure and exported so the four-branch mapping is testable without a DOM —
 *  this codebase has no jsdom, so the branch table cannot be exercised through
 *  a rendered component. */
export interface PasswordGateError {
  message: string;
  secondsRemaining: number;
}

/**
 * Map a failed verdict onto the message + countdown the gate shows.
 *
 * The four branches are lifted verbatim from ResetWallet.handleConfirmReset
 * and RevealPhrase.handleAuthSubmit, which implement the identical table:
 *   1. `rate_limited`  -> "Too many attempts. Try again in {n}s." + countdown
 *   2. `wrong_password` with a lockout -> "Wrong password. Locked for {n}s."
 *   3. `wrong_password` with no lockout -> "Wrong password."
 *   4. anything else -> the raw reason, or the caller's fallback
 */
export function passwordGateErrorFor(
  failure: PasswordGateFailure,
  fallback: string,
): PasswordGateError {
  const secondsRemaining =
    typeof failure.secondsRemaining === "number" ? failure.secondsRemaining : 0;
  if (failure.reason === "rate_limited") {
    return {
      message: `Too many attempts. Try again in ${secondsRemaining}s.`,
      secondsRemaining,
    };
  }
  if (failure.reason === "wrong_password") {
    return secondsRemaining > 0
      ? {
          message: `Wrong password. Locked for ${secondsRemaining}s.`,
          secondsRemaining,
        }
      : { message: "Wrong password.", secondsRemaining: 0 };
  }
  // Unmapped reason (a structural refusal, say) — surface it as-is rather than
  // mislabelling it a wrong password, and do NOT start a countdown for it.
  return { message: failure.reason ?? fallback, secondsRemaining: 0 };
}

/**
 * The line actually rendered under the field. While a lockout is ticking the
 * countdown supersedes whatever produced it, so the number stays live as the
 * timer runs. Copied from the identical expression in ResetWallet and
 * RevealPhrase.
 */
export function passwordGateErrorText(
  error: string | null,
  secondsRemaining: number,
): string | null {
  if (secondsRemaining > 0) {
    return `Too many attempts. Try again in ${secondsRemaining}s.`;
  }
  return error;
}

export interface PasswordGateProps<T> {
  /** Body copy above the field, e.g. "Enter your password to view your
   *  24-word recovery phrase." Verbatim from the host surface. */
  prompt: ReactNode;
  /** Optional visual above the prompt (the existing surfaces use a lock logo
   *  or a warning glyph). */
  adornment?: ReactNode;
  /** Shown when the reply carries no recognised reason. */
  fallbackError: string;
  /** The gated operation. Receives the typed password and returns the service
   *  worker's verdict. The re-derivation + authenticated decrypt happen there,
   *  not here. */
  verify: (password: string) => Promise<PasswordGateVerdict<T>>;
  /** Called with the successful verdict so the caller can read whatever the
   *  operation returned. */
  onVerified: (verdict: { ok: true } & T) => void;
  /** Omit to render a single full-width submit (RevealPhrase's shape); provide
   *  it for the two-button Cancel/Continue footer (ResetWallet's shape). */
  onCancel?: () => void;
  /** Default "Continue" — the label both existing re-auth steps use. */
  submitLabel?: string;
  /** Default "Checking…" — RevealPhrase's in-flight label. */
  busyLabel?: string;
  /** Field label. Default "Password", as on both existing surfaces. */
  label?: string;
  /** Chrome only — the verification contract, the lockout countdown, the error
   *  mapping and the unmount clear are identical in both.
   *
   *  `"screen"` (default) is the full-screen shell the existing re-auth steps
   *  use: a centred prompt block and a `req-foot` page footer. It fills a route.
   *
   *  `"inline"` is for embedding inside a Modal — left-aligned prompt, compact
   *  spacing, and a modal-shaped button row instead of the page footer. A
   *  `req-foot` inside a Modal would try to pin itself to the page bottom. */
  variant?: "screen" | "inline";
}

export function PasswordGate<T>({
  prompt,
  adornment,
  fallbackError,
  verify,
  onVerified,
  onCancel,
  variant = "screen",
  submitLabel = "Continue",
  busyLabel = "Checking…",
  label = "Password",
}: PasswordGateProps<T>) {
  const [password, setPassword] = useState("");
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

  // Drop the password on unmount. JS cannot deterministically zero a string,
  // so this releases the reference rather than wiping the bytes — the same
  // honest limit RevealPhrase documents for the mnemonic. Neither existing
  // re-auth step does this today.
  useEffect(() => {
    return () => {
      setPassword("");
    };
  }, []);

  const handleSubmit = async () => {
    // Guarded HERE, not only via the button's `disabled` — an Enter keypress
    // and a stale re-render both route through this same check.
    if (submitting || secondsRemaining > 0 || password.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const verdict = await verify(password);
      if (verdict.ok) {
        setPassword("");
        onVerified(verdict);
        return;
      }
      const mapped = passwordGateErrorFor(verdict, fallbackError);
      setError(mapped.message);
      setSecondsRemaining(mapped.secondsRemaining);
      setPassword("");
    } catch (e) {
      setError((e as Error).message ?? fallbackError);
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = submitting || secondsRemaining > 0 || password.length === 0;
  const errorText = passwordGateErrorText(error, secondsRemaining);

  // Identical in both variants — only the surrounding chrome differs.
  const field = (
    <PasswordInput
      label={label}
      value={password}
      onChange={setPassword}
      autoComplete="current-password"
      autoFocus
      disabled={secondsRemaining > 0}
      onKeyDown={(e) => {
        if (e.key === "Enter") void handleSubmit();
      }}
    />
  );
  const errorLine = errorText ? (
    <div style={ERROR_STYLE}>{errorText}</div>
  ) : null;

  if (variant === "inline") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {adornment}
        <div style={INLINE_PROMPT_STYLE}>{prompt}</div>
        {field}
        {errorLine}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: onCancel ? "1fr 1fr" : "1fr",
            gap: 8,
            marginTop: 2,
          }}
        >
          {onCancel && (
            <button onClick={onCancel} disabled={submitting} style={INLINE_CANCEL_STYLE}>
              Cancel
            </button>
          )}
          <button
            disabled={disabled}
            onClick={() => void handleSubmit()}
            style={{
              ...INLINE_SUBMIT_STYLE,
              ...(disabled ? DISABLED_SUBMIT_STYLE : null),
            }}
          >
            {submitting ? busyLabel : submitLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ padding: "32px 22px 8px", textAlign: "center" }}>
        {adornment}
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
            maxWidth: 280,
            margin: "0 auto",
          }}
        >
          {prompt}
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
        {field}
        {errorLine}
      </div>

      <div
        className="req-foot"
        style={{
          marginTop: "auto",
          gridTemplateColumns: onCancel ? "1fr 1fr" : "1fr",
        }}
      >
        {onCancel && (
          <button onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button
          className="prim"
          disabled={disabled}
          onClick={() => void handleSubmit()}
          style={disabled ? DISABLED_SUBMIT_STYLE : undefined}
        >
          {submitting ? busyLabel : submitLabel}
        </button>
      </div>
    </>
  );
}

const ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  color: "var(--err)",
  lineHeight: 1.4,
};

const INLINE_PROMPT_STYLE: CSSProperties = {
  fontSize: 12.5,
  color: "var(--fg-300)",
  lineHeight: 1.5,
};

// Modal-shaped buttons, matching ConfirmWordDialog's footer so the two gates
// read as one flow when they appear back to back.
const INLINE_CANCEL_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const INLINE_SUBMIT_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(124,127,255,0.6)",
  background: "rgba(124,127,255,0.18)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const DISABLED_SUBMIT_STYLE: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};
