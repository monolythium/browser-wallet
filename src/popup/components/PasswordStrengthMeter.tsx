import {
  getPasswordStrength,
  validatePassword,
  type PasswordStrength,
} from "../../lib/password-validation";

interface PasswordStrengthMeterProps {
  password: string;
  confirmPassword?: string;
}

const REQUIREMENT_LABELS: Record<string, string> = {
  minLength: "At least 12 characters",
  uppercase: "Uppercase letter",
  lowercase: "Lowercase letter",
  number: "Number",
  special: "Special character",
};

const STRENGTH_BARS: Record<Exclude<PasswordStrength, "none">, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
};

const STRENGTH_COLOR: Record<Exclude<PasswordStrength, "none">, string> = {
  weak: "var(--err)",
  medium: "var(--warn)",
  strong: "var(--ok)",
};

const STRENGTH_LABEL: Record<Exclude<PasswordStrength, "none">, string> = {
  weak: "Weak",
  medium: "Medium",
  strong: "Strong",
};

export function PasswordStrengthMeter({
  password,
  confirmPassword,
}: PasswordStrengthMeterProps) {
  const showConfirmMatch =
    confirmPassword !== undefined && confirmPassword.length > 0;
  if (password.length === 0 && !showConfirmMatch) return null;

  const strength = getPasswordStrength(password);
  const requirements = validatePassword(password);
  const passwordsMatch = password === confirmPassword;
  const filledColor = strength === "none" ? null : STRENGTH_COLOR[strength];
  const filledBars = strength === "none" ? 0 : STRENGTH_BARS[strength];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {password.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  height: 4,
                  flex: 1,
                  borderRadius: "var(--r-pill)",
                  background:
                    filledColor && i <= filledBars
                      ? filledColor
                      : "var(--surface-2)",
                  transition: "background 200ms var(--e-out)",
                }}
              />
            ))}
          </div>
          {strength !== "none" && (
            <div
              style={{
                fontSize: "var(--fs-11)",
                fontWeight: 600,
                color: STRENGTH_COLOR[strength],
              }}
            >
              {STRENGTH_LABEL[strength]}
            </div>
          )}
        </div>
      )}

      {password.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {requirements.map((req) => (
            <li
              key={req.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: "var(--fs-11)",
                color: req.met ? "var(--ok)" : "var(--fg-400)",
                transition: "color 150ms var(--e-out)",
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 12, display: "inline-block", textAlign: "center" }}
              >
                {req.met ? "✓" : "✗"}
              </span>
              {REQUIREMENT_LABELS[req.key] ?? req.key}
            </li>
          ))}
        </ul>
      )}

      {showConfirmMatch && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--fs-11)",
            color: passwordsMatch ? "var(--ok)" : "var(--err)",
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: 12, display: "inline-block", textAlign: "center" }}
          >
            {passwordsMatch ? "✓" : "✗"}
          </span>
          {passwordsMatch ? "Passwords match" : "Passwords do not match"}
        </div>
      )}
    </div>
  );
}
