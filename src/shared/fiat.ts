// Fiat-equivalent display for LYTH amounts.
//
// SINGLE rate source: getLythFiatRate is the ONLY place a LYTH->fiat rate is
// produced. It returns null today — no price oracle / feed exists yet (see the
// "no oracle" notes in iso4217.ts + passkey.ts). The oracle attaches HERE
// later; until then every fiat slot renders an honest em-dash "—" (NEVER "$0",
// which would assert a false value: 10 LYTH is not $0). No network, no mock, no
// fabricated number anywhere in this file.

import { ISO_4217_CURRENCIES, type CurrencyCode } from "./iso4217";

// Per-currency minor-unit precision, sourced from the curated table
// (JPY/KRW/VND = 0, KWD/BHD/OMR = 3, else 2).
const DECIMALS: ReadonlyMap<string, 0 | 2 | 3> = new Map(
  ISO_4217_CURRENCIES.map((c) => [c.code, c.decimals]),
);

// Minimal code->symbol table. Unknown codes fall back to a "<CODE> " prefix
// (e.g. "AED 2.00") so every currency renders something sensible without
// needing a glyph for all ~25 entries.
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  CAD: "$",
  AUD: "$",
  NZD: "$",
  HKD: "$",
  SGD: "$",
  MXN: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  BRL: "R$",
  CHF: "CHF ",
  TRY: "₺",
};

function symbolFor(code: string): string {
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

/** The SINGLE LYTH->fiat rate source. Phase-1: no oracle exists, so this always
 *  returns null. When a real price feed lands it attaches HERE and every fiat
 *  slot lights up with no other change. It never returns a fabricated rate. */
export function getLythFiatRate(_currency: CurrencyCode): number | null {
  return null;
}

/** Format a fiat equivalent of a decimal-LYTH amount. `rate === null` (no
 *  oracle) -> "—", NEVER "$0". Otherwise: lyth * rate, formatted at the
 *  currency's minor-unit precision with its symbol (or a code prefix). */
export function formatFiat(
  lyth: string | number,
  currency: CurrencyCode,
  rate: number | null,
): string {
  if (rate === null) return "—";
  const lythNum = typeof lyth === "string" ? Number(lyth) : lyth;
  const value = lythNum * rate;
  if (!Number.isFinite(value)) return "—";
  const dp = DECIMALS.get(currency) ?? 2;
  return `${symbolFor(currency)}${value.toFixed(dp)}`;
}

/** Combine the canonical LYTH text with its fiat equivalent beside it:
 *  "1 LYTH (≈ $1.00)", or "1 LYTH (—)" when no rate is available. The "≈"
 *  signals approximation. The LYTH text is passed through untouched. */
export function withFiat(lythText: string, fiat: string): string {
  return fiat === "—" ? `${lythText} (—)` : `${lythText} (≈ ${fiat})`;
}
