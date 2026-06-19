// Preferences — shared display-preferences surface.
//
// Rendered in two modes from one component so the two surfaces can't drift:
//   - First-run onboarding step: <Preferences includeTheme onContinue ... />
//     — theme is included inline (via the lifted <ThemeGrid>) so setup is one
//     combined step, plus a Continue affordance.
//   - Settings sub-page: <Preferences includeTheme={false} onBack ... /> —
//     theme keeps its own dedicated Settings card, so it is omitted here.
//
// These are DISPLAY-ONLY prefs. Language + display-currency persist to
// chrome.storage.local via display-prefs.ts; theme persists to localStorage
// via the unchanged applyTheme. No fiat value is rendered (no oracle exists) —
// the currency picker only stores a choice. The Phase-3 decimal/number-format
// control is intentionally NOT here yet; its slot is marked below.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { applyTheme, readTheme } from "../theme";
import { ThemeGrid } from "../components/ThemeGrid";
import {
  loadLanguage,
  saveLanguage,
  loadDisplayCurrency,
  saveDisplayCurrency,
} from "../display-prefs";
import {
  LANGUAGE_DEFAULT,
  LANGUAGE_VALUES,
  DISPLAY_CURRENCY_DEFAULT,
  type LanguageCode,
} from "../../shared/constants";
import { ISO_4217_CURRENCIES, type CurrencyCode } from "../../shared/iso4217";

export interface PreferencesProps {
  /** Render the theme control inline (first-run) vs omit it (Settings sub-page,
   *  where Theme has its own dedicated card). */
  includeTheme: boolean;
  /** Back affordance in the top bar. Both surfaces pass it. */
  onBack?: () => void;
  /** Forward affordance — rendered only in the first-run step. */
  onContinue?: () => void;
}

// Human label (with an emoji flag — no image assets ship) per language code.
const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  "en-US": "🇺🇸  English (US)",
};

export function Preferences({
  includeTheme,
  onBack,
  onContinue,
}: PreferencesProps) {
  // Theme reads synchronously from localStorage (no flash); language + currency
  // hydrate from chrome.storage.local on mount.
  const [themeId, setThemeId] = useState<string>(readTheme);
  const [language, setLanguage] = useState<LanguageCode>(LANGUAGE_DEFAULT);
  const [currency, setCurrency] = useState<CurrencyCode>(DISPLAY_CURRENCY_DEFAULT);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [lang, cur] = await Promise.all([
        loadLanguage(),
        loadDisplayCurrency(),
      ]);
      if (cancelled) return;
      setLanguage(lang);
      setCurrency(cur);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickLanguage = (next: LanguageCode) => {
    setLanguage(next);
    void saveLanguage(next);
  };
  const pickCurrency = (next: CurrencyCode) => {
    setCurrency(next);
    void saveDisplayCurrency(next);
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Preferences
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        {includeTheme && (
          <PrefSection
            title="Theme"
            description="Choose the wallet's colour theme. Saved per browser profile and applied everywhere."
          >
            <ThemeGrid
              selectedId={themeId}
              onSelect={(id) => {
                applyTheme(id);
                setThemeId(id);
              }}
            />
          </PrefSection>
        )}

        <PrefSection
          title="Language"
          description="Display language. More locales will follow — English (US) for now."
        >
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
          >
            {(LANGUAGE_VALUES as readonly LanguageCode[]).map((code) => (
              <PrefButton
                key={code}
                active={language === code}
                onClick={() => pickLanguage(code)}
              >
                {LANGUAGE_LABELS[code]}
              </PrefButton>
            ))}
          </div>
        </PrefSection>

        <PrefSection
          title="Display currency"
          description="Reserved for a future fiat estimate. No value is shown yet — this only stores your choice."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {ISO_4217_CURRENCIES.map((c) => (
              <PrefButton
                key={c.code}
                active={currency === c.code}
                onClick={() => pickCurrency(c.code)}
              >
                {c.code} — {c.name}
              </PrefButton>
            ))}
          </div>
        </PrefSection>

        {/* PHASE 3 SLOT: a decimal/number-format <PrefSection> drops in here
            without reshaping the component. Intentionally absent in Phase 1. */}

        {onContinue && (
          <div style={{ padding: "4px 14px 18px" }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-300)",
                lineHeight: 1.45,
                marginBottom: 10,
                textAlign: "center",
              }}
            >
              You can change these anytime in Settings.
            </div>
            <button
              className="prim"
              onClick={onContinue}
              style={{
                width: "100%",
                padding: "13px 16px",
                borderRadius: 10,
                border: "1px solid var(--gold)",
                background:
                  "linear-gradient(180deg, var(--gold-hi), var(--gold))",
                color: "var(--ink-000)",
                fontFamily: "var(--f-sans)",
                fontWeight: 600,
                fontSize: "var(--fs-13)",
                cursor: "pointer",
                boxShadow:
                  "0 4px 14px rgba(var(--gold-glow), 0.3), inset 0 1px 0 rgba(255,255,255,0.35)",
              }}
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** One labelled preference card: title + description + control. Mirrors the
 *  ext-card head/description shape used by the Theme and Notifications pages. */
function PrefSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="ext-card">
      <div className="ext-card__head">
        <h3>{title}</h3>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--fg-300)",
          lineHeight: 1.5,
          marginBottom: 10,
        }}
      >
        {description}
      </div>
      {children}
    </div>
  );
}

/** A choosable option button. Reuses the Theme/Notifications active-gold
 *  button styling so the picker reads consistently across the wallet. */
function PrefButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        border: active ? "1px solid var(--gold)" : "1px solid var(--fg-700)",
        background: active ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
        color: active ? "var(--gold)" : "var(--fg-100)",
        fontFamily: "var(--f-sans)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        transition: "all 150ms var(--e-out)",
        textAlign: "left",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
