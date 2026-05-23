import { describe, expect, it } from "vitest";
import {
  lythToLythoshi as redelegateLythToLythoshi,
  lythoshiToLyth as redelegateLythoshiToLyth,
} from "./RedelegateForm.js";
import { formatLythoshiAsLyth } from "./RewardCard.js";
import {
  lythToLythoshi as stakeLythToLythoshi,
  lythoshiToLyth as stakeLythoshiToLyth,
} from "./StakeForm.js";
import {
  lythToLythoshi as unstakeLythToLythoshi,
  lythoshiToLyth as unstakeLythoshiToLyth,
} from "./UnstakeForm.js";

const LYTHOSHI_PER_LYTH = 100_000_000n;

describe("staking amount parsing at native lythoshi precision", () => {
  it("parses whole and fractional LYTH into 8-decimal lythoshi", () => {
    expect(stakeLythToLythoshi("1")).toBe(LYTHOSHI_PER_LYTH);
    expect(stakeLythToLythoshi("0.00000001")).toBe(1n);
    expect(stakeLythToLythoshi("1.23456789")).toBe(123_456_789n);
  });

  it("rejects fractional precision beyond one lythoshi", () => {
    expect(stakeLythToLythoshi("0.000000001")).toBeNull();
    expect(unstakeLythToLythoshi("1.000000001")).toBeNull();
    expect(redelegateLythToLythoshi("12.123456789")).toBeNull();
  });

  it("rejects non-decimal amount strings", () => {
    expect(stakeLythToLythoshi("")).toBeNull();
    expect(unstakeLythToLythoshi("1e-8")).toBeNull();
    expect(redelegateLythToLythoshi("-1")).toBeNull();
  });
});

describe("staking amount formatting at native lythoshi precision", () => {
  it("formats one lythoshi without truncating to legacy wei scale", () => {
    expect(stakeLythoshiToLyth(1n, 8)).toBe("0.00000001");
    expect(unstakeLythoshiToLyth(1n, 8)).toBe("0.00000001");
    expect(redelegateLythoshiToLyth(1n, 8)).toBe("0.00000001");
  });

  it("formats max-style values with all 8 native decimals and trims zeros", () => {
    expect(stakeLythoshiToLyth(123_456_789n, 8)).toBe("1.23456789");
    expect(unstakeLythoshiToLyth(250_000_001n, 8)).toBe("2.50000001");
    expect(redelegateLythoshiToLyth(100_000_000n, 8)).toBe("1");
  });
});

describe("reward formatting at native lythoshi precision", () => {
  it("renders pending rewards using 8-decimal lythoshi units", () => {
    expect(formatLythoshiAsLyth(1n, 8)).toBe("0.00000001");
    expect(formatLythoshiAsLyth(123_456_789n, 8)).toBe("1.23456789");
    expect(formatLythoshiAsLyth(0n, 8)).toBe("0");
  });
});
