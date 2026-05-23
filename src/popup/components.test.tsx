import { describe, expect, it } from "vitest";
import {
  applyFeeTier,
  computeNativeFeeLythoshi,
  formatExecutionUnits,
  formatLythoshiAmountHex,
  formatLythoshiPerExecutionUnit,
  lythoshiToLythString,
} from "./components.js";

describe("ReqSendTx native fee helpers", () => {
  it("formats native LYTH values with 8-decimal lythoshi precision", () => {
    expect(formatLythoshiAmountHex("0x5f5e100")).toBe("1");
    expect(formatLythoshiAmountHex("0x1")).toBe("0.00000001");
    expect(formatLythoshiAmountHex("0x00bc614e")).toBe("0.12345678");
    expect(lythoshiToLythString(123_456_789n)).toBe("1.23456789");
  });

  it("keeps execution-unit price as lythoshi, not gwei", () => {
    expect(formatExecutionUnits("0x5208")).toBe("21000");
    expect(formatLythoshiPerExecutionUnit("0x64")).toBe("100");
  });

  it("computes tiered max fee in lythoshi", () => {
    expect(applyFeeTier(100n, "low")).toBe(90n);
    expect(applyFeeTier(100n, "medium")).toBe(100n);
    expect(applyFeeTier(100n, "high")).toBe(130n);

    expect(computeNativeFeeLythoshi("0x5208", "0x64", "medium")).toBe(
      2_100_000n,
    );
    expect(
      lythoshiToLythString(
        computeNativeFeeLythoshi("0x5208", "0x64", "medium") ?? 0n,
      ),
    ).toBe("0.021");
  });

  it("returns null/placeholder for missing malformed fee inputs", () => {
    expect(computeNativeFeeLythoshi(null, "0x64", "medium")).toBeNull();
    expect(computeNativeFeeLythoshi("0x5208", "not-hex", "medium")).toBeNull();
    expect(formatLythoshiAmountHex("not-hex")).toBe("—");
  });
});
