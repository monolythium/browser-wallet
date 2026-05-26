// Round 8 TASK 5 — Mono Labs branding footer.
//
// Displayed at the bottom of the Home screen (and any other surface
// that opts in). Subtle small-text strip with a "Product of Mono
// Labs" link that opens https://mono-labs.org/ in a new Chrome tab,
// a separator dot, and a "© 2026 All rights reserved" copyright.
//
// Uses chrome.tabs.create instead of target="_blank" because extension
// popups treat _blank inconsistently (different behavior under
// chrome.action popup vs side panel vs full-screen tab). Direct API
// call routes through Chrome's tab manager in every surface.
//
// Round 9 TASK 4 — sticky variant. When rendered inside the ext-body
// scroll container with `sticky` prop set, the footer pins to the
// bottom of the visible viewport instead of scrolling away when the
// home content overflows. Background goes from transparent to a
// near-solid surface so content scrolling beneath stays hidden.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const MONO_LABS_URL = "https://mono-labs.org/";

interface FooterProps {
  /** When true, the footer uses position:sticky + bottom:0 + an
   *  opaque bg so it stays glued to the bottom of its scroll-
   *  container parent. Defaults to false (legacy non-sticky
   *  placement for callers that put Footer outside a scroller). */
  sticky?: boolean;
}

export function Footer({ sticky = false }: FooterProps = {}) {
  const openMonoLabs = (e: ReactMouseEvent) => {
    e.preventDefault();
    // chrome.tabs is available in both popup + side panel + extension
    // tab contexts; this is the safest way to open an external URL
    // from any of them without _blank-target inconsistencies.
    void chrome.tabs.create({ url: MONO_LABS_URL });
  };

  const baseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "14px 14px 16px",
    fontSize: 10,
    color: "var(--fg-400)",
    letterSpacing: "0.02em",
    borderTop: "1px solid rgba(255,255,255,0.04)",
    marginTop: "auto",
  };
  const stickyStyle: CSSProperties = sticky
    ? {
        position: "sticky",
        bottom: 0,
        zIndex: 5,
        // Solid-ish surface so scrolled content doesn't bleed
        // through. The wallet's gradient bottom (--ink-050) is the
        // closest visual match; opacity slightly under 1 catches
        // backdrop-filter in light contexts.
        background: "var(--ink-050)",
        // Negative horizontal margins reach to the ext-body padding
        // edges so the border-top spans the full popup width
        // (ext-body has padding: 10px 14px 14px).
        marginLeft: -14,
        marginRight: -14,
        marginBottom: -14,
      }
    : {};

  return (
    <footer
      style={{ ...baseStyle, ...stickyStyle }}
    >
      <a
        href={MONO_LABS_URL}
        onClick={openMonoLabs}
        style={{
          color: "inherit",
          textDecoration: "none",
          cursor: "pointer",
          transition: "color 120ms ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--fg-200)";
          e.currentTarget.style.textDecoration = "underline";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "inherit";
          e.currentTarget.style.textDecoration = "none";
        }}
      >
        Product of Mono Labs
      </a>
      <span style={{ opacity: 0.5 }}>·</span>
      <span style={{ opacity: 0.85 }}>© 2026 All rights reserved</span>
    </footer>
  );
}
