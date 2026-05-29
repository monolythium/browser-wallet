import { describe, expect, it } from "vitest";
import { formatWeightBpsPercent } from "./staking.js";

describe("formatWeightBpsPercent", () => {
  it("renders basis points as a 2-dp percent (the delegation-weight display)", () => {
    expect(formatWeightBpsPercent(107)).toBe("1.07%");
    expect(formatWeightBpsPercent(1)).toBe("0.01%");
    expect(formatWeightBpsPercent(500)).toBe("5.00%");
    expect(formatWeightBpsPercent(10000)).toBe("100.00%");
  });

  it("never emits a 'bps' string and degrades to em-dash on null/non-finite", () => {
    expect(formatWeightBpsPercent(107)).not.toContain("bps");
    expect(formatWeightBpsPercent(null)).toBe("—");
    expect(formatWeightBpsPercent(Number.NaN)).toBe("—");
  });
});
