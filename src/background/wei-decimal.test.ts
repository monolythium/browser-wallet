// Golden conversion test for pending-row amountDecimal.
//
// The pending-row reconciliation contract in
// shared/activity.ts:reconcilePending matches a pending row against
// a confirmed tx_send by exact string equality on `amountDecimal`.
// The SW receives the IPC compatibility field `valueWeiHex`, but for
// native LYTH sends that field now carries v4.1 lythoshi. The helper
// must therefore format 8 native decimals, or pending rows will fail
// to match the indexer's confirmed decimal LYTH strings.

import { describe, expect, it } from "vitest";
import {
  lythoshiHexToLythDecimal,
  weiHexToLythDecimal,
} from "./wei-decimal.js";
import { lythoshiDecimalToLythDecimal } from "../shared/lyth-units.js";

// Each fixture: a bigint lythoshi value + the expected decimal string.
// The fixture set covers zero, the smallest non-zero unit, common fractional
// boundaries, a mixed integer/fractional amount, and a large bigint that
// would lose precision if the helper downcast to Number.
const FIXTURES: Array<{ lythoshi: bigint; expected: string; label: string }> = [
  { lythoshi: 0n, expected: "0", label: "zero" },
  { lythoshi: 1n, expected: "0.00000001", label: "1 lythoshi" },
  { lythoshi: 2_000_000n, expected: "0.02", label: "0.02 LYTH" },
  { lythoshi: 10_000_000n, expected: "0.1", label: "0.1 LYTH" },
  { lythoshi: 100_000_000n, expected: "1", label: "1 LYTH" },
  {
    lythoshi: 123_456_789n,
    expected: "1.23456789",
    label: "full 8-decimal fraction",
  },
  {
    lythoshi: 700_000_001n,
    expected: "7.00000001",
    label: "mixed integer + smallest fraction",
  },
  {
    lythoshi: 10_000_000_000n,
    expected: "100",
    label: "100 LYTH",
  },
  {
    lythoshi: BigInt(Number.MAX_SAFE_INTEGER),
    expected: "90071992.54740991",
    label: "Number.MAX_SAFE_INTEGER lythoshi",
  },
];

describe("lythoshiHexToLythDecimal", () => {
  for (const { lythoshi, expected, label } of FIXTURES) {
    it(`${label}: produces "${expected}"`, () => {
      expect(lythoshiHexToLythDecimal("0x" + lythoshi.toString(16))).toBe(
        expected,
      );
    });
  }

  it("keeps the deprecated wei-named export as a lythoshi compatibility wrapper", () => {
    const valueWeiHex = "0x" + 10_000_000n.toString(16);
    expect(weiHexToLythDecimal(valueWeiHex)).toBe("0.1");
    expect(weiHexToLythDecimal(valueWeiHex)).toBe(
      lythoshiHexToLythDecimal(valueWeiHex),
    );
  });

  it("invalid or non-hex input returns '0' defensively", () => {
    expect(lythoshiHexToLythDecimal("not-a-hex-string")).toBe("0");
    expect(lythoshiHexToLythDecimal("16345785d8a0000")).toBe("0");
    expect(lythoshiHexToLythDecimal("100000000")).toBe("0");
  });

  it("accepts lowercase and uppercase hex digits identically", () => {
    expect(lythoshiHexToLythDecimal("0x75bcd15")).toBe("1.23456789");
    expect(lythoshiHexToLythDecimal("0x75BCD15")).toBe("1.23456789");
  });
});

// The activity mapper (confirmed side) converts the indexer's DECIMAL lythoshi
// string, while the pending-row writer converts a HEX lythoshi string. Both
// must agree to the byte or reconcilePending (exact string equality) won't fire.
describe("lythoshiDecimalToLythDecimal — reconciler byte-identity", () => {
  for (const { lythoshi, expected, label } of FIXTURES) {
    it(`${label}: decimal entry point matches the hex entry point and equals "${expected}"`, () => {
      const fromDecimal = lythoshiDecimalToLythDecimal(lythoshi.toString(10));
      const fromHex = lythoshiHexToLythDecimal("0x" + lythoshi.toString(16));
      expect(fromDecimal).toBe(expected);
      expect(fromDecimal).toBe(fromHex);
    });
  }

  it("returns '0' for malformed (non-integer) decimal input", () => {
    expect(lythoshiDecimalToLythDecimal("1.0")).toBe("0");
    expect(lythoshiDecimalToLythDecimal("0x10")).toBe("0");
    expect(lythoshiDecimalToLythDecimal("")).toBe("0");
  });
});
