// `helpTarget` — "open Help on THIS connection state" — is the companion state
// that carries the degraded-network banner's deep link, because `navigateTo`
// takes a screen name and nothing else.
//
// It is the same shape as `revealTarget`, and it inherits the same failure mode:
// a target left behind after the consuming screen is gone gets picked up by a
// later entry point that passes none. For reveal that meant showing the wrong
// wallet's phrase; here it means a user who opens Help from the Info menu —
// which must open fully collapsed — landing on a connection state they never
// asked about.
//
// App cannot be mounted without a DOM, so the guard is exported and tested here
// directly, exactly as `revealTargetSurvives` is in App.reveal-target.test.ts.

import { describe, expect, it } from "vitest";

import { helpTargetSurvives } from "./App";

describe("helpTargetSurvives — the deep-link target is scoped to its screen", () => {
  it("survives on the Help screen itself", () => {
    expect(helpTargetSurvives("help")).toBe(true);
  });

  // The regression this guard exists for: back to home, then Info -> Help must
  // open collapsed rather than inheriting the state the banner asked about.
  it("does NOT survive on home", () => {
    expect(helpTargetSurvives("home")).toBe(false);
  });

  it("does NOT survive on the main menu, the ordinary route into Help", () => {
    expect(helpTargetSurvives("main-menu")).toBe(false);
  });

  it("does NOT survive a lock exit", () => {
    expect(helpTargetSurvives("locked")).toBe(false);
  });

  it("does NOT survive on the operator directory, the chip's own destination", () => {
    expect(helpTargetSurvives("operator-directory")).toBe(false);
  });
});
