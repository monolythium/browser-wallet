// Fiat-equivalent display for LYTH amounts.
//
// SINGLE rate source: getLythFiatRate is the ONLY place a LYTH->fiat rate is
// produced. It returns null today — no price oracle / feed exists yet. The
// oracle attaches HERE later; until then every fiat slot renders the selected
// currency's symbol followed by an em-dash ("$—", "¥—", "kr—") — the honest
// "no value yet" form, NEVER "$0" (which would assert a false value). No
// network, no mock, no fabricated number anywhere in this file.
//
// Symbols + per-currency decimals come from Intl.NumberFormat (locale en-US,
// narrowSymbol), so every ISO-4217 code renders a correct glyph + precision
// with none missing — no hand-maintained symbol table.

import { type CurrencyCode } from "./iso4217";

function currencyFormatter(currency: CurrencyCode): Intl.NumberFormat {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  });
}

// The currency glyph for the empty-rate form, taken from a formatted zero so it
// matches the symbol Intl will use once a real value renders (e.g. "$", "¥",
// "kr", or a code like "KWD" where no narrow glyph exists).
function currencySymbol(nf: Intl.NumberFormat): string {
  const part = nf.formatToParts(0).find((p) => p.type === "currency");
  return part?.value ?? "";
}

/** The SINGLE LYTH->fiat rate source. Phase-1: no oracle exists, so this always
 *  returns null. When a real price feed lands it attaches HERE and every fiat
 *  slot lights up with no other change. It never returns a fabricated rate. */
export function getLythFiatRate(_currency: CurrencyCode): number | null {
  return null;
}

/** Parse a decimal (optionally signed / exponential) numeric string into a
 *  signed bigint mantissa plus the number of fractional digits it carries, so
 *  the value equals `mantissa / 10^frac` EXACTLY. Returns null for anything
 *  that isn't a finite decimal number. This keeps the full magnitude of the
 *  input — no `Number()` round-trip — so integer parts above 2^53 survive. */
function parseDecimalToScaled(
  s: string,
): { mantissa: bigint; frac: number } | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  const digits = intPart + fracPart;
  // value = digits * 10^(exp - fracPart.length); netScale = fracPart.length - exp.
  const netScale = fracPart.length - exp;
  if (netScale >= 0) {
    return { mantissa: sign * BigInt(digits), frac: netScale };
  }
  return { mantissa: sign * BigInt(digits + "0".repeat(-netScale)), frac: 0 };
}

/** Divide `num` by a positive power-of-ten `den`, rounding half away from zero
 *  (the same mode Intl currency formatting uses). */
function roundDivPow10(num: bigint, den: bigint): bigint {
  const half = den / 2n; // exact: den is a power of ten >= 10 here
  return num >= 0n ? (num + half) / den : -((-num + half) / den);
}

/** Format the fiat equivalent of a decimal-LYTH amount.
 *  - `rate === null` (or a non-finite / unparseable result) -> `"<symbol>—"`
 *    (e.g. `"$—"`), the honest no-value form. NEVER `"$0"`.
 *  - a real rate -> `"≈ <Intl currency string>"` (e.g. `"≈ $1.00"`); the `≈`
 *    marks the approximation and appears only when there is an actual value.
 *  The symbol is symbol-first in both forms so the glyph doesn't move when a
 *  rate later lands.
 *
 *  The amount is multiplied by the rate in exact bigint fixed-point — the LYTH
 *  amount is never forced through a 64-bit float, so an integer part above 2^53
 *  keeps its full magnitude. Only the final, currency-rounded result is handed
 *  to Intl (formatted from a bigint integer part so even large totals stay
 *  exact). */
export function formatFiat(
  lyth: string | number,
  currency: CurrencyCode,
  rate: number | null,
): string {
  const nf = currencyFormatter(currency);
  if (rate === null || !Number.isFinite(rate)) return `${currencySymbol(nf)}—`;

  const amount = parseDecimalToScaled(
    typeof lyth === "string" ? lyth : lyth.toString(),
  );
  // `rate.toString()` is the shortest round-trip decimal for the double, parsed
  // the same exact way so no precision is invented or lost beyond the rate.
  const price = parseDecimalToScaled(rate.toString());
  if (amount === null || price === null) return `${currencySymbol(nf)}—`;

  // value = (amount.mantissa * price.mantissa) / 10^(amount.frac + price.frac).
  const product = amount.mantissa * price.mantissa;
  const displayDigits = nf.resolvedOptions().maximumFractionDigits ?? 2;

  // Scale the product to the currency's display minor units, rounding once.
  const downScale = amount.frac + price.frac - displayDigits;
  const minorUnits =
    downScale >= 0
      ? roundDivPow10(product, 10n ** BigInt(downScale))
      : product * 10n ** BigInt(-downScale);

  const negative = minorUnits < 0n;
  const absMinor = negative ? -minorUnits : minorUnits;
  const scale = 10n ** BigInt(displayDigits);
  const integerPart = absMinor / scale; // bigint -> no 2^53 ceiling
  const fractionPart = absMinor % scale;
  const fractionStr =
    displayDigits > 0 ? fractionPart.toString().padStart(displayDigits, "0") : "";

  // Format the integer part as the currency (correct symbol, grouping, decimals)
  // then substitute our exact fraction digits into the Intl fraction slot.
  const body = nf
    .formatToParts(integerPart)
    .map((p) => (p.type === "fraction" ? fractionStr : p.value))
    .join("");
  return `≈ ${negative ? "-" : ""}${body}`;
}
