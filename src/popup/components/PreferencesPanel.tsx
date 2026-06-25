// PreferencesPanel — the collapsible display-preference sections.
//
// Renders Theme / Language / Display-currency as accordion rows: each shows a
// title + the current value, and taps to expand its options. Selecting an
// option applies it and collapses the row again (single-open accordion). Used
// inline on the Welcome screen (includeTheme). The dedicated Settings pages
// reuse the same picker grids (ThemeGrid / LanguageGrid / CurrencyGrid) and
// pref hooks, so the two surfaces can't drift.

import { useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { THEMES, applyTheme, readTheme } from "../theme";
import { ThemeGrid } from "./ThemeGrid";
import { LanguageGrid, LANGUAGE_LABELS } from "./LanguageGrid";
import { CurrencyGrid } from "./CurrencyGrid";
import {
  useLanguagePref,
  useDisplayCurrencyPref,
} from "../hooks/useDisplayPrefs";

export interface PreferencesPanelProps {
  /** Include the theme accordion (first-run); omit on surfaces where Theme has
   *  its own dedicated entry. */
  includeTheme: boolean;
}

type SectionKey = "theme" | "language" | "currency";

export function PreferencesPanel({ includeTheme }: PreferencesPanelProps) {
  // Theme reads synchronously from localStorage (no flash); language + currency
  // hydrate from chrome.storage.local via their hooks.
  const [themeId, setThemeId] = useState<string>(readTheme);
  const [language, setLanguage] = useLanguagePref();
  const [currency, setCurrency] = useDisplayCurrencyPref();
  const [open, setOpen] = useState<SectionKey | null>(null);

  const toggle = (k: SectionKey) =>
    setOpen((cur) => (cur === k ? null : k));

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
          <ThemeGrid
            selectedId={themeId}
            onSelect={(id) => {
              applyTheme(id);
              setThemeId(id);
              setOpen(null);
            }}
          />
        </AccordionItem>
      )}

      <AccordionItem
        title="Language"
        value={LANGUAGE_LABELS[language]}
        open={open === "language"}
        onToggle={() => toggle("language")}
      >
        <LanguageGrid
          selectedId={language}
          onSelect={(v) => {
            setLanguage(v);
            setOpen(null);
          }}
        />
      </AccordionItem>

      <AccordionItem
        title="Display currency"
        value={currency}
        open={open === "currency"}
        onToggle={() => toggle("currency")}
      >
        <CurrencyGrid
          selectedCode={currency}
          onSelect={(v) => {
            setCurrency(v);
            setOpen(null);
          }}
        />
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
