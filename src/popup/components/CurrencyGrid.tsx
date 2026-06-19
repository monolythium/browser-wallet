// CurrencyGrid — presentational display-currency picker (no state).
//
// Shared by the Welcome accordion and the dedicated Display-currency page.
// STORED PREFERENCE ONLY: stores the ISO-4217 code; renders no fiat value (no
// price oracle exists). Per-currency decimal precision is carried in the data
// module for a future formatting layer.

import { ISO_4217_CURRENCIES, type CurrencyCode } from "../../shared/iso4217";
import { OptionButton } from "./OptionButton";

export interface CurrencyGridProps {
  selectedCode: CurrencyCode;
  onSelect: (code: CurrencyCode) => void;
}

export function CurrencyGrid({ selectedCode, onSelect }: CurrencyGridProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {ISO_4217_CURRENCIES.map((c) => (
        <OptionButton
          key={c.code}
          active={selectedCode === c.code}
          onClick={() => onSelect(c.code)}
        >
          {c.code} — {c.name}
        </OptionButton>
      ))}
    </div>
  );
}
