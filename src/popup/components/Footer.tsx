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
// Round 10 TASK 2 — pinned variant. Round 9 used position:sticky inside
// the ext-body scroll container which rendered the footer huge in the
// middle of the home content when scroll was short (sticky needs an
// overflowing parent to anchor properly). Switched to position:fixed
// so the footer is viewport-pinned regardless of scroll state. The
// footer now lives OUTSIDE ext-body in the Home tree and home content
// gets a bottom spacer so the last card isn't covered by the footer.
// Font + padding reduced so the footer is an unobtrusive strip, not a
// floating card. Backdrop blur gives separation from scrolling content
// without an opaque bar.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const MONO_LABS_URL = "https://mono-labs.org/";
const WALLET_VERSION = "v0.0.1";

interface FooterProps {
  /** When true, the footer pins to the popup viewport bottom via
   *  position:fixed. Defaults to false for legacy callers (none
   *  remain in the wallet — every caller now sets sticky). The prop
   *  name is kept for stability; semantically it's "pinned." */
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
    gap: 6,
    padding: "6px 12px",
    fontSize: 9,
    color: "var(--fg-400)",
    letterSpacing: "0.02em",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    marginTop: "auto",
  };
  const stickyStyle: CSSProperties = sticky
    ? {
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        // Translucent backdrop + blur so scrolled content beneath
        // diffuses behind the footer instead of cleanly disappearing.
        // Reads as a glass strip — visually consistent with the rest
        // of the wallet's chrome (banner, hint bars).
        background: "rgba(10, 10, 20, 0.78)",
        backdropFilter: "blur(8px) saturate(160%)",
        WebkitBackdropFilter: "blur(8px) saturate(160%)",
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
      <span style={{ opacity: 0.5 }}>·</span>
      <span style={{ opacity: 0.7, fontFamily: "var(--f-mono)" }}>
        {WALLET_VERSION}
      </span>
    </footer>
  );
}
