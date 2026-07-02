import { describe, expect, it } from "vitest";
import { autoLockIncreaseNeedsConfirm } from "./WalletSecurityControls.js";

// C3 — the increase-warning gate. The repo has no interactive DOM test harness
// (node env + renderToStaticMarkup only), so the gate DECISION is unit-tested
// here as a pure predicate; the confirm/cancel apply-wiring around it is a thin
// binding (confirm → applyAutoLock; cancel → no apply, button auto-reverts).
describe("autoLockIncreaseNeedsConfirm — gate the increase-warning dialog", () => {
  it("warns on ANY increase (5→15, 15→30, 30→60, 5→60)", () => {
    expect(autoLockIncreaseNeedsConfirm(5, 15)).toBe(true);
    expect(autoLockIncreaseNeedsConfirm(15, 30)).toBe(true);
    expect(autoLockIncreaseNeedsConfirm(30, 60)).toBe(true);
    expect(autoLockIncreaseNeedsConfirm(5, 60)).toBe(true);
  });

  it("never warns on a DECREASE (longer→shorter is always safe)", () => {
    expect(autoLockIncreaseNeedsConfirm(60, 30)).toBe(false);
    expect(autoLockIncreaseNeedsConfirm(30, 15)).toBe(false);
    expect(autoLockIncreaseNeedsConfirm(15, 5)).toBe(false);
  });

  it("never warns on the SAME value", () => {
    expect(autoLockIncreaseNeedsConfirm(30, 30)).toBe(false);
  });

  it("never warns before the current value is loaded (null) — so an existing higher value is never warned retroactively (grandfathered)", () => {
    expect(autoLockIncreaseNeedsConfirm(null, 60)).toBe(false);
    expect(autoLockIncreaseNeedsConfirm(null, 5)).toBe(false);
  });
});
