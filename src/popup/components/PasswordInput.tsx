// Shared password input with a show/hide reveal toggle (NIST SP 800-63B-4
// §3.1.1.2 — SHOULD offer an option to display the secret; SHALL allow
// password managers via the `autocomplete` hint). Preserves the wallet's
// existing behavior: no maxLength, paste allowed, the secret is never
// trimmed/normalized before it reaches the KDF.

import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "../Icon";

export interface PasswordInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Password-manager hint: "new-password" on create/confirm, "current-password" on unlock/reset. */
  autoComplete: "new-password" | "current-password";
  autoFocus?: boolean;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "10px 40px 10px 12px", // right room for the reveal button
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

export function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  disabled,
  onKeyDown,
}: PasswordInputProps) {
  const [reveal, setReveal] = useState(false);
  return (
    <label style={{ display: "block" }}>
      <div style={LABEL_STYLE}>{label}</div>
      <div style={{ position: "relative" }}>
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete={autoComplete}
          style={{ ...INPUT_STYLE, opacity: disabled ? 0.5 : 1 }}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          disabled={disabled}
          aria-label={reveal ? "Hide password" : "Show password"}
          aria-pressed={reveal}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
            color: "var(--fg-300)",
          }}
        >
          <Icon name="eye" size={14} />
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              fontSize: 16,
              lineHeight: 1,
              color: "var(--fg-300)",
              // slash overlay only when the password is currently visible
              opacity: reveal ? 0.9 : 0,
              transition: "opacity 120ms var(--e-out)",
            }}
          >
            ╱
          </span>
        </button>
      </div>
    </label>
  );
}
