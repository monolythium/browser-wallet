// H7 — the lifetime of `revealTarget`, the "reveal THIS wallet" selector the
// Wallets page hands to the reveal screen.
//
// No jsdom in this codebase, so App itself cannot be mounted and the effect
// that consumes this predicate is hand-verification only. What IS covered is
// the pair of pure facts the fix rests on, which is where the defect lived:
//
//   1. the target survives ONLY on the reveal screen, so every exit drops it;
//   2. `reveal-phrase` is NOT lock-signal exempt.
//
// Fact 2 is the load-bearing one. The bug was that a lock mid-reveal routed the
// user to Unlock while leaving the target set, so a later Settings entry — which
// means "the active wallet" — inherited it and would reveal a different wallet's
// phrase. There are two ways to make that symptom go away: clear the target
// (correct), or add `reveal-phrase` to LOCK_SIGNAL_EXEMPT so the lock stops
// kicking the user out (WRONG — it would leave a decrypted seed on screen
// through a lock, and the exempt set documents that decision explicitly).
// Asserting fact 2 here means the wrong fix fails the suite.

import { describe, expect, it } from "vitest";

import { LOCK_SIGNAL_EXEMPT, revealTargetSurvives } from "./App";

describe("revealTargetSurvives — the reveal target is scoped to its screen", () => {
  it("survives on the reveal screen itself", () => {
    expect(revealTargetSurvives("reveal-phrase")).toBe(true);
  });

  it("does NOT survive a lock exit — the H7 path", () => {
    expect(revealTargetSurvives("locked")).toBe(false);
  });

  it("does NOT survive into Settings, whose reveal entry means the ACTIVE wallet", () => {
    expect(revealTargetSurvives("settings")).toBe(false);
  });

  it("does NOT survive back on the Wallets page", () => {
    expect(revealTargetSurvives("wallets")).toBe(false);
  });

  it("does NOT survive on home", () => {
    expect(revealTargetSurvives("home")).toBe(false);
  });
});

describe("the documented not-lock-exempt decision (must not be reverted)", () => {
  it("reveal-phrase is NOT in LOCK_SIGNAL_EXEMPT — a lock mid-reveal forces re-auth", () => {
    expect(LOCK_SIGNAL_EXEMPT.has("reveal-phrase")).toBe(false);
  });

  it("the screens that ARE exempt are the onboarding and reset flows only", () => {
    // Pinned so that adding a secret-revealing screen to this set is a visible,
    // deliberate change rather than a one-line edit nobody reviews.
    expect([...LOCK_SIGNAL_EXEMPT].sort()).toEqual([
      "approval",
      "forgot-password",
      "import",
      "loading",
      "reset-wallet",
      "set-password-create",
      "set-password-import",
      "show-phrase",
      "verify-phrase",
      "welcome",
    ]);
  });
});
