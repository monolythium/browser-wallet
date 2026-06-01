// LoadingState primitive.
//
// Lightweight one-line loading state. Existing surfaces use bespoke
// "Loading…" copy in inconsistent styles; this primitive standardises
// the look (centred small grey copy with a pulse animation).
//
// Does NOT replace skeleton rows where rich placeholders are useful
// (ActivityList's three-row skeleton is more informative than this
// would be — keep it). For single-line loading cases this is enough.

import type { CSSProperties, ReactNode } from "react";

export interface LoadingStateProps {
  /** Optional label override. Defaults to "Loading…". */
  label?: ReactNode;
  /** Optional padding override. */
  paddingY?: number;
}

export function LoadingState({ label = "Loading…", paddingY = 18 }: LoadingStateProps) {
  return (
    <div
      style={{
        padding: `${paddingY}px 18px`,
        textAlign: "center",
        fontSize: 11,
        color: "var(--fg-400)",
        lineHeight: 1.5,
        opacity: 0.7,
      }}
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  );
}

/** Compact spinner — three pulsing dots. Used inline where space is
 *  tight (next to an existing label). */
export function InlineSpinner({ size = 14 }: { size?: number }) {
  const dot: CSSProperties = {
    display: "inline-block",
    width: Math.round(size / 4),
    height: Math.round(size / 4),
    borderRadius: "50%",
    background: "var(--fg-400)",
    marginRight: 3,
    animation: "ext-spinner-pulse 1.2s infinite ease-in-out",
  };
  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <span style={{ ...dot, animationDelay: "-0.32s" }} />
      <span style={{ ...dot, animationDelay: "-0.16s" }} />
      <span style={{ ...dot, marginRight: 0 }} />
    </span>
  );
}
