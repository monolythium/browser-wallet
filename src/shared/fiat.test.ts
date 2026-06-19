// fiat helper coverage: the single null rate stub, the null->em-dash rule
// (never "$0"), per-currency decimal precision (0 / 2 / 3 dp), the symbol
// table + code fallback, and the withFiat wrapper.

import { describe, expect, it } from "vitest";

import { getLythFiatRate, formatFiat, withFiat } from "./fiat";

describe("fiat — getLythFiatRate (single null stub)", () => {
  it("returns null for every currency (no oracle in Phase 1)", () => {
    expect(getLythFiatRate("USD")).toBeNull();
    expect(getLythFiatRate("EUR")).toBeNull();
    expect(getLythFiatRate("JPY")).toBeNull();
    expect(getLythFiatRate("KWD")).toBeNull();
  });
});

describe("fiat — formatFiat", () => {
  it("returns an em-dash when the rate is null (never $0)", () => {
    expect(formatFiat("1", "USD", null)).toBe("—");
    expect(formatFiat(10, "USD", null)).toBe("—");
    expect(formatFiat("1", "USD", null)).not.toBe("$0");
    expect(formatFiat("1", "USD", null)).not.toBe("$0.00");
  });

  it("formats a 2-decimal currency with its symbol", () => {
    expect(formatFiat("1", "USD", 1)).toBe("$1.00");
    expect(formatFiat("2.5", "EUR", 2)).toBe("€5.00");
  });

  it("formats a 0-decimal currency (JPY) with no decimals", () => {
    expect(formatFiat("1000", "JPY", 0.0067)).toBe("¥7");
  });

  it("formats a 3-decimal currency (KWD) at 3 dp via the code-prefix fallback", () => {
    expect(formatFiat("1", "KWD", 0.3)).toBe("KWD 0.300");
  });

  it("falls back to a '<CODE> ' prefix for a symbol-less code", () => {
    expect(formatFiat("1", "AED", 2)).toBe("AED 2.00");
  });

  it("returns an em-dash for a non-finite result", () => {
    expect(formatFiat("not-a-number", "USD", 1)).toBe("—");
  });
});

describe("fiat — withFiat", () => {
  it("renders the em-dash form when fiat is unavailable", () => {
    expect(withFiat("1 LYTH", "—")).toBe("1 LYTH (—)");
  });

  it("renders the approx form when fiat is present", () => {
    expect(withFiat("1 LYTH", "$1.00")).toBe("1 LYTH (≈ $1.00)");
  });
});
