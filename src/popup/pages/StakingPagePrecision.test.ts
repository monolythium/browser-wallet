import { describe, expect, it } from "vitest";
import {
  allocationToLythAmountStr,
  formatLythoshi as formatStakeLythoshi,
  parseLythAmountToLythoshi,
} from "./Stake.js";
import { formatLythoshi as formatDelegationsLythoshi } from "./Delegations.js";

describe("staking page native precision helpers", () => {
  // Chain migrated 8 → 18 decimals (1 lythoshi == 1 wei): 1 LYTH = 10^18 lythoshi.
  it("parses LYTH amounts as 18-decimal lythoshi", () => {
    expect(parseLythAmountToLythoshi("1")).toBe(1_000_000_000_000_000_000n);
    expect(parseLythAmountToLythoshi("0.000000000000000001")).toBe(1n);
    expect(parseLythAmountToLythoshi("1.23456789")).toBe(1_234_567_890_000_000_000n);
  });

  it("rejects zero, malformed, and sub-lythoshi-precision amounts", () => {
    expect(parseLythAmountToLythoshi("0")).toBeNull();
    expect(parseLythAmountToLythoshi("1e-8")).toBeNull();
    expect(parseLythAmountToLythoshi("0.0000000000000000001")).toBeNull();
  });

  it("formats stake and delegations page lythoshi values with native scale", () => {
    expect(formatStakeLythoshi(1_000_000_000_000_000_000n)).toBe("1");
    expect(formatStakeLythoshi(1_234_567_890_000_000_000n, 8)).toBe("1.23456789");
    expect(formatDelegationsLythoshi(123_456_780_000_000_000n, 8)).toBe("0.12345678");
  });

  it("converts autovote allocation weights from balance lythoshi", () => {
    expect(
      allocationToLythAmountStr(
        { cluster: 7, weightBps: 3333 },
        1_234_567_890_000_000_000n,
      ),
    ).toBe("0.411481");
  });
});
