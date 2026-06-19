// Preferences — page/step wrapper around <PreferencesPanel>.
//
// The collapsible Theme / Language / Display-currency sections live in
// PreferencesPanel so every surface renders the same control. This wrapper
// adds the page chrome: a back bar, and (in the first-run step) a Continue
// affordance. Display-only; nothing here touches the vault or any amount
// formatter.

import { Icon } from "../Icon";
import { PreferencesPanel } from "../components/PreferencesPanel";

export interface PreferencesProps {
  /** Include the theme section inline (first-run) vs omit it (Settings
   *  sub-page, where Theme has its own dedicated card). */
  includeTheme: boolean;
  /** Back affordance in the top bar. */
  onBack?: () => void;
  /** Forward affordance — rendered only in the first-run step. */
  onContinue?: () => void;
}

export function Preferences({
  includeTheme,
  onBack,
  onContinue,
}: PreferencesProps) {
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
        <PreferencesPanel includeTheme={includeTheme} />

        {onContinue && (
          <div style={{ paddingTop: 14 }}>
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
