// PreferencesPanel — the collapsible display-preference sections.
//
// Renders Theme / Language / Display-currency as accordion rows: each shows a
// title + the current value, and taps to expand its options. Selecting an
// option applies it and collapses the row again (single-open accordion). Used
// both inline on the Welcome screen (includeTheme) and inside the Settings
// Preferences sub-page (theme omitted — it has its own card there).
//
// Self-contained: language + display-currency persist to chrome.storage.local
// via display-prefs.ts; theme persists to localStorage via the unchanged
// applyTheme. No fiat value is rendered (no oracle) — currency only stores a
// choice. The Phase-3 decimal/number-format row will add here without reshape.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { THEMES, applyTheme, readTheme } from "../theme";
import { ThemeGrid } from "./ThemeGrid";
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

export interface PreferencesPanelProps {
  /** Include the theme accordion (first-run); omit on the Settings sub-page
   *  where Theme has its own dedicated card. */
  includeTheme: boolean;
}

type SectionKey = "theme" | "language" | "currency";

// Human label (with an emoji flag — no image assets ship) per language code.
const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  "en-US": "🇺🇸  English (US)",
};

export function PreferencesPanel({ includeTheme }: PreferencesPanelProps) {
  // Theme reads synchronously from localStorage (no flash); language + currency
  // hydrate from chrome.storage.local on mount.
  const [themeId, setThemeId] = useState<string>(readTheme);
  const [language, setLanguage] = useState<LanguageCode>(LANGUAGE_DEFAULT);
  const [currency, setCurrency] = useState<CurrencyCode>(DISPLAY_CURRENCY_DEFAULT);
  const [open, setOpen] = useState<SectionKey | null>(null);

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

  const toggle = (k: SectionKey) =>
    setOpen((cur) => (cur === k ? null : k));

  const pickTheme = (id: string) => {
    applyTheme(id);
    setThemeId(id);
    setOpen(null);
  };
  const pickLanguage = (next: LanguageCode) => {
    setLanguage(next);
    void saveLanguage(next);
    setOpen(null);
  };
  const pickCurrency = (next: CurrencyCode) => {
    setCurrency(next);
    void saveDisplayCurrency(next);
    setOpen(null);
  };

  const themeLabel = THEMES.find((t) => t.id === themeId)?.label ?? themeId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {includeTheme && (
        <AccordionItem
          title="Theme"
          value={themeLabel}
          open={open === "theme"}
          onToggle={() => toggle("theme")}
        >
          <ThemeGrid selectedId={themeId} onSelect={pickTheme} />
        </AccordionItem>
      )}

      <AccordionItem
        title="Language"
        value={LANGUAGE_LABELS[language]}
        open={open === "language"}
        onToggle={() => toggle("language")}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(LANGUAGE_VALUES as readonly LanguageCode[]).map((code) => (
            <OptionButton
              key={code}
              active={language === code}
              onClick={() => pickLanguage(code)}
            >
              {LANGUAGE_LABELS[code]}
            </OptionButton>
          ))}
        </div>
      </AccordionItem>

      <AccordionItem
        title="Display currency"
        value={currency}
        open={open === "currency"}
        onToggle={() => toggle("currency")}
      >
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
        >
          {ISO_4217_CURRENCIES.map((c) => (
            <OptionButton
              key={c.code}
              active={currency === c.code}
              onClick={() => pickCurrency(c.code)}
            >
              {c.code} — {c.name}
            </OptionButton>
          ))}
        </div>
      </AccordionItem>
    </div>
  );
}

/** One collapsible preference row: a header (title + current value + chevron)
 *  that toggles the option panel below it open/closed. */
function AccordionItem({
  title,
  value,
  open,
  onToggle,
  children,
}: {
  title: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--fg-700)",
        borderRadius: 10,
        background: "rgba(255,255,255,0.03)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 14px",
          border: "none",
          background: "transparent",
          color: "var(--fg-100)",
          fontFamily: "var(--f-sans)",
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <span>{title}</span>
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
            aria-hidden="true"
            style={{
              display: "flex",
              flexShrink: 0,
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 150ms var(--e-out)",
            }}
          >
            <Icon name="chev" size={12} />
          </span>
        </span>
      </button>
      {open && <div style={{ padding: "0 12px 12px" }}>{children}</div>}
    </div>
  );
}

/** A choosable option button — reuses the active-gold styling used across the
 *  wallet's pickers. */
function OptionButton({
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
