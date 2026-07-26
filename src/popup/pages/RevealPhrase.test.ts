// RevealPhrase — the auto-hide arming condition.
//
// This codebase has no jsdom and no @testing-library (component tests use
// renderToStaticMarkup from react-dom/server), so the timer itself, the
// tap-to-reveal toggle and the password-clear cannot be asserted here and are
// NOT claimed to be. What IS covered is the pure predicate that decides whether
// the 30 s countdown runs — exported precisely so it can be tested without a
// DOM, and the part that carried the defect.
//
// H6: the countdown used to arm inside the tap handler, so a user who never
// tapped saw the chip advertise "Hides in 30s" with no timer running and the
// decrypted phrase sitting in component state indefinitely. The fix moves the
// arming condition off the tap entirely — note the signature takes no reveal /
// tap argument at all, which is what makes the regression unrepresentable.

import { describe, expect, it } from "vitest";

import { autoHideArmed } from "./RevealPhrase";

describe("autoHideArmed — what starts the 30 s countdown", () => {
  it("arms as soon as the reveal step has a decrypted phrase", () => {
    expect(autoHideArmed("reveal", "word ".repeat(23) + "word")).toBe(true);
  });

  it("does NOT arm on the re-auth step — nothing is decrypted yet", () => {
    expect(autoHideArmed("reauth", null)).toBe(false);
  });

  it("does NOT arm on the warning step, which has its own reset on entry to reveal", () => {
    expect(autoHideArmed("warning", "abandon ability able")).toBe(false);
  });

  it("does NOT arm on the reveal step without a phrase (export failed)", () => {
    expect(autoHideArmed("reveal", null)).toBe(false);
  });

  it("arms on an empty-string phrase too — presence, not content, is the condition", () => {
    // Defensive: the keystore never returns "", but the predicate must not
    // quietly stop the countdown if it ever did.
    expect(autoHideArmed("reveal", "")).toBe(true);
  });
});
