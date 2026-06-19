// ThemeGrid — the presentational swatch-button grid for the theme picker.
//
// Lifted verbatim out of the Theme page so the Theme sub-page AND the
// onboarding/Settings Preferences surface render the SAME grid and cannot
// drift. It owns no state and never persists: the caller passes the selected
// id and an onSelect callback (which is where applyTheme + local setState
// live), so the single persistence + DOM-apply path stays in theme.ts.

import { THEMES } from "../theme";

export interface ThemeGridProps {
  /** Currently selected theme id; drives the gold active styling. */
  selectedId: string;
  /** Called with the chosen theme id. The caller persists (applyTheme) and
   *  re-renders. */
  onSelect: (id: string) => void;
}

export function ThemeGrid({ selectedId, onSelect }: ThemeGridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 6,
      }}
    >
      {THEMES.map((opt) => {
        const active = opt.id === selectedId;
        return (
          <button
            key={opt.id}
            onClick={() => onSelect(opt.id)}
            title={opt.desc}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 8,
              border: active
                ? "1px solid var(--gold)"
                : "1px solid var(--fg-700)",
              background: active
                ? "var(--gold-bg)"
                : "rgba(255,255,255,0.04)",
              color: active ? "var(--gold)" : "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              transition: "all 150ms var(--e-out)",
              textAlign: "left",
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: opt.swatch,
                flexShrink: 0,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.15)",
              }}
            />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
