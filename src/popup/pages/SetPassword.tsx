import { useState } from "react";
import { Icon } from "../Icon";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { PasswordInput } from "../components/PasswordInput";
import { isPasswordValid } from "../../lib/password-validation";
import { isCommonPassword } from "../../lib/common-passwords";

interface SetPasswordProps {
  onSubmit: (password: string) => void;
  onBack: () => void;
  title?: string;
  error?: string | null;
}

export function SetPassword({
  onSubmit,
  onBack,
  title = "Set password",
  error,
}: SetPasswordProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Required acknowledgement before the wallet
  // password can be created. Mirrors MetaMask's pattern: an explicit
  // tick that the user understands the wallet is non-custodial and a
  // forgotten password can NOT be recovered by Monolythium. Continue
  // is disabled until the box is ticked even when the password meets
  // strength + match requirements.
  const [acknowledged, setAcknowledged] = useState(false);

  // isPasswordValid is the binding gate: ≥15 Unicode code points AND not in the
  // common-password denylist (no composition rules, per NIST 800-63B-4). The
  // strength meter is visual-only. Gate = isPasswordValid + match + acknowledgement.
  const canSubmit =
    isPasswordValid(password) && password === confirm && acknowledged;

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
          {title}
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
            fontSize: "var(--fs-12)",
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          This password unlocks your encrypted vault on this device. We can
          not recover it for you — pick something memorable and strong.
        </div>

        <PasswordInput
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          autoFocus
        />
        <PasswordInput
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />

        <PasswordStrengthMeter
          password={password}
          confirmPassword={confirm}
        />

        {/* Common-password denylist hint (#41): a long-enough password can
            still be rejected by isPasswordValid when it's in the denylist, which
            would otherwise disable Continue with no explanation. */}
        {password.length > 0 && isCommonPassword(password) && (
          <div
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--err)",
              fontFamily: "var(--f-mono)",
              lineHeight: 1.45,
            }}
          >
            This password is too common — choose a less guessable one.
          </div>
        )}

        {/* Acknowledgement gate. The entire row is a
           label so a tap anywhere on the box toggles the checkbox. */}
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(124,127,255,0.06)",
            border: "1px solid var(--fg-700)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            style={{
              flexShrink: 0,
              width: 16,
              height: 16,
              marginTop: 1,
              cursor: "pointer",
              accentColor: "var(--gold)",
            }}
          />
          <span
            style={{
              fontSize: 12,
              color: "var(--fg-200)",
              lineHeight: 1.45,
            }}
          >
            If I lose this password, Monolythium can&apos;t reset it.
          </span>
        </label>

        {error && (
          <div
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--err)",
              fontFamily: "var(--f-mono)",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button
          className="prim"
          disabled={!canSubmit}
          onClick={() => onSubmit(password)}
          style={
            canSubmit ? undefined : { opacity: 0.45, cursor: "not-allowed" }
          }
        >
          Continue
        </button>
      </div>
    </>
  );
}
