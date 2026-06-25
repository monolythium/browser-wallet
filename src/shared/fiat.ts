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

/** Format the fiat equivalent of a decimal-LYTH amount.
 *  - `rate === null` (or a non-finite result) -> `"<symbol>—"` (e.g. `"$—"`),
 *    the honest no-value form. NEVER `"$0"`.
 *  - a real rate -> `"≈ <Intl currency string>"` (e.g. `"≈ $1.00"`); the `≈`
 *    marks the approximation and appears only when there is an actual value.
 *  The symbol is symbol-first in both forms so the glyph doesn't move when a
 *  rate later lands. */
export function formatFiat(
  lyth: string | number,
  currency: CurrencyCode,
  rate: number | null,
): string {
  const nf = currencyFormatter(currency);
  if (rate === null) return `${currencySymbol(nf)}—`;
  const lythNum = typeof lyth === "string" ? Number(lyth) : lyth;
  const value = lythNum * rate;
  if (!Number.isFinite(value)) return `${currencySymbol(nf)}—`;
  return `≈ ${nf.format(value)}`;
}
