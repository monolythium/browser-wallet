// Display-prefs accessor coverage: validate-and-fallback on read, round-trip
// on write, and corrupt/unknown values resolving to the default. Stubs
// chrome.storage.local with the same in-memory pattern as
// notifications-os.test.ts so the real load/save helpers run under Node.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadLanguage,
  saveLanguage,
  loadDisplayCurrency,
  saveDisplayCurrency,
} from "./display-prefs";
import {
  STORAGE_KEY_LANGUAGE,
  LANGUAGE_DEFAULT,
  STORAGE_KEY_DISPLAY_CURRENCY,
  DISPLAY_CURRENCY_DEFAULT,
} from "../shared/constants";

type StorageMap = Record<string, unknown>;

function installChromeStub(): StorageMap {
  const storage: StorageMap = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (
          keys: string | string[] | null,
          cb: (res: Record<string, unknown>) => void,
        ) => {
          const arr =
            keys === null
              ? Object.keys(storage)
              : typeof keys === "string"
                ? [keys]
                : keys;
          const out: Record<string, unknown> = {};
          for (const k of arr) {
            if (k in storage) out[k] = storage[k];
          }
          queueMicrotask(() => cb(out));
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(entries)) storage[k] = v;
          queueMicrotask(() => cb());
        },
      },
    },
  };
  return storage;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("display-prefs — language", () => {
  let storage: StorageMap;
  beforeEach(() => {
    storage = installChromeStub();
  });

  it("returns the default when nothing is stored", async () => {
    expect(await loadLanguage()).toBe(LANGUAGE_DEFAULT);
  });

  it("returns the default for a corrupt / unknown stored value", async () => {
    storage[STORAGE_KEY_LANGUAGE] = "fr-FR";
    expect(await loadLanguage()).toBe(LANGUAGE_DEFAULT);
    storage[STORAGE_KEY_LANGUAGE] = 42;
    expect(await loadLanguage()).toBe(LANGUAGE_DEFAULT);
  });

  it("round-trips a valid value", async () => {
    await saveLanguage("en-US");
    expect(storage[STORAGE_KEY_LANGUAGE]).toBe("en-US");
    expect(await loadLanguage()).toBe("en-US");
  });
});

describe("display-prefs — display currency", () => {
  let storage: StorageMap;
  beforeEach(() => {
    storage = installChromeStub();
  });

  it("returns the default when nothing is stored", async () => {
    expect(await loadDisplayCurrency()).toBe(DISPLAY_CURRENCY_DEFAULT);
  });

  it("returns the default for a code outside the curated set", async () => {
    storage[STORAGE_KEY_DISPLAY_CURRENCY] = "XYZ";
    expect(await loadDisplayCurrency()).toBe(DISPLAY_CURRENCY_DEFAULT);
    storage[STORAGE_KEY_DISPLAY_CURRENCY] = { code: "EUR" };
    expect(await loadDisplayCurrency()).toBe(DISPLAY_CURRENCY_DEFAULT);
  });

  it("round-trips valid currency codes (including a 0- and 3-decimal one)", async () => {
    await saveDisplayCurrency("EUR");
    expect(storage[STORAGE_KEY_DISPLAY_CURRENCY]).toBe("EUR");
    expect(await loadDisplayCurrency()).toBe("EUR");

    await saveDisplayCurrency("JPY");
    expect(await loadDisplayCurrency()).toBe("JPY");

    await saveDisplayCurrency("KWD");
    expect(await loadDisplayCurrency()).toBe("KWD");
  });
});
