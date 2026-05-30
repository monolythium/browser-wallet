// Popup theme system.
//
// Mirrors the monoscan/website palette set (see `themes.css`, copied from
// monoscan) by toggling a `data-theme` attribute on <html>. The attribute
// drives the `html[data-theme="…"]` overrides in themes.css, which restyle
// the shared design tokens (--ink-*, --fg-*, --gold, …) the whole popup
// reads from.
//
// Persistence is plain localStorage (not chrome.storage) on purpose: the
// popup is a normal page context, localStorage is synchronous, so the theme
// can be applied in main.tsx BEFORE first paint with no flash. chrome.storage
// is async and would flash the default palette on every popup open.
//
// The default, "monolythium", renders the wallet's native :root palette by
// REMOVING the attribute — so the out-of-the-box look never drifts from the
// hand-tuned base tokens, and themes.css only ever layers alternatives on top.

export interface ThemeOption {
  id: string;
  label: string;
  /** Representative colour shown in the picker swatch. */
  swatch: string;
  desc: string;
}

export const THEMES: readonly ThemeOption[] = [
  { id: "monolythium", label: "Monolythium", swatch: "#7c7fff", desc: "Indigo (default)" },
  { id: "default", label: "Amber", swatch: "#e8a942", desc: "Warm amber" },
  { id: "monolabs", label: "Monolabs", swatch: "#34d399", desc: "Teal" },
  { id: "monoplay", label: "Monoplay", swatch: "#ef4444", desc: "Crimson" },
  { id: "glass", label: "Liquid Glass", swatch: "#8b9dff", desc: "Frosted" },
  { id: "aurora", label: "Aurora", swatch: "#d36bff", desc: "Purple nebula" },
  { id: "crimson", label: "Crimson", swatch: "#e6545c", desc: "Burgundy" },
  { id: "neon", label: "Neon", swatch: "#00ffc8", desc: "Terminal" },
  { id: "midnight", label: "Midnight", swatch: "#a78bfa", desc: "Violet" },
  { id: "retro", label: "Retro CRT", swatch: "#ffb84d", desc: "Amber CRT" },
  { id: "mono", label: "Mono", swatch: "#f5f5f5", desc: "Black & white" },
  { id: "light", label: "Light", swatch: "#f7f3ea", desc: "Paper" },
] as const;

export const THEME_STORAGE_KEY = "mono.theme";
export const DEFAULT_THEME = "monolythium";

export function isThemeId(value: string | null): boolean {
  return !!value && THEMES.some((t) => t.id === value);
}

export function readTheme(): string {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(saved)) return saved as string;
  } catch {
    // localStorage can be blocked in hardened browsers; use the default.
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: string): void {
  const valid = isThemeId(id) ? id : DEFAULT_THEME;
  if (valid === DEFAULT_THEME) {
    // Native :root palette — never drift from the base tokens.
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", valid);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, valid);
  } catch {
    // The visual state still applies even if persistence is blocked.
  }
}
