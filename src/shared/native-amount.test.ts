import { describe, expect, it } from "vitest";
import {
  hexLythoshiToLythNumber,
  lythoshiToLythDecimal,
  parseHexQuantity,
} from "./native-amount.js";

describe("native amount helpers", () => {
  it("formats lythoshi with 8-decimal LYTH precision", () => {
    expect(lythoshiToLythDecimal(100_000_000n)).toBe("1");
    expect(lythoshiToLythDecimal(1n)).toBe("0.00000001");
    expect(lythoshiToLythDecimal(12_345_678n)).toBe("0.12345678");
    expect(lythoshiToLythDecimal(123_456_789n, 4)).toBe("1.2345");
  });

  it("parses hex lythoshi balances for existing numeric home display state", () => {
    expect(hexLythoshiToLythNumber("0x5f5e100")).toBe(1);
    expect(hexLythoshiToLythNumber("0x00bc614e")).toBe(0.12345678);
  });

  it("rejects malformed quantities", () => {
    expect(parseHexQuantity("not-hex")).toBeNull();
    expect(hexLythoshiToLythNumber("not-hex")).toBeNull();
  });
});
