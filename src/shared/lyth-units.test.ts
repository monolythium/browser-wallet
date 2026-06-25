import { describe, it, expect } from "vitest";
import { formatLythDecimalDisplay } from "./lyth-units.js";

describe("formatLythDecimalDisplay (4dp display truncation)", () => {
  it("truncates to 4 fractional digits + trims trailing zeros", () => {
    // The reported bug: a claim showed 18-dec precision.
    expect(formatLythDecimalDisplay("0.980035894719687092", 4)).toBe("0.98");
    expect(formatLythDecimalDisplay("0.123456789", 4)).toBe("0.1234");
    expect(formatLythDecimalDisplay("1.5", 4)).toBe("1.5");
    expect(formatLythDecimalDisplay("3", 4)).toBe("3");
    // sub-4dp fraction → drops to the integer part (matches lythoshiToLyth(x,4)).
    expect(formatLythDecimalDisplay("12.000000001", 4)).toBe("12");
  });
  it("TRUNCATES, never rounds", () => {
    expect(formatLythDecimalDisplay("0.99999", 4)).toBe("0.9999");
  });
  it("passes a malformed / non-decimal string through unchanged", () => {
    expect(formatLythDecimalDisplay("abc", 4)).toBe("abc");
  });
});
