// Preferences — the Settings sub-page wrapper around <PreferencesPanel>.
//
// The collapsible Language / Display-currency sections live in
// PreferencesPanel (shared with the Welcome screen). Theme is omitted here —
// it has its own dedicated Settings card. This wrapper only adds the back-bar
// chrome. Display-only; nothing here touches the vault or any amount formatter.

import { Icon } from "../Icon";
import { PreferencesPanel } from "../components/PreferencesPanel";

export interface PreferencesProps {
  onBack: () => void;
}

export function Preferences({ onBack }: PreferencesProps) {
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
        <PreferencesPanel includeTheme={false} />
      </div>
    </>
  );
}
