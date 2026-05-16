// Phase 11 Commit 9 — EmptyState primitive.
//
// Across Phase 4-10 the wallet accumulated ad-hoc empty-state copy:
// each page invented its own padding, text-align, font size, colour.
// This primitive collapses those variations into one component so the
// visual rhythm of the wallet stays predictable across surfaces.
//
// Variants are deliberately limited — three message-shape options
// cover every observed wallet use case:
//   - { kind: "info" }    — neutral grey copy ("no items yet")
//   - { kind: "warn" }    — amber copy ("chain unreachable, retrying")
//   - { kind: "err" }     — red copy ("operation failed")
//
// Pages still need to write their own copy (the empty-state for the
// activity feed reads very differently from the empty-state for
// delegations) — this just owns the surrounding chrome.

import type { CSSProperties, ReactNode } from "react";

export interface EmptyStateProps {
  kind?: "info" | "warn" | "err";
  /** Primary one-line message. Sentence-cased. */
  title: string;
  /** Optional supporting copy. One short sentence. */
  body?: ReactNode;
  /** Optional CTA — rendered as a button below the body. */
  cta?: {
    label: string;
    onClick: () => void;
  };
  /** When provided, replaces the default padding. */
  paddingY?: number;
}

export function EmptyState({
  kind = "info",
  title,
  body,
  cta,
  paddingY = 28,
}: EmptyStateProps) {
  const colour = colourFor(kind);
  return (
    <div
      style={{
        padding: `${paddingY}px 18px`,
        textAlign: "center",
        fontSize: 12,
        color: colour,
        lineHeight: 1.5,
      }}
      role="status"
    >
      <div style={{ fontWeight: body ? 600 : 400, marginBottom: body ? 6 : 0 }}>
        {title}
      </div>
      {body && (
        <div style={{ fontSize: 11, color: "var(--fg-500)" }}>{body}</div>
      )}
      {cta && (
        <button
          type="button"
          onClick={cta.onClick}
          style={ctaStyle}
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}

function colourFor(kind: "info" | "warn" | "err"): string {
  switch (kind) {
    case "info":
      return "var(--fg-500)";
    case "warn":
      return "var(--warn)";
    case "err":
      return "var(--err)";
  }
}

const ctaStyle: CSSProperties = {
  marginTop: 12,
  padding: "6px 12px",
  fontSize: 11,
  fontFamily: "var(--f-sans)",
  color: "var(--fg-100)",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--fg-700)",
  borderRadius: 6,
  cursor: "pointer",
};
