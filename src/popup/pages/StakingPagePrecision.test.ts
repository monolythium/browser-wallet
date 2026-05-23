import { describe, expect, it } from "vitest";
import {
  allocationToLythAmountStr,
  formatLythoshi as formatStakeLythoshi,
  parseLythAmountToLythoshi,
} from "./Stake.js";
import { formatLythoshi as formatDelegationsLythoshi } from "./Delegations.js";

describe("staking page native precision helpers", () => {
  it("parses LYTH amounts as 8-decimal lythoshi", () => {
    expect(parseLythAmountToLythoshi("1")).toBe(100_000_000n);
    expect(parseLythAmountToLythoshi("0.00000001")).toBe(1n);
    expect(parseLythAmountToLythoshi("1.23456789")).toBe(123_456_789n);
  });

  it("rejects zero, malformed, and sub-lythoshi-precision amounts", () => {
    expect(parseLythAmountToLythoshi("0")).toBeNull();
    expect(parseLythAmountToLythoshi("1e-8")).toBeNull();
    expect(parseLythAmountToLythoshi("0.000000001")).toBeNull();
  });

  it("formats stake and delegations page lythoshi values with native scale", () => {
    expect(formatStakeLythoshi(100_000_000n)).toBe("1");
    expect(formatStakeLythoshi(123_456_789n, 8)).toBe("1.23456789");
    expect(formatDelegationsLythoshi(12_345_678n, 8)).toBe("0.12345678");
  });

  it("converts autovote allocation weights from balance lythoshi", () => {
    expect(
      allocationToLythAmountStr({ cluster: 7, weightBps: 3333 }, 123_456_789n),
    ).toBe("0.411481");
  });
});
