import { describe, expect, it } from "vitest";
import {
  nativeFeeDisplayFromExecutionFeeSuggestion,
  nativeFeeDisplayFromPrice,
  nativeFeeDisplayFromStructuredFee,
} from "./native-fee-display.js";

describe("native fee display conformance", () => {
  it("formats execution-unit estimates through the shared LYTH display path", () => {
    const result = nativeFeeDisplayFromPrice({
      executionUnitLimitHex: "0x5208",
      pricePerExecutionUnitLythoshiHex: "0x64",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(2_100_000n);
    // 2_100_000 lythoshi under the 18-decimal domain.
    expect(result.display.defaultText).toBe("0.0000000000021 LYTH");
    expect(result.display.defaultText).not.toMatch(/gas|gwei|wei|lythoshi/i);
  });

  it("keeps fee math in bigint space for values above Number.MAX_SAFE_INTEGER", () => {
    const result = nativeFeeDisplayFromPrice({
      executionUnitLimitHex: "0x20000000000000",
      pricePerExecutionUnitLythoshiHex: "0x2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(18_014_398_509_481_984n);
  });

  it("accepts native-named fee suggestions without gas aliases", () => {
    const result = nativeFeeDisplayFromExecutionFeeSuggestion(
      {
        executionUnitLimitHex: null,
        basePricePerExecutionUnitLythoshiHex: "0x2",
        priorityPricePerExecutionUnitLythoshiHex: "0x3",
      },
      { fallbackExecutionUnitLimitHex: "0xa" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(50n);
    // 50 lythoshi under the 18-decimal domain.
    expect(result.display.defaultText).toBe("0.00000000000000005 LYTH");
  });

  it("accepts valid ADR-0039 structured fee objects", () => {
    const structuredFee = {
      total_lythoshi: "123456789",
      cycles_used: 21_000,
      base_price_per_cycle_lythoshi: "5",
      state_io_units: 0,
      state_io_price_per_unit_lythoshi: "0",
      priority_tip_lythoshi: "123351789",
    };
    expect(Object.keys(structuredFee)).toEqual([
      "total_lythoshi",
      "cycles_used",
      "base_price_per_cycle_lythoshi",
      "state_io_units",
      "state_io_price_per_unit_lythoshi",
      "priority_tip_lythoshi",
    ]);

    const result = nativeFeeDisplayFromStructuredFee(structuredFee);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.source).toBe("structured");
    // total_lythoshi "123456789" under the 18-decimal domain.
    expect(result.display.defaultText).toBe("0.000000000123456789 LYTH");
    expect(result.display.detailTexts).toEqual([
      "cycles 21000, state I/O 0, total 123456789 lythoshi",
      "cycle price 5 lythoshi, state I/O price 0 lythoshi, priority tip 123351789 lythoshi",
    ]);
  });

  it("rejects structured fee objects that embed inherited legacy fee keys", () => {
    const result = nativeFeeDisplayFromStructuredFee({
      total_lythoshi: "123456789",
      cycles_used: 21_000,
      base_price_per_cycle_lythoshi: "5",
      state_io_units: 0,
      state_io_price_per_unit_lythoshi: "0",
      priority_tip_lythoshi: "123351789",
      gasPrice: "0x64",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.join("; ")).toContain("unexpected field 'gasPrice'");
  });
});
