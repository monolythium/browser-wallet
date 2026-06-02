import { describe, expect, it } from "vitest";
import {
  hexLythoshiToLythNumber,
  lythoshiToLythDecimal,
  parseHexQuantity,
} from "./native-amount.js";

describe("native amount helpers", () => {
  it("formats lythoshi with 18-decimal LYTH precision", () => {
    // Chain migrated 8 → 18 decimals: 1 LYTH = 10^18 lythoshi.
    expect(lythoshiToLythDecimal(1_000_000_000_000_000_000n)).toBe("1");
    expect(lythoshiToLythDecimal(1n)).toBe("0.000000000000000001");
    expect(lythoshiToLythDecimal(123_456_780_000_000_000n)).toBe("0.12345678");
    expect(lythoshiToLythDecimal(1_234_567_890_000_000_000n, 4)).toBe("1.2345");
  });

  it("parses hex lythoshi balances for existing numeric home display state", () => {
    // 0xde0b6b3a7640000 = 10^18 lythoshi = 1 LYTH.
    expect(hexLythoshiToLythNumber("0xde0b6b3a7640000")).toBe(1);
    // 0x1b69b498d037800 = 123456780000000000 lythoshi = 0.12345678 LYTH.
    expect(hexLythoshiToLythNumber("0x1b69b498d037800")).toBe(0.12345678);
  });

  it("rejects malformed quantities", () => {
    expect(parseHexQuantity("not-hex")).toBeNull();
    expect(hexLythoshiToLythNumber("not-hex")).toBeNull();
  });
});
