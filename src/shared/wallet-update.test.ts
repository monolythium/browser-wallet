import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WALLET_UPDATE_CHECK_INTERVAL_MS,
  STORAGE_KEY_WALLET_UPDATE,
  shouldCheckWalletUpdate,
  nextUpdateAvailable,
  parseWalletUpdateCache,
  reconcileWalletUpdateOnInstalled,
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

describe("reconcileWalletUpdateOnInstalled", () => {
  let remove: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    remove = vi.fn(() => Promise.resolve());
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { remove } },
    };
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("clears the persisted verdict on an applied update", async () => {
    await reconcileWalletUpdateOnInstalled("update");
    expect(remove).toHaveBeenCalledWith(STORAGE_KEY_WALLET_UPDATE);
  });

  it("clears the persisted verdict on a fresh install", async () => {
    await reconcileWalletUpdateOnInstalled("install");
    expect(remove).toHaveBeenCalledWith(STORAGE_KEY_WALLET_UPDATE);
  });

  it("does NOT clear on other onInstalled reasons", async () => {
    await reconcileWalletUpdateOnInstalled("chrome_update");
    await reconcileWalletUpdateOnInstalled("shared_module_update");
    expect(remove).not.toHaveBeenCalled();
  });
});
