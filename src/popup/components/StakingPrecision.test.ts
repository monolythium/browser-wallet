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

// Chain migrated 8 → 18 decimals (1 lythoshi == 1 wei): 1 LYTH = 10^18 lythoshi.
const LYTHOSHI_PER_LYTH = 1_000_000_000_000_000_000n;

describe("staking amount parsing at native lythoshi precision", () => {
  it("parses whole and fractional LYTH into 18-decimal lythoshi", () => {
    expect(stakeLythToLythoshi("1")).toBe(LYTHOSHI_PER_LYTH);
    expect(stakeLythToLythoshi("0.000000000000000001")).toBe(1n);
    expect(stakeLythToLythoshi("1.23456789")).toBe(1_234_567_890_000_000_000n);
  });

  it("rejects fractional precision beyond one lythoshi", () => {
    expect(stakeLythToLythoshi("0.0000000000000000001")).toBeNull();
    expect(unstakeLythToLythoshi("1.0000000000000000001")).toBeNull();
    expect(redelegateLythToLythoshi("12.1234567890000000001")).toBeNull();
  });

  it("rejects non-decimal amount strings", () => {
    expect(stakeLythToLythoshi("")).toBeNull();
    expect(unstakeLythToLythoshi("1e-8")).toBeNull();
    expect(redelegateLythToLythoshi("-1")).toBeNull();
  });
});

describe("staking amount formatting at native lythoshi precision", () => {
  it("formats one lythoshi without truncating to legacy wei scale", () => {
    expect(stakeLythoshiToLyth(1n, 18)).toBe("0.000000000000000001");
    expect(unstakeLythoshiToLyth(1n, 18)).toBe("0.000000000000000001");
    expect(redelegateLythoshiToLyth(1n, 18)).toBe("0.000000000000000001");
  });

  it("formats max-style values with all 18 native decimals and trims zeros", () => {
    expect(stakeLythoshiToLyth(1_234_567_890_000_000_000n, 18)).toBe("1.23456789");
    expect(unstakeLythoshiToLyth(2_500_000_010_000_000_000n, 18)).toBe("2.50000001");
    expect(redelegateLythoshiToLyth(1_000_000_000_000_000_000n, 18)).toBe("1");
  });
});

describe("reward formatting at native lythoshi precision", () => {
  it("renders pending rewards using 18-decimal lythoshi units", () => {
    expect(formatLythoshiAsLyth(1n, 18)).toBe("0.000000000000000001");
    expect(formatLythoshiAsLyth(1_234_567_890_000_000_000n, 18)).toBe("1.23456789");
    expect(formatLythoshiAsLyth(0n, 18)).toBe("0");
  });
});
