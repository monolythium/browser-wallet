// Display & Preferences — a small hub page listing the three display
// preferences, each routing to its own dedicated page:
//   Theme · Language · Display currency
// Reached from the hamburger menu (Settings section) and the Settings page.
// Each row shows the current value as a hint. Display-only; nothing here
// touches the vault or any amount formatter.

import { Icon, type IconName } from "../Icon";
import { THEMES, readTheme } from "../theme";
import { LANGUAGE_LABELS } from "../components/LanguageGrid";
import {
  useLanguagePref,
  useDisplayCurrencyPref,
} from "../hooks/useDisplayPrefs";

export interface DisplayPreferencesProps {
  onBack: () => void;
  onOpenTheme: () => void;
  onOpenLanguage: () => void;
  onOpenCurrency: () => void;
}

export function DisplayPreferences({
  onBack,
  onOpenTheme,
  onOpenLanguage,
  onOpenCurrency,
}: DisplayPreferencesProps) {
  const [language] = useLanguagePref();
  const [currency] = useDisplayCurrencyPref();
  const themeId = readTheme();
  const themeLabel = THEMES.find((t) => t.id === themeId)?.label ?? themeId;

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 14, fontWeight: 600, textAlign: "center" }}
        >
          Display &amp; Preferences
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body" style={{ paddingTop: 8 }}>
        <HubRow
          icon="contrast"
          label="Theme"
          value={themeLabel}
          onClick={onOpenTheme}
        />
        <HubRow
          icon="language"
          label="Language"
          value={LANGUAGE_LABELS[language]}
          onClick={onOpenLanguage}
        />
        <HubRow
          icon="coins"
          label="Display currency"
          value={currency}
          onClick={onOpenCurrency}
        />
      </div>
    </>
  );
}

/** A hub entry row: icon + label on the left, current-value hint + chevron on
 *  the right. Styled as a tappable card, consistent with the Settings cards. */
function HubRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: IconName;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        marginBottom: 8,
        padding: "13px 14px",
        borderRadius: 10,
        border: "1px solid var(--fg-700)",
        background: "rgba(255,255,255,0.03)",
        color: "var(--fg-100)",
        fontFamily: "var(--f-sans)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 12,
        textAlign: "left",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          color: "var(--fg-300)",
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={16} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <span
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            color: "var(--fg-300)",
            fontWeight: 500,
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
        <span
          style={{ color: "var(--fg-400)", display: "inline-flex", flexShrink: 0 }}
        >
          <Icon name="chev" size={12} />
        </span>
      </span>
    </button>
  );
}
