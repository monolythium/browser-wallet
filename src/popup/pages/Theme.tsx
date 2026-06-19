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
import { applyTheme, readTheme } from "../theme";
import { ThemeGrid } from "../components/ThemeGrid";

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
          <ThemeGrid
            selectedId={themeId}
            onSelect={(id) => {
              applyTheme(id);
              setThemeId(id);
            }}
          />
        </div>
      </div>
    </>
  );
}
