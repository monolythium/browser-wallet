// Display-preferences accessor (popup-side).
//
// Language + display-currency are display-only and consumed only by popup
// React components. No service-worker behavior depends on them (unlike
// mono.ui.open-mode, which the SW reads on boot to bind the action-icon
// click), so there is no reason to round-trip through an SW handler. These
// helpers read/write chrome.storage.local directly with validate-and-
// fallback, mirroring the load/save shape in OnboardingHintBar.tsx.
//
// NOTE: theme is deliberately NOT handled here — it stays on localStorage via
// theme.ts so it can apply before first paint with no flash.

import {
  STORAGE_KEY_LANGUAGE,
  LANGUAGE_VALUES,
  LANGUAGE_DEFAULT,
  type LanguageCode,
  STORAGE_KEY_DISPLAY_CURRENCY,
  DISPLAY_CURRENCY_DEFAULT,
} from "../shared/constants";
import { isCurrencyCode, type CurrencyCode } from "../shared/iso4217";

function isLanguageCode(v: unknown): v is LanguageCode {
  return (
    typeof v === "string" &&
    (LANGUAGE_VALUES as readonly string[]).includes(v)
  );
}

// ---- language --------------------------------------------------------------

export async function loadLanguage(): Promise<LanguageCode> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_LANGUAGE, (got) => {
      const raw = got?.[STORAGE_KEY_LANGUAGE];
      resolve(isLanguageCode(raw) ? raw : LANGUAGE_DEFAULT);
    });
  });
}

export async function saveLanguage(value: LanguageCode): Promise<void> {
  const safe: LanguageCode = isLanguageCode(value) ? value : LANGUAGE_DEFAULT;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_LANGUAGE]: safe }, () => resolve());
  });
}

// ---- display currency ------------------------------------------------------

export async function loadDisplayCurrency(): Promise<CurrencyCode> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_DISPLAY_CURRENCY, (got) => {
      const raw = got?.[STORAGE_KEY_DISPLAY_CURRENCY];
      resolve(isCurrencyCode(raw) ? raw : DISPLAY_CURRENCY_DEFAULT);
    });
  });
}

export async function saveDisplayCurrency(value: CurrencyCode): Promise<void> {
  const safe: CurrencyCode = isCurrencyCode(value)
    ? value
    : DISPLAY_CURRENCY_DEFAULT;
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [STORAGE_KEY_DISPLAY_CURRENCY]: safe },
      () => resolve(),
    );
  });
}
