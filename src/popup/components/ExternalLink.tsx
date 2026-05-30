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

export function ExternalLink({
  href,
  children,
  title,
  iconSize = 11,
  style,
}: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-extlink"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        wordBreak: "break-all",
        ...style,
      }}
    >
      <span style={{ minWidth: 0 }}>{children}</span>
      <Icon name="external" size={iconSize} />
    </a>
  );
}
