import { describe, expect, it } from "vitest";

import {
  isPasswordValid,
  passwordRejectReason,
  getPasswordStrength,
  codePointLength,
  MIN_PASSWORD_LENGTH,
} from "./password-validation";
import { isCommonPassword } from "./common-passwords";

describe("isPasswordValid / passwordRejectReason (NIST 800-63B-4 §3.1.1.2)", () => {
  it("accepts a 15+ code-point password with NO composition variety", () => {
    // all-lowercase, no digit/symbol — composition rules were removed (§3.1.1.2(5))
    expect(isPasswordValid("abcdefghijklmno")).toBe(true); // exactly 15
    expect(isPasswordValid("abcdefghijklmnopqrst")).toBe(true); // 20
    expect(passwordRejectReason("abcdefghijklmno")).toBeNull();
  });

  it("allows spaces and does not require any character class", () => {
    expect(isPasswordValid("this is a passphrase")).toBe(true); // 20 incl. spaces
  });

  it("rejects below the 15-char floor → reason 'too_short'", () => {
    expect(isPasswordValid("abcdefghijklmn")).toBe(false); // 14
    expect(passwordRejectReason("abcdefghijklmn")).toBe("too_short");
    expect(passwordRejectReason("Sh0rt!")).toBe("too_short");
  });

  it("counts by Unicode CODE POINTS, not UTF-16 units (§3.1.1.2(4))", () => {
    const eightEmoji = "\u{1F600}".repeat(8); // 8 code points = 16 UTF-16 units
    expect(eightEmoji.length).toBe(16); // UTF-16 units
    expect(codePointLength(eightEmoji)).toBe(8); // code points
    expect(isPasswordValid(eightEmoji)).toBe(false); // 8 < 15
    expect(isPasswordValid("\u{1F600}".repeat(15))).toBe(true); // 15 code points
  });

  it("checks length BEFORE the denylist", () => {
    // "Password123!" is denylisted AND 12 chars → reported as too_short, not common
    expect(isCommonPassword("Password123!")).toBe(true);
    expect(passwordRejectReason("Password123!")).toBe("too_short");
  });

  it("pins the floor at 15", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(15);
  });
});

describe("getPasswordStrength (length bands)", () => {
  it("none for empty input", () => {
    expect(getPasswordStrength("")).toBe("none");
  });
  it("too-short below 15", () => {
    expect(getPasswordStrength("abcdefghijklmn")).toBe("too-short"); // 14
  });
  it("fair at 15–19", () => {
    expect(getPasswordStrength("abcdefghijklmno")).toBe("fair"); // 15
    expect(getPasswordStrength("abcdefghijklmnopqrs")).toBe("fair"); // 19
  });
  it("strong at 20+", () => {
    expect(getPasswordStrength("abcdefghijklmnopqrst")).toBe("strong"); // 20
  });
});

describe("isCommonPassword (#41 denylist)", () => {
  it("matches case-insensitively and trims", () => {
    expect(isCommonPassword("password123!")).toBe(true);
    expect(isCommonPassword("PASSWORD123!")).toBe(true);
    expect(isCommonPassword("  Password123!  ")).toBe(true);
  });

  it("does not flag an unlisted password", () => {
    expect(isCommonPassword("abcdefghijklmnopqrst")).toBe(false);
  });
});
