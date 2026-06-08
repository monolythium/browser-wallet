/**
 * Password strength validation utilities.
 *
 * Requirements:
 * - Minimum 12 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 number
 * - At least 1 special character
 */

import { isCommonPassword } from "./common-passwords.js";

export interface PasswordRequirement {
  key: string;
  met: boolean;
}

export type PasswordStrength = "none" | "weak" | "medium" | "strong";

const SPECIAL_CHAR_REGEX = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

/** Validate each individual password requirement */
export function validatePassword(password: string): PasswordRequirement[] {
  return [
    { key: "minLength", met: password.length >= 12 },
    { key: "uppercase", met: /[A-Z]/.test(password) },
    { key: "lowercase", met: /[a-z]/.test(password) },
    { key: "number", met: /[0-9]/.test(password) },
    { key: "special", met: SPECIAL_CHAR_REGEX.test(password) },
  ];
}

/** Check if all password requirements are met AND the password is not in the
 *  common/breached-password denylist (#41 — NIST 800-63B denylist guidance on
 *  top of the composition floor). */
export function isPasswordValid(password: string): boolean {
  if (!validatePassword(password).every((r) => r.met)) return false;
  if (isCommonPassword(password)) return false;
  return true;
}

/** Calculate password strength based on requirements met */
export function getPasswordStrength(password: string): PasswordStrength {
  if (password.length === 0) return "none";

  const requirements = validatePassword(password);
  const metCount = requirements.filter((r) => r.met).length;

  if (metCount <= 2) return "weak";
  if (metCount <= 4) return "medium";
  return "strong";
}
