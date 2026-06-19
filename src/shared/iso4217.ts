// Curated ISO-4217 currency set for the display-currency preference.
//
// STORED PREFERENCE ONLY: the wallet renders no fiat value today (no
// LYTH->fiat price feed / oracle exists), so nothing here is converted or
// displayed as an amount. The `decimals` (minor-unit count) is carried now so
// a future formatting layer can read it without a data migration:
//   JPY / KRW / VND = 0 ; KWD / BHD / OMR = 3 ; everything else = 2.
//
// This is a curated shortlist (majors + the precision-notable currencies),
// not the full ~180-entry ISO-4217 table — extend the array as needed.

export interface Iso4217Entry {
  readonly code: string;
  readonly name: string;
  readonly decimals: 0 | 2 | 3;
}

// `as const satisfies` keeps the literal `code` types (so CurrencyCode is a
// precise union, not `string`) while still checking each entry against the
// Iso4217Entry shape.
export const ISO_4217_CURRENCIES = [
  { code: "USD", name: "US Dollar", decimals: 2 },
  { code: "EUR", name: "Euro", decimals: 2 },
  { code: "GBP", name: "British Pound", decimals: 2 },
  { code: "CHF", name: "Swiss Franc", decimals: 2 },
  { code: "CAD", name: "Canadian Dollar", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", decimals: 2 },
  { code: "NZD", name: "New Zealand Dollar", decimals: 2 },
  { code: "CNY", name: "Chinese Yuan", decimals: 2 },
  { code: "HKD", name: "Hong Kong Dollar", decimals: 2 },
  { code: "SGD", name: "Singapore Dollar", decimals: 2 },
  { code: "INR", name: "Indian Rupee", decimals: 2 },
  { code: "BRL", name: "Brazilian Real", decimals: 2 },
  { code: "MXN", name: "Mexican Peso", decimals: 2 },
  { code: "ZAR", name: "South African Rand", decimals: 2 },
  { code: "TRY", name: "Turkish Lira", decimals: 2 },
  { code: "AED", name: "UAE Dirham", decimals: 2 },
  { code: "SEK", name: "Swedish Krona", decimals: 2 },
  { code: "NOK", name: "Norwegian Krone", decimals: 2 },
  { code: "PLN", name: "Polish Zloty", decimals: 2 },
  // Zero-decimal currencies.
  { code: "JPY", name: "Japanese Yen", decimals: 0 },
  { code: "KRW", name: "South Korean Won", decimals: 0 },
  { code: "VND", name: "Vietnamese Dong", decimals: 0 },
  // Three-decimal currencies.
  { code: "KWD", name: "Kuwaiti Dinar", decimals: 3 },
  { code: "BHD", name: "Bahraini Dinar", decimals: 3 },
  { code: "OMR", name: "Omani Rial", decimals: 3 },
] as const satisfies readonly Iso4217Entry[];

export type CurrencyCode = (typeof ISO_4217_CURRENCIES)[number]["code"];

const CURRENCY_CODE_SET: ReadonlySet<string> = new Set(
  ISO_4217_CURRENCIES.map((c) => c.code),
);

/** Membership guard for a stored/loaded currency code against the curated set. */
export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === "string" && CURRENCY_CODE_SET.has(v);
}
