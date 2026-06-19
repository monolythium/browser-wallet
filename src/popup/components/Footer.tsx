// Mono Labs branding footer.
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
// Placement superseded. The footer was previously kept as a
// normal-flow flex SIBLING of .ext-body so the .ext flex column pinned it
// to the bottom of the frame (always visible, regardless of scroll). A UI
// review judged that frame-pinned strip too persistent: the footer should
// read as the END of the page, not as chrome. So the footer is now
// rendered as the LAST child INSIDE .ext-body (the home scroll container)
// — it flows after the content and is seen only when the home page is
// scrolled to the bottom. Negative horizontal margins in baseStyle cancel
// .ext-body's 14px side padding so the strip still spans the full body
// width. The home call site (components.tsx) is the only consumer; the
// legacy `sticky` prop remains a no-op.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const MONO_LABS_URL = "https://mono-labs.org/";

/** The wallet's own version, read at runtime from the extension manifest —
 *  the single source of truth (manifest.json, kept in lockstep with
 *  package.json; 0.1.3 at time of writing). Mirrors readWalletVersion() /
 *  getExtensionVersion() in About.tsx + Settings.tsx. Replaces a hardcoded
 *  "v0.0.1" literal that had gone stale. Falls back only when getManifest
 *  is unavailable (non-extension context / tests). */
function readWalletVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "0.0.1";
  }
}

interface FooterProps {
  /** Legacy from the position:fixed era. Now a no-op: the Footer
   *  is always in normal flow — placed as the last child
   *  inside .ext-body, so it scrolls with the home content. Prop retained
   *  so existing call sites don't break; can be removed once all callers
   *  drop it. */
  sticky?: boolean;
}

export function Footer(_props: FooterProps = {}) {
  const walletVersion = readWalletVersion();
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
    // Background + top border live in the `.ext-footer` CSS class (not inline)
    // so they read theme tokens (var(--glass-fill) / var(--glass-stroke)) and
    // can be overridden for the light theme. The strip now tints with the
    // active theme — the themed body background shows through the glass veil —
    // instead of being a fixed dark bar.
    // The footer flows as the LAST element INSIDE the scrollable home body
    // (.ext-body), not as a frame-pinned sibling. Negative horizontal margins
    // cancel .ext-body's 14px side padding so the divider strip still spans the
    // full body width; marginTop gives it breathing room from the last content
    // card. It becomes visible only when the home content is scrolled to the
    // bottom — by design.
    marginTop: 18,
    marginLeft: -14,
    marginRight: -14,
    // flex:none is now a no-op (the footer is a block child of the scroll
    // container, not a flex sibling) but harmless; kept so the intrinsic
    // height stays explicit.
    flex: "none",
  };

  return (
    <footer
      className="ext-footer"
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
      {/* Footer text sits at its token tier, not behind an opacity dim: the
          copyright at --fg-400 and the version one quiet step below at
          --fg-500. Both are theme tokens, so they adapt with the now
          theme-aware strip (light-on-dark in dark themes, dark-on-light in the
          light theme) and stay legible. (The "·" separators stay
          opacity-dimmed — decorative, no contrast requirement.) */}
      <span style={{ color: "var(--fg-400)" }}>© 2026 All rights reserved</span>
      <span style={{ opacity: 0.5 }}>·</span>
      <span style={{ color: "var(--fg-500)", fontFamily: "var(--f-mono)" }}>
        v{walletVersion}
      </span>
    </footer>
  );
}
