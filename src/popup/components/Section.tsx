// Collapsible section button, moved verbatim from pages/OperatorDirectory so a
// second page can use it without importing from a sibling page. About already
// did exactly that (`import { Section } from "./OperatorDirectory"`), so this
// move resolves an existing page-to-page import rather than only preventing a
// new one.
//
// Body, props and styles are unchanged; OperatorDirectory re-exports this so
// every existing importer keeps resolving.

import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../Icon";

/** One of the four collapsible buttons. Closed by default; the chevron
 *  swaps right → down when open (same idiom as ClusterPicker). */
export function Section({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  meta?: string | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={sectionBtn(open)}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          {meta !== undefined && (
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
              }}
            >
              {meta}
            </span>
          )}
        </span>
        <Icon name={open ? "chev-d" : "chev"} size={13} />
      </button>
      {open && <div style={{ padding: "10px 12px 2px" }}>{children}</div>}
    </div>
  );
}

const sectionBtn = (open: boolean): CSSProperties => ({
  width: "100%",
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid var(--fg-700)",
  background: open ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
});
