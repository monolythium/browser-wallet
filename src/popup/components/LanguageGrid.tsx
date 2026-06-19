// LanguageGrid — presentational language picker (no state).
//
// Shared by the Welcome accordion and the dedicated Language page. Only English
// (US) ships today (no i18n framework yet), so this is effectively a labelled
// placeholder that documents "more locales later". The flag is a Unicode emoji
// — no image asset ships.

import { LANGUAGE_VALUES, type LanguageCode } from "../../shared/constants";
import { OptionButton } from "./OptionButton";

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  "en-US": "🇺🇸  English (US)",
};

export interface LanguageGridProps {
  selectedId: LanguageCode;
  onSelect: (id: LanguageCode) => void;
}

export function LanguageGrid({ selectedId, onSelect }: LanguageGridProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {(LANGUAGE_VALUES as readonly LanguageCode[]).map((code) => (
        <OptionButton
          key={code}
          active={selectedId === code}
          onClick={() => onSelect(code)}
        >
          {LANGUAGE_LABELS[code]}
        </OptionButton>
      ))}
    </div>
  );
}
