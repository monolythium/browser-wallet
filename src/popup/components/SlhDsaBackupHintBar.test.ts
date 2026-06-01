// Pure-helper tests for the SLH-DSA backup hint
// bar. Mirrors the prior hint-bar tests' posture — the React
// rendering is manually verified in the dev popup; the
// `shouldShowHint` decision function is the pure seam that gets
// CI coverage.

import { describe, expect, it } from "vitest";
import { HINT_BAR_RESURFACE_MS } from "../../shared/slh-dsa-backup.js";
import { shouldShowHint } from "./SlhDsaBackupHintBar.js";

describe("shouldShowHint", () => {
  const NOW = 1_700_000_000_000;

  it("hides when backup is complete (auto-suppress on action)", () => {
    expect(
      shouldShowHint({
        backupIsComplete: true,
        hintEntry: undefined,
        now: NOW,
      }),
    ).toBe(false);
    // Even if the user previously dismissed for now, completion
    // wins — no need to keep nagging once it's done.
    expect(
      shouldShowHint({
        backupIsComplete: true,
        hintEntry: { dismissedAt: NOW - 1, neverShowAgain: false },
        now: NOW,
      }),
    ).toBe(false);
  });

  it("shows when backup incomplete and never dismissed", () => {
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: undefined,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("hides permanently when `neverShowAgain` is set", () => {
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: true },
        now: NOW,
      }),
    ).toBe(false);
    // Even a very long time later — explicit suppression wins.
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: 0, neverShowAgain: true },
        now: NOW + 365 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("hides during the 30-day cooldown after 'dismiss for now'", () => {
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: false },
        now: NOW + 5 * 24 * 60 * 60 * 1000, // 5 days later
      }),
    ).toBe(false);
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: false },
        now: NOW + HINT_BAR_RESURFACE_MS - 1,
      }),
    ).toBe(false);
  });

  it("re-surfaces after exactly the 30-day cooldown elapses", () => {
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: false },
        now: NOW + HINT_BAR_RESURFACE_MS,
      }),
    ).toBe(true);
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: false },
        now: NOW + HINT_BAR_RESURFACE_MS + 1,
      }),
    ).toBe(true);
  });

  it("re-surfaces after a long gap even with a non-zero dismissedAt", () => {
    expect(
      shouldShowHint({
        backupIsComplete: false,
        hintEntry: { dismissedAt: NOW, neverShowAgain: false },
        now: NOW + 60 * 24 * 60 * 60 * 1000, // 60 days later
      }),
    ).toBe(true);
  });
});
