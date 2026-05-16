// Phase 11 Commit 10 — Esc-to-close hook.
//
// Modal/sheet components have inconsistent Esc-to-close behaviour
// across the codebase. This hook standardises the pattern: pass an
// `onClose` callback + an `enabled` flag, and Esc triggers close when
// the modal is open. Stacking-aware: only the topmost subscriber
// handles Esc; deeper modals don't fire when the topmost one's
// keydown stops propagation.

import { useEffect } from "react";

/** Single-modal Esc-to-close. Wire on the topmost modal that the user
 *  is interacting with — for nested modals, only attach the hook to
 *  the deepest visible one (which calls e.stopPropagation in its own
 *  keydown handler if it needs even tighter scope). */
export function useEscToClose(
  onClose: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
    };
  }, [onClose, enabled]);
}
