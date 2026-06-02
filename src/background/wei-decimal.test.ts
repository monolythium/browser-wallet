// Golden conversion test for pending-row amountDecimal.
//
// The pending-row reconciliation contract in
// shared/activity.ts:reconcilePending matches a pending row against
// a confirmed tx_send by exact string equality on `amountDecimal`.
// The SW receives the IPC compatibility field `valueWeiHex`, but for
// native LYTH sends that field now carries native lythoshi. The chain
// migrated 8 → 18 decimals (1 lythoshi == 1 wei); the helper must
// therefore format 18 native decimals, or pending rows will fail to
// match the indexer's confirmed decimal LYTH strings.

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
  {
    lythoshi: 1n,
    expected: "0.000000000000000001",
    label: "1 lythoshi (smallest 18-decimal unit)",
  },
  { lythoshi: 20_000_000_000_000_000n, expected: "0.02", label: "0.02 LYTH" },
  { lythoshi: 100_000_000_000_000_000n, expected: "0.1", label: "0.1 LYTH" },
  { lythoshi: 1_000_000_000_000_000_000n, expected: "1", label: "1 LYTH" },
  {
    lythoshi: 1_234_567_890_000_000_000n,
    expected: "1.23456789",
    label: "8-decimal fraction in the 18-decimal domain",
  },
  {
    lythoshi: 7_000_000_010_000_000_000n,
    expected: "7.00000001",
    label: "mixed integer + fraction",
  },
  {
    lythoshi: 100_000_000_000_000_000_000n,
    expected: "100",
    label: "100 LYTH",
  },
  {
    lythoshi: 90_071_992_547_409_910_000_000_000n,
    expected: "90071992.54740991",
    label: "large bigint beyond Number precision",
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
    const valueWeiHex = "0x" + 100_000_000_000_000_000n.toString(16);
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
    // 0x112210f4768db400 = 1_234_567_890_000_000_000 lythoshi = 1.23456789 LYTH.
    expect(lythoshiHexToLythDecimal("0x112210f4768db400")).toBe("1.23456789");
    expect(lythoshiHexToLythDecimal("0x112210F4768DB400")).toBe("1.23456789");
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
