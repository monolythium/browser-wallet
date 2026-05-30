// Lightweight popup-scoped modal overlay. Used for the 0x reveal-confirm
// flow on Home / Receive / Settings — the inline accordion was visibly
// reflowing Home's Top section under the constrained 380 px popup width.
//
// Rendered via createPortal into document.body. This is required, not
// stylistic: `.ext-top` (Home), `.ext-card` (Receive / Settings), and
// `.req-head .origin` (approval screens) all use `backdrop-filter`,
// which creates a containing block for `position: fixed` descendants
// per the CSS spec. Without the portal, `inset: 0` would resolve to
// the small ancestor's box (≈ a 50 px strip on Home Top) instead of
// the popup viewport, leaving the warning text leaking out the top
// with no visible backdrop or card. The portal escapes those ancestors
// so the backdrop covers the full 380×620 popup.
//
// Backdrop click and Escape both close. Inner card stops propagation
// so clicks inside don't dismiss.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, MouseEvent } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Title color override (e.g. gold for warning modals). */
  titleAccent?: string;
  /** When true, render a top-right "×" close button in the header. Opt-in so
   *  existing modals are visually unchanged. */
  showClose?: boolean;
  children: ReactNode;
}

// Phase 11 Commit 10 — stable id for the modal title so the dialog
// element can reference it via aria-labelledby. Counter increments
// per Modal instance to keep ids unique across multiple open modals.
let modalIdCounter = 0;

export function Modal({ open, onClose, title, titleAccent, showClose, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const stopPropagation = (e: MouseEvent) => e.stopPropagation();

  // Phase 11 Commit 10 — aria-labelledby points at the title so screen
  // readers announce the modal heading on focus. Each instance gets a
  // unique id to support multiple simultaneous modals (rare but legal).
  const titleId = `ext-modal-title-${++modalIdCounter}`;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        onClick={stopPropagation}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        style={{
          width: "100%",
          maxWidth: 340,
          background: "var(--ink-100, #15161a)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 12,
          padding: "14px 14px 12px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          color: "var(--fg-100)",
        }}
      >
        {title != null && !showClose && (
          <div
            id={titleId}
            style={{
              fontWeight: 600,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: titleAccent ?? "var(--fg-100)",
            }}
          >
            {title}
          </div>
        )}
        {showClose && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            {title != null ? (
              <span
                id={titleId}
                style={{
                  fontWeight: 600,
                  fontSize: 12,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  color: titleAccent ?? "var(--fg-100)",
                }}
              >
                {title}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                padding: 0,
                marginLeft: 8,
                background: "transparent",
                border: "none",
                color: "var(--fg-400)",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 18,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
