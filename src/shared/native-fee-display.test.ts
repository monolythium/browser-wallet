import { describe, expect, it } from "vitest";
import {
  computeNativeFeeFromBaseAndPriority,
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
        // Priority at the 1-gwei mempool floor (1e9) so the floor clamp is a
        // no-op and this stays a pure field-name-acceptance test.
        basePricePerExecutionUnitLythoshiHex: "0x3b9aca00", // 1e9
        priorityPricePerExecutionUnitLythoshiHex: "0x3b9aca00", // 1e9 = floor
      },
      { fallbackExecutionUnitLimitHex: "0xa" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display.totalLythoshi).toBe(20_000_000_000n); // (1e9 + 1e9) × 10
    // 2e10 lythoshi under the 18-decimal domain.
    expect(result.display.defaultText).toBe("0.00000002 LYTH");
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

describe("base+priority total clamps the tier-scaled tip to the mempool floor", () => {
  // suggestFee returns the 1-gwei mempool floor (1e9) as the priority tip, on the
  // legacy base+priority shape that the Send headline total + Max reservation are
  // computed from. The submit path (Send.tsx, fee-fix 6345e5c) clamps the SIGNED
  // tip up to the floor, so this display total must clamp identically or it would
  // under-report vs the broadcast.
  const FLOOR = 1_000_000_000n; // 1 gwei
  const base = 2_000_000_000n; // 2 gwei base price
  const units = 30_000n; // realistic native-transfer execution-unit limit
  const total = (bps: bigint): bigint => {
    const r = computeNativeFeeFromBaseAndPriority({
      executionUnitLimitHex: "0x" + units.toString(16),
      basePricePerExecutionUnitLythoshiHex: "0x" + base.toString(16),
      priorityPricePerExecutionUnitLythoshiHex: "0x" + FLOOR.toString(16), // tip == floor
      priorityMultiplierBps: bps,
    });
    if (r === null) throw new Error("unexpected null fee total");
    return r;
  };

  it("Slow (0.5x) clamps the tip up to the floor → total equals the broadcast", () => {
    // Broadcast tip (submit path) = max(0.5 × floor, floor) = floor.
    const broadcastTotal = (base + FLOOR) * units; // 9e13
    expect(total(5_000n)).toBe(broadcastTotal);
    // Pre-fix, the headline used the unclamped 0.5 × floor tip and under-reported.
    const underReported = (base + FLOOR / 2n) * units; // 7.5e13
    expect(underReported).toBeLessThan(broadcastTotal);
  });

  it("normal (1x) and fast (2x) are unchanged (tip already at/above the floor)", () => {
    expect(total(10_000n)).toBe((base + FLOOR) * units); // 1× → tip == floor
    expect(total(5_000n)).toBe(total(10_000n)); // slow now matches normal
    expect(total(20_000n)).toBe((base + 2n * FLOOR) * units); // 2× → above floor, untouched
    expect(total(20_000n)).toBeGreaterThan(total(10_000n));
  });
});
