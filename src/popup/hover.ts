// Inline hover handlers for buttons styled with an inline `style` object (no
// class), so they get the same hover response as the wallet's class-based
// buttons. Two idioms, matching the two the CSS already uses:
//   - hoverBg     -> background wash, like `.ext-act:hover` (ext.css)
//   - hoverBright -> filter brightness, like `.ext-act.prim:hover` (ext.css)
// Pair each with a `transition` on the button's style. Spread onto a <button>:
//   <button style={{...neutralStyle, transition: "background 120ms"}}
//           {...hoverBg("rgba(255,255,255,0.04)")} />

import type { MouseEvent as ReactMouseEvent } from "react";

type BtnEvt = ReactMouseEvent<HTMLButtonElement>;

/** Neutral buttons (light border/text on a near-transparent fill): brighten the
 *  background on hover, restoring the exact at-rest fill on leave. */
export function hoverBg(rest: string, over = "rgba(255,255,255,0.09)") {
  return {
    onMouseEnter: (e: BtnEvt) => {
      e.currentTarget.style.background = over;
    },
    onMouseLeave: (e: BtnEvt) => {
      e.currentTarget.style.background = rest;
    },
  };
}

/** Semantically-coloured buttons (gold/green/red border + text + fill):
 *  brighten in place so the colour is preserved rather than washed out. */
export const hoverBright = {
  onMouseEnter: (e: BtnEvt) => {
    e.currentTarget.style.filter = "brightness(1.15)";
  },
  onMouseLeave: (e: BtnEvt) => {
    e.currentTarget.style.filter = "none";
  },
};
