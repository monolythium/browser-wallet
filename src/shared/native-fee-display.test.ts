import { describe, expect, it } from "vitest";
import {
  computeNativeFeeFromBaseAndPriority,
  nativeFeeDisplayFromExecutionFeeSuggestion,
  nativeFeeDisplayFromPrice,
  nativeFeeDisplayFromStructuredFee,
} from "./native-fee-display.js";
import { MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI } from "./operator-bounds.js";

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

describe("base+priority total clamps a below-floor priority tip to the mempool floor", () => {
  // Defensive clamp in nativeFeeDisplayFromBaseAndPriority: a priority price below
  // the mempool floor is raised to MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI so the
  // displayed total (and the Max reservation derived from it) matches the submit
  // path, which signs the clamped tip. No wallet tier produces a below-floor tip
  // today (the Slow 0.5x tier was removed), but the clamp guards a future
  // tier/Custom and a chain that ever returns a sub-floor suggestion. Exercised
  // here DIRECTLY via a below-floor priority input at 1x — not via a tier.
  const FLOOR = MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI; // 1e9 (1 gwei)
  const base = 2_000_000_000n; // 2 gwei base price
  const units = 30_000n; // realistic native-transfer execution-unit limit
  const totalForTip = (priorityLythoshi: bigint): bigint => {
    const r = computeNativeFeeFromBaseAndPriority({
      executionUnitLimitHex: "0x" + units.toString(16),
      basePricePerExecutionUnitLythoshiHex: "0x" + base.toString(16),
      priorityPricePerExecutionUnitLythoshiHex: "0x" + priorityLythoshi.toString(16),
      priorityMultiplierBps: 10_000n, // 1x — isolate the floor clamp, not a tier
    });
    if (r === null) throw new Error("unexpected null fee total");
    return r;
  };

  it("raises a below-floor priority tip up to the floor", () => {
    const belowFloor = FLOOR / 2n; // 5e8 < floor
    // Clamped to the floor: total = (base + floor) × units, NOT (base + 5e8) × units.
    expect(totalForTip(belowFloor)).toBe((base + FLOOR) * units);
    expect(totalForTip(belowFloor)).toBe(totalForTip(FLOOR)); // == an at-floor tip
    // Without the clamp it would have been strictly lower.
    expect((base + belowFloor) * units).toBeLessThan((base + FLOOR) * units);
  });

  it("leaves an at/above-floor priority tip untouched", () => {
    expect(totalForTip(FLOOR)).toBe((base + FLOOR) * units); // at the floor
    const aboveFloor = 2n * FLOOR; // 2e9 (e.g. the Fast tier's effective tip)
    expect(totalForTip(aboveFloor)).toBe((base + aboveFloor) * units); // untouched
    expect(totalForTip(aboveFloor)).toBeGreaterThan(totalForTip(FLOOR));
  });
});
