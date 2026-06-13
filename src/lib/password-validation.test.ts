import { describe, expect, it } from "vitest";

import { isPasswordValid, getPasswordStrength } from "./password-validation";
import { isCommonPassword } from "./common-passwords";

// A strong password that meets all five rules and is NOT in the denylist.
const STRONG_UNLISTED = "Zx9!vQ2#mNpL"; // 12 chars: upper/lower/digit/special

describe("isPasswordValid", () => {
  it("accepts a strong, non-listed password", () => {
    expect(isPasswordValid(STRONG_UNLISTED)).toBe(true);
    expect(getPasswordStrength(STRONG_UNLISTED)).toBe("strong");
  });

  it("rejects passwords below the composition floor", () => {
    expect(isPasswordValid("weak")).toBe(false); // too short, no classes
    expect(isPasswordValid("alllowercase1!")).toBe(false); // no uppercase
    expect(isPasswordValid("NoSpecialChar1")).toBe(false); // no special
    expect(isPasswordValid("NoDigitsHere!!")).toBe(false); // no digit
    expect(isPasswordValid("Sh0rt!")).toBe(false); // < 12 chars
  });

  it("rejects a common password that otherwise meets all five rules (#41)", () => {
    // "Password123!" is 12 chars with upper/lower/digit/special — it PASSES
    // the composition floor but is in the common-password denylist.
    expect(getPasswordStrength("Password123!")).toBe("strong");
    expect(isPasswordValid("Password123!")).toBe(false);
  });
});

describe("isCommonPassword (#41 denylist)", () => {
  it("matches case-insensitively and trims", () => {
    expect(isCommonPassword("password123!")).toBe(true);
    expect(isCommonPassword("PASSWORD123!")).toBe(true);
    expect(isCommonPassword("  Password123!  ")).toBe(true);
  });

  it("does not flag a non-listed password", () => {
    expect(isCommonPassword(STRONG_UNLISTED)).toBe(false);
  });
});
