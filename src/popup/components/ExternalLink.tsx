// Shared "opens externally" link affordance for Monoscan (and other external)
// links on the receipts + the activity-detail popup. Renders the value plus a
// trailing ↗ glyph so the item reads as a link; the `.ext-extlink` class gives
// a subtle on-theme hover (gold + underline), not a loud blue link. Always
// opens in a new tab with `noopener noreferrer`.

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../Icon";

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  title?: string;
  iconSize?: number;
  /** Extra style merged onto the anchor (e.g. monospace for addresses). */
  style?: CSSProperties;
}

/** Only well-known navigable schemes may become a clickable link. Anything
 *  else (javascript:, data:, vbscript:, blob:, …) is rendered inert so an
 *  untrusted href can never turn into a script-scheme navigation
 *  (CodeQL js/xss-through-dom defense-in-depth). */
const SAFE_LINK_SCHEMES = ["https:", "http:", "mailto:"];

function safeHref(href: string): string | undefined {
  try {
    return SAFE_LINK_SCHEMES.includes(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined; // unparseable / relative -> inert
  }
}

export function ExternalLink({
  href,
  children,
  title,
  iconSize = 11,
  style,
}: ExternalLinkProps) {
  const safe = safeHref(href);
  const sharedStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    wordBreak: "break-all",
    ...style,
  };
  const inner = (
    <>
      <span style={{ minWidth: 0 }}>{children}</span>
      <Icon name="external" size={iconSize} />
    </>
  );

  if (safe === undefined) {
    // Disallowed scheme: keep the label + glyph visible but non-navigable.
    return (
      <span className="ext-extlink" title={title} style={sharedStyle}>
        {inner}
      </span>
    );
  }

  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-extlink"
      title={title}
      style={sharedStyle}
    >
      {inner}
    </a>
  );
}
