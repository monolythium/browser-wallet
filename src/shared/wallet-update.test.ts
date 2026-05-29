import { describe, expect, it } from "vitest";
import {
  WALLET_UPDATE_CHECK_INTERVAL_MS,
  shouldCheckWalletUpdate,
  nextUpdateAvailable,
  parseWalletUpdateCache,
} from "./wallet-update.js";

describe("shouldCheckWalletUpdate", () => {
  it("checks when never checked or the interval elapsed; skips within it", () => {
    const now = 1_700_000_000_000;
    expect(shouldCheckWalletUpdate(null, now)).toBe(true);
    expect(
      shouldCheckWalletUpdate(now - WALLET_UPDATE_CHECK_INTERVAL_MS, now),
    ).toBe(true);
    expect(shouldCheckWalletUpdate(now - 1000, now)).toBe(false);
  });
});

describe("nextUpdateAvailable", () => {
  it("definite statuses flip the verdict; throttled/unavailable keep prior", () => {
    expect(nextUpdateAvailable("update_available", false)).toBe(true);
    expect(nextUpdateAvailable("no_update", true)).toBe(false);
    // honest-absence: a non-answer never invents/changes the verdict.
    expect(nextUpdateAvailable("throttled", true)).toBe(true);
    expect(nextUpdateAvailable("throttled", false)).toBe(false);
    expect(nextUpdateAvailable("unavailable", true)).toBe(true);
    expect(nextUpdateAvailable("unavailable", false)).toBe(false);
  });
});

describe("parseWalletUpdateCache", () => {
  it("parses a valid cache and rejects malformed shapes", () => {
    expect(parseWalletUpdateCache({ lastCheckAt: 5, updateAvailable: true })).toEqual({
      lastCheckAt: 5,
      updateAvailable: true,
    });
    expect(parseWalletUpdateCache(null)).toBeNull();
    expect(parseWalletUpdateCache({ lastCheckAt: "x", updateAvailable: true })).toBeNull();
    expect(parseWalletUpdateCache({ lastCheckAt: 5 })).toBeNull();
  });

  it("parses lastStatus when valid and drops it when malformed", () => {
    expect(
      parseWalletUpdateCache({
        lastCheckAt: 5,
        updateAvailable: false,
        lastStatus: "unavailable",
      }),
    ).toEqual({ lastCheckAt: 5, updateAvailable: false, lastStatus: "unavailable" });
    // unknown status string is dropped (no lastStatus key)
    expect(
      parseWalletUpdateCache({
        lastCheckAt: 5,
        updateAvailable: false,
        lastStatus: "bogus",
      }),
    ).toEqual({ lastCheckAt: 5, updateAvailable: false });
  });
});
