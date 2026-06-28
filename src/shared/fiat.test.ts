// fiat helper coverage: the single null rate stub, the empty-rate
// "<symbol>—" form (symbol for EVERY currency, never "$0"), the populated
// "≈ <Intl currency string>" form, and per-currency precision (0 / 2 / 3 dp)
// from Intl.

import { describe, expect, it } from "vitest";

import { getLythFiatRate, formatFiat } from "./fiat";
import { ISO_4217_CURRENCIES } from "./iso4217";

describe("fiat — getLythFiatRate (single null stub)", () => {
  it("returns null for every currency (no oracle in Phase 1)", () => {
    expect(getLythFiatRate("USD")).toBeNull();
    expect(getLythFiatRate("EUR")).toBeNull();
    expect(getLythFiatRate("JPY")).toBeNull();
    expect(getLythFiatRate("KWD")).toBeNull();
  });
});

describe("fiat — empty-rate form (<symbol>—, never $0)", () => {
  it("renders <symbol>— for the rock-stable symbols", () => {
    expect(formatFiat("1", "USD", null)).toBe("$—");
    expect(formatFiat("1", "EUR", null)).toBe("€—");
    expect(formatFiat("1", "GBP", null)).toBe("£—");
    expect(formatFiat("1", "JPY", null)).toBe("¥—");
  });

  it("never renders $0 / $0.00 and shows no digit when there is no rate", () => {
    const out = formatFiat("10", "USD", null);
    expect(out).toBe("$—");
    expect(out).not.toBe("$0");
    expect(out).not.toBe("$0.00");
    expect(/[0-9]/.test(out)).toBe(false);
  });

  it("renders a non-empty symbol (none missing) for EVERY curated currency", () => {
    for (const c of ISO_4217_CURRENCIES) {
      const out = formatFiat("1", c.code, null);
      expect(out.endsWith("—")).toBe(true);
      // the part before the dash is the symbol — must be non-empty (no bare "—")
      expect(out.slice(0, -1).length).toBeGreaterThan(0);
      expect(/[0-9]/.test(out)).toBe(false);
    }
  });

  it("derives a non-finite result to the empty-rate form too", () => {
    expect(formatFiat("not-a-number", "USD", 1)).toBe("$—");
  });
});

describe("fiat — populated form (≈ + Intl currency string)", () => {
  it("prefixes ≈ and formats 2-decimal currencies", () => {
    expect(formatFiat("1", "USD", 1)).toBe("≈ $1.00");
    expect(formatFiat("2.5", "EUR", 2)).toBe("≈ €5.00");
  });

  it("uses 0 decimals for JPY (Intl per-currency precision)", () => {
    expect(formatFiat("1000", "JPY", 0.0067)).toBe("≈ ¥7");
  });

  it("uses 3 decimals for KWD", () => {
    const out = formatFiat("1", "KWD", 0.3);
    expect(out.startsWith("≈ ")).toBe(true);
    expect(out).toContain("0.300");
  });

  it("keeps full magnitude for an integer part above 2^53 (no float cast)", () => {
    // Number("9007199254740993") === 9007199254740992 — the old Number(lyth)
    // path silently dropped the final 3. The exact figure must survive.
    expect(formatFiat("9007199254740993", "USD", 1)).toBe(
      "≈ $9,007,199,254,740,993.00",
    );
  });

  it("keeps fractional digits intact on a large amount", () => {
    expect(formatFiat("9007199254740993.50", "USD", 1)).toBe(
      "≈ $9,007,199,254,740,993.50",
    );
  });

  it("applies a fractional rate to a large amount without magnitude loss", () => {
    // 1000000000000000000 LYTH * 2.5 = 2500000000000000000.
    expect(formatFiat("1000000000000000000", "USD", 2.5)).toBe(
      "≈ $2,500,000,000,000,000,000.00",
    );
  });
});
