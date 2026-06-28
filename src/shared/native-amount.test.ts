import { describe, expect, it } from "vitest";
import {
  hexLythoshiToLythNumber,
  homeAvailableDisplay,
  homeDelegatedDisplay,
  lythoshiToLythDecimal,
  lythoshiToLythFixed,
  parseHexQuantity,
} from "./native-amount.js";

describe("native amount helpers", () => {
  it("formats lythoshi with 18-decimal LYTH precision", () => {
    // Chain migrated 8 → 18 decimals: 1 LYTH = 10^18 lythoshi.
    expect(lythoshiToLythDecimal(1_000_000_000_000_000_000n)).toBe("1");
    expect(lythoshiToLythDecimal(1n)).toBe("0.000000000000000001");
    expect(lythoshiToLythDecimal(123_456_780_000_000_000n)).toBe("0.12345678");
    expect(lythoshiToLythDecimal(1_234_567_890_000_000_000n, 4)).toBe("1.2345");
  });

  it("lythoshiToLythFixed: truncates + ZERO-PADS to dp (never rounds up)", () => {
    expect(lythoshiToLythFixed(99_990000000000000000n, 2)).toBe("99.99");
    expect(lythoshiToLythFixed(100_000000000000000000n, 2)).toBe("100.00"); // pads (vs strip)
    expect(lythoshiToLythFixed(0n, 2)).toBe("0.00");
    // truncate, NOT round: 99.999 → 99.99 (never 100.00)
    expect(lythoshiToLythFixed(99_999000000000000000n, 2)).toBe("99.99");
  });

  it("formats a pending-rewards totalAmountLythoshi at 2dp (home rewards total)", () => {
    // 61.36 LYTH — the live `lyth_pendingRewards.totalAmountLythoshi` (== claimable()).
    expect(lythoshiToLythFixed(BigInt("61360000000000000000"), 2)).toBe("61.36");
    // a fractional reward truncates (never rounds up) to 2dp.
    expect(lythoshiToLythFixed(BigInt("1234567890000000000"), 2)).toBe("1.23");
  });

  describe("home Available/Delegated — exact lythoshi (no lossy float)", () => {
    it("homeAvailableDisplay: 2dp-truncated exact balance", () => {
      expect(homeAvailableDisplay(99_990000000000000000n, 2)).toBe("99.99");
      expect(homeAvailableDisplay(0n, 2)).toBe("0.00");
    });

    it("retires the lossy float: a balance the OLD float path overstated now reads exact", () => {
      // 99.999999999999999999 LYTH: Number(lythoshi)/Number(1e18) === 100 (float
      // rounds up across the 18th decimal), so the old `fmt(account.balance, 2)`
      // showed "100.00" — overstating funds. The exact bigint path truncates to 99.99.
      const lythoshi = 99_999999999999999999n;
      expect(Number(lythoshi) / Number(10n ** 18n)).toBe(100); // the old lossy path
      expect(homeAvailableDisplay(lythoshi, 2)).toBe("99.99"); // the fix
    });

    it("homeDelegatedDisplay: exact balance × totalBps/10000, truncated to 2dp", () => {
      // 100 LYTH × 25% = 25 LYTH
      expect(homeDelegatedDisplay(100_000000000000000000n, 2500, 2)).toBe("25.00");
      // 99.99998765 LYTH × 25% = 24.9999969125 → truncate 2dp → 24.99
      expect(homeDelegatedDisplay(99_999987650000000000n, 2500, 2)).toBe("24.99");
      // 0 bps → 0
      expect(homeDelegatedDisplay(100_000000000000000000n, 0, 2)).toBe("0.00");
      // ~100% of a fractional balance: exact bigint, truncated (not rounded up)
      expect(homeDelegatedDisplay(99_999999999999999999n, 10000, 2)).toBe("99.99");
    });
  });

  it("parses hex lythoshi balances for existing numeric home display state", () => {
    // 0xde0b6b3a7640000 = 10^18 lythoshi = 1 LYTH.
    expect(hexLythoshiToLythNumber("0xde0b6b3a7640000")).toBe(1);
    // 0x1b69b498d037800 = 123456780000000000 lythoshi = 0.12345678 LYTH.
    expect(hexLythoshiToLythNumber("0x1b69b498d037800")).toBe(0.12345678);
  });

  it("rejects malformed quantities", () => {
    expect(parseHexQuantity("not-hex")).toBeNull();
    expect(hexLythoshiToLythNumber("not-hex")).toBeNull();
  });
});
