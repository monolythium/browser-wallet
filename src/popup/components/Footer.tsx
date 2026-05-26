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
// Round 12 TASK 6 — definitive placement (4th attempt across rounds 8,
// 9, 10, 11, 12). The previous three attempts each tried a different
// CSS positioning strategy:
//   Round 8/9: position:sticky inside .ext-body — broke when home
//     content didn't overflow (sticky's natural-flow position was
//     mid-card and nothing pushed it down).
//   Round 10:  position:fixed bottom:0 outside .ext-body + 32 px
//     spacer at end of body to clear the overlay — overlay style
//     left a visible gap between the last card and the footer
//     because the footer covered the viewport, not the content.
//
// The fundamental insight we kept missing: the parent .ext is already
// a flex column with .ext-body { flex: 1 }. That layout naturally
// puts the LAST child at the bottom of .ext without any positioning
// CSS. The footer just needs to be a normal-flow flex sibling of
// .ext-body. When content is short, .ext-body still fills the
// remaining height (flex:1) and the footer sits at the bottom of
// .ext (= bottom of the popup viewport, sidebar panel, or fullscreen
// card). When content is long, .ext-body scrolls internally and the
// footer stays put at the bottom of .ext (still visible — same
// position as the short-content case).
//
// No position:fixed, no position:sticky, no spacer needed.
// Old `sticky` prop is retained as a no-op so existing call sites
// don't break.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const MONO_LABS_URL = "https://mono-labs.org/";
const WALLET_VERSION = "v0.0.1";

interface FooterProps {
  /** Round 12 TASK 6 — legacy from Round 10's position:fixed era.
   *  Now a no-op: Footer is always in normal flow because the
   *  parent .ext's flex-column layout places the last child at the
   *  bottom automatically. Prop retained so existing call sites
   *  don't break; can be removed once all callers drop it. */
  sticky?: boolean;
}

export function Footer(_props: FooterProps = {}) {
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
    padding: "8px 12px",
    fontSize: 9,
    color: "var(--fg-400)",
    letterSpacing: "0.02em",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    // Solid surface keeps the strip visually distinct from any
    // content the scrollbar reveals just above it; no backdrop-blur
    // needed since we're not overlapping anything any more.
    background: "rgba(10, 10, 20, 0.65)",
    // flex:none so a parent flex:1 sibling (.ext-body) gets all the
    // expansion budget and the footer keeps its intrinsic height.
    flex: "none",
  };

  return (
    <footer
      style={baseStyle}
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
