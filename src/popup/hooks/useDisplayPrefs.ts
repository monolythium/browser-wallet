// React hooks for the display preferences (language + display-currency).
//
// Each loads its value from chrome.storage.local on mount (falling back to the
// default) and persists on change. Shared by the Welcome accordion panel and
// the dedicated Language / Display-currency pages so state + persistence are a
// single source. Theme is not here — it keeps its synchronous localStorage path
// in theme.ts (readTheme / applyTheme) to apply before first paint.

import { useCallback, useEffect, useState } from "react";

import {
  LANGUAGE_DEFAULT,
  DISPLAY_CURRENCY_DEFAULT,
  type LanguageCode,
} from "../../shared/constants";
import { type CurrencyCode } from "../../shared/iso4217";
import {
  loadLanguage,
  saveLanguage,
  loadDisplayCurrency,
  saveDisplayCurrency,
} from "../display-prefs";

export function useLanguagePref(): [LanguageCode, (v: LanguageCode) => void] {
  const [value, setValue] = useState<LanguageCode>(LANGUAGE_DEFAULT);
  useEffect(() => {
    let cancelled = false;
    void loadLanguage().then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const set = useCallback((v: LanguageCode) => {
    setValue(v);
    void saveLanguage(v);
  }, []);
  return [value, set];
}

export function useDisplayCurrencyPref(): [
  CurrencyCode,
  (v: CurrencyCode) => void,
] {
  const [value, setValue] = useState<CurrencyCode>(DISPLAY_CURRENCY_DEFAULT);
  useEffect(() => {
    let cancelled = false;
    void loadDisplayCurrency().then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const set = useCallback((v: CurrencyCode) => {
    setValue(v);
    void saveDisplayCurrency(v);
  }, []);
  return [value, set];
}
