import { describe, expect, it } from "vitest";
import {
  SNOOZE_MS,
  applyDismissForever,
  applyLater,
  normaliseRecoveryNagMap,
  shouldShowRecoveryNag,
  type RecoveryNagState,
} from "./setup-health-nag.js";

const NOW = 1_700_000_000_000;

describe("shouldShowRecoveryNag", () => {
  it("all-3 complete → hidden, regardless of state", () => {
    expect(shouldShowRecoveryNag(undefined, true, NOW)).toBe(false);
    expect(
      shouldShowRecoveryNag(
        { dismissedForever: false, snoozedUntilMs: null },
        true,
        NOW,
      ),
    ).toBe(false);
  });

  it("absent/fresh state (and incomplete) → shows", () => {
    expect(shouldShowRecoveryNag(undefined, false, NOW)).toBe(true);
  });

  it("dismissedForever → hidden", () => {
    expect(
      shouldShowRecoveryNag(
        { dismissedForever: true, snoozedUntilMs: null },
        false,
        NOW,
      ),
    ).toBe(false);
  });

  it("snoozed into the future → hidden; elapsed snooze → shows", () => {
    expect(
      shouldShowRecoveryNag(
        { dismissedForever: false, snoozedUntilMs: NOW + 1000 },
        false,
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldShowRecoveryNag(
        { dismissedForever: false, snoozedUntilMs: NOW - 1000 },
        false,
        NOW,
      ),
    ).toBe(true);
    // exactly at the boundary → shows (>=)
    expect(
      shouldShowRecoveryNag(
        { dismissedForever: false, snoozedUntilMs: NOW },
        false,
        NOW,
      ),
    ).toBe(true);
  });
});

describe("actions", () => {
  it("applyLater snoozes exactly SNOOZE_MS from now; not dismissed", () => {
    const s = applyLater(NOW);
    expect(s).toEqual({ dismissedForever: false, snoozedUntilMs: NOW + SNOOZE_MS });
  });

  it("a SECOND applyLater re-snoozes strictly further from the new now", () => {
    const first = applyLater(NOW);
    const second = applyLater(NOW + 5_000);
    expect(second.snoozedUntilMs!).toBeGreaterThan(first.snoozedUntilMs!);
    expect(second.snoozedUntilMs).toBe(NOW + 5_000 + SNOOZE_MS);
  });

  it("applyDismissForever → permanent, no snooze", () => {
    expect(applyDismissForever()).toEqual({
      dismissedForever: true,
      snoozedUntilMs: null,
    });
  });

  it("SNOOZE_MS is 30 days", () => {
    expect(SNOOZE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("normaliseRecoveryNagMap", () => {
  it("keeps well-formed per-vault entries (number and null snooze)", () => {
    const raw = {
      "vault-a": { dismissedForever: true, snoozedUntilMs: null },
      "vault-b": { dismissedForever: false, snoozedUntilMs: 123 },
    };
    expect(normaliseRecoveryNagMap(raw)).toEqual(raw);
  });

  it("drops malformed / missing-field entries, keeps the good ones", () => {
    const got = normaliseRecoveryNagMap({
      good: { dismissedForever: false, snoozedUntilMs: 1 },
      noBool: { dismissedForever: "yes", snoozedUntilMs: 1 },
      badSnooze: { dismissedForever: false, snoozedUntilMs: "soon" },
      missing: { dismissedForever: true },
      notObject: 42,
    } as unknown);
    expect(got).toEqual({ good: { dismissedForever: false, snoozedUntilMs: 1 } });
  });

  it("non-object input → empty map", () => {
    expect(normaliseRecoveryNagMap(null)).toEqual({});
    expect(normaliseRecoveryNagMap("x")).toEqual({});
    expect(normaliseRecoveryNagMap(undefined)).toEqual({});
  });

  it("round-trips a saved state through normalise (storage robustness)", () => {
    const state: RecoveryNagState = applyLater(NOW);
    const map = { v1: state };
    expect(normaliseRecoveryNagMap(map)).toEqual(map);
  });
});
