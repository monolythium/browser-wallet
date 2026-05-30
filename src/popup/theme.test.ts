import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEMES,
  applyTheme,
  isThemeId,
  readTheme,
} from "./theme";

// theme.ts reads localStorage and sets document.documentElement's data-theme.
// The default test environment is node, so inject minimal fakes rather than
// pull in jsdom.
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

function fakeDocument() {
  const attrs: Record<string, string> = {};
  return {
    documentElement: {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("document", fakeDocument());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("validates known theme ids", () => {
    expect(isThemeId("neon")).toBe(true);
    expect(isThemeId("monolythium")).toBe(true);
    expect(isThemeId("not-a-theme")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it("defaults to monolythium when nothing valid is stored", () => {
    expect(readTheme()).toBe(DEFAULT_THEME);
    localStorage.setItem(THEME_STORAGE_KEY, "bogus");
    expect(readTheme()).toBe(DEFAULT_THEME);
  });

  it("applies a non-default theme via data-theme and persists it", () => {
    applyTheme("neon");
    expect(document.documentElement.getAttribute("data-theme")).toBe("neon");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("neon");
    expect(readTheme()).toBe("neon");
  });

  it("renders the default theme by removing the attribute (native :root)", () => {
    applyTheme("neon");
    applyTheme(DEFAULT_THEME);
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DEFAULT_THEME);
  });

  it("falls back to the default for an unknown id", () => {
    applyTheme("bogus");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DEFAULT_THEME);
  });

  it("every theme option is well-formed", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME)).toBe(true);
    for (const t of THEMES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(/^#[0-9a-f]{6}$/i.test(t.swatch)).toBe(true);
    }
  });
});
