import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// Fit-to-width for a single-line label. Grows the referenced element's
// font-size up to `maxPx`, then steps it down until the text fills the
// available parent width on ONE line without wrapping or clipping.
//
// Why a hook instead of a fixed font-size: a bech32m address is long
// (43 chars for a 20-byte / `mono1…` HRP) and its length varies by HRP, so a
// single magic size either wraps to a second line or leaves a slack gap. This
// renders the address as large as fits — edge-to-edge, always one line.
//
// The element MUST be styled `white-space: nowrap; overflow: hidden` so that
// `scrollWidth` reflects the true (un-clipped) content width while
// `clientWidth` stays pinned to the box the flex/grid layout allotted it.
// Re-runs when `text` changes (account switch) or the container resizes
// (popup ↔ side-panel). In jsdom (tests) layout metrics are 0, so the loop is
// a no-op and the element keeps `maxPx` — harmless.
export function useFitText<T extends HTMLElement>(
  text: string,
  maxPx: number,
  minPx = 9,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      let size = maxPx;
      el.style.fontSize = `${size}px`;
      // scrollWidth > clientWidth ⇒ the line overflows its box ⇒ shrink.
      let guard = 0;
      while (el.scrollWidth > el.clientWidth && size > minPx && guard < 80) {
        size = Math.max(minPx, size - 0.25);
        el.style.fontSize = `${size}px`;
        guard += 1;
      }
    };
    fit();
    const parent = el.parentElement;
    if (typeof ResizeObserver !== "undefined" && parent) {
      const ro = new ResizeObserver(() => fit());
      ro.observe(parent);
      return () => ro.disconnect();
    }
    return undefined;
  }, [text, maxPx, minPx]);
  return ref;
}
