/**
 * Password strength validation utilities (NIST SP 800-63B-4 §3.1.1).
 *
 * Policy:
 * - Minimum 15 characters, counted by Unicode CODE POINTS (§3.1.1.2(1),(4)) —
 *   a single astral-plane character (emoji, etc.) counts as one.
 * - NO composition rules (§3.1.1.2(5) — SHALL NOT impose).
 * - Rejected if in the common/breached-password denylist (§3.1.1.2 blocklist),
 *   which also covers the service-name terms (context-specific blocklist).
 *
 * Password-only: the seed/mnemonic is never threaded in here (the password is
 * set before the seed is known in both create + import flows).
 */

import { isCommonPassword } from "./common-passwords.js";

export interface PasswordRequirement {
  key: string;
  met: boolean;
}

/** Length-band strength for the meter. `none` = empty input. */
export type PasswordStrength = "none" | "too-short" | "fair" | "strong";

/** Minimum length in Unicode code points. */
export const MIN_PASSWORD_LENGTH = 15;

/** Number of Unicode code points (NOT UTF-16 units) in a string — the spread
 *  iterates by code point, so a single emoji counts as one (§3.1.1.2(4)). */
export function codePointLength(s: string): number {
  return [...s].length;
}

/** Per-requirement view. The meter renders the length row; composition rules
 *  were removed per §3.1.1.2(5). */
export function validatePassword(password: string): PasswordRequirement[] {
  return [
    { key: "minLength", met: codePointLength(password) >= MIN_PASSWORD_LENGTH },
  ];
}

/** First failing reason, or `null` when the password passes. Length is checked
 *  before the denylist so the UI can message precisely. */
export type PasswordReject = "too_short" | "common" | null;
export function passwordRejectReason(password: string): PasswordReject {
  if (codePointLength(password) < MIN_PASSWORD_LENGTH) return "too_short";
  if (isCommonPassword(password)) return "common";
  return null;
}

/** Length floor + denylist (§3.1.1.2). No composition rules. */
export function isPasswordValid(password: string): boolean {
  return passwordRejectReason(password) === null;
}

/** Length-band strength for the meter (visual only; the hard gate is
 *  `isPasswordValid`): too-short (<15) / fair (15–19) / strong (≥20). */
export function getPasswordStrength(password: string): PasswordStrength {
  const n = codePointLength(password);
  if (n === 0) return "none";
  if (n < MIN_PASSWORD_LENGTH) return "too-short";
  if (n < 20) return "fair";
  return "strong";
}
