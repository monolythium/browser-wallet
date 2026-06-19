// Display currency — dedicated currency-preference page (reached from the
// Display & Preferences hub). STORED PREFERENCE ONLY: it stores the ISO-4217
// code and renders no fiat value (no price oracle exists yet).

import { Icon } from "../Icon";
import { CurrencyGrid } from "../components/CurrencyGrid";
import { useDisplayCurrencyPref } from "../hooks/useDisplayPrefs";

export interface DisplayCurrencySettingsProps {
  onBack: () => void;
}

export function DisplayCurrencySettings({
  onBack,
}: DisplayCurrencySettingsProps) {
  const [currency, setCurrency] = useDisplayCurrencyPref();

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Display currency
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Display currency</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            Reserved for a future fiat estimate. No value is shown yet — this
            only stores your choice.
          </div>
          <CurrencyGrid selectedCode={currency} onSelect={setCurrency} />
        </div>
      </div>
    </>
  );
}
