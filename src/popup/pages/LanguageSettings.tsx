// Language — dedicated display-language page (reached from the Display &
// Preferences hub). Display-only; only English (US) ships today.

import { Icon } from "../Icon";
import { LanguageGrid } from "../components/LanguageGrid";
import { useLanguagePref } from "../hooks/useDisplayPrefs";

export interface LanguageSettingsProps {
  onBack: () => void;
}

export function LanguageSettings({ onBack }: LanguageSettingsProps) {
  const [language, setLanguage] = useLanguagePref();

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 14, fontWeight: 600, textAlign: "center" }}
        >
          Language
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Language</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Display language. More locales will follow — English (US) for now.
          </div>
          <LanguageGrid selectedId={language} onSelect={setLanguage} />
        </div>
      </div>
    </>
  );
}
