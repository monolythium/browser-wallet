import { describe, expect, it } from "vitest";
import {
  nativeFeeDisplayFromPrice,
  nativeFeeDisplayFromStructuredFee,
} from "./native-fee-display.js";

describe("native fee display conformance", () => {
  it("formats legacy compatibility estimates through the shared LYTH display path", () => {
    const result = nativeFeeDisplayFromPrice({
      executionUnitsHex: "0x5208",
      pricePerExecutionUnitHex: "0x64",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(2_100_000n);
    expect(result.display.defaultText).toBe("0.021 LYTH");
    expect(result.display.defaultText).not.toMatch(/gas|gwei|wei|lythoshi/i);
  });

  it("keeps fee math in bigint space for values above Number.MAX_SAFE_INTEGER", () => {
    const result = nativeFeeDisplayFromPrice({
      executionUnitsHex: "0x20000000000000",
      pricePerExecutionUnitHex: "0x2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(18_014_398_509_481_984n);
  });

  it("accepts valid ADR-0039 structured fee objects", () => {
    const result = nativeFeeDisplayFromStructuredFee({
      total_lythoshi: "123456789",
      total_lyth: "1.23456789",
      cycles_used: 21_000,
      base_price_per_cycle_lythoshi: "5",
      state_io_units: 0,
      state_io_price_per_unit_lythoshi: "0",
      priority_tip_lythoshi: "123351789",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.source).toBe("structured");
    expect(result.display.defaultText).toBe("1.23456789 LYTH");
  });

  it("rejects structured fee objects that embed inherited legacy fee keys", () => {
    const result = nativeFeeDisplayFromStructuredFee({
      total_lythoshi: "123456789",
      total_lyth: "1.23456789",
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
