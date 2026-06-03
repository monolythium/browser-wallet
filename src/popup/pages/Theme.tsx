// Theme page.
//
// The appearance/theme picker, promoted out of the Settings → Security
// card into its own top-level category (Item 2a). Reached from the
// Settings "Theme" category card and from the hamburger menu's "Theme"
// entry; both push onto the screen stack so Back returns to the caller.
//
// Single source for the picker — the Security card no longer renders it,
// so the two surfaces can't drift.

import { useState } from "react";
import { Icon } from "../Icon";
import { THEMES, applyTheme, readTheme } from "../theme";

export interface ThemeProps {
  onBack: () => void;
}

export function Theme({ onBack }: ThemeProps) {
  // Appearance — selected theme id (drives <html data-theme>, persisted in
  // localStorage by applyTheme). "monolythium" renders the native palette.
  const [themeId, setThemeId] = useState<string>(readTheme);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Theme
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Appearance</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Choose the wallet&apos;s colour theme. Your choice is saved per
            browser profile and applies everywhere in the wallet.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
            }}
          >
            {THEMES.map((opt) => {
              const active = opt.id === themeId;
              return (
                <button
                  key={opt.id}
                  onClick={() => {
                    applyTheme(opt.id);
                    setThemeId(opt.id);
                  }}
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
        </div>
      </div>
    </>
  );
}
