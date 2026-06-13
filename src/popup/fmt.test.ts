// `fmt` formats token amounts for the Home hero + asset cards. It must
// TRUNCATE toward zero, never round up — rounding showed "100.00" for a
// 99.9998 balance, overstating funds and disagreeing with the Send screen.
//
// Assertions compare against the locale-formatted *expected truncated* value
// so the test is independent of the runner's default locale.

import { describe, expect, it } from "vitest";
import { fmt } from "./Icon";

const loc = (n: number, dp = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

describe("fmt — truncates token amounts (never rounds up)", () => {
  it("renders 99.9998 as 99.99, not 100.00", () => {
    expect(fmt(99.9998, 2)).toBe(loc(99.99));
    expect(fmt(99.9998, 2)).not.toBe(loc(100));
  });

  it("leaves exact values unchanged", () => {
    expect(fmt(100, 2)).toBe(loc(100));
    expect(fmt(0, 2)).toBe(loc(0));
    expect(fmt(42.5, 2)).toBe(loc(42.5));
  });

  it("truncates at the requested precision", () => {
    expect(fmt(1.239, 2)).toBe(loc(1.23));
    expect(fmt(1.999999, 4)).toBe(loc(1.9999, 4));
  });

  it("renders null/undefined as an em dash", () => {
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
  });
});
