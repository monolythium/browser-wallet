// Degraded-network banner — render, tint and dismissal guards.
//
// What this file CANNOT see: the tint's actual contrast in any theme, the
// layout shift it causes, and the dismissal ACTUALLY happening (that needs a
// click; renderToStaticMarkup runs no events). What it can pin is which states
// render, which tint class each takes, and which states offer a dismiss control
// at all — including the one that must not.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChainHealthBanner } from "./ChainHealthBanner.js";
import { CHAIN_STATE_COPY, BANNER_STATES } from "../chain-health-copy";
import type { ChainHealthKind } from "../components";

const render = (kind: ChainHealthKind | null) =>
  renderToStaticMarkup(
    <ChainHealthBanner kind={kind} onExplain={() => undefined} />,
  );

/** React escapes apostrophes to `&#x27;` in text nodes, so the raw copy string
 *  never appears literally in the markup. Decode before comparing, rather than
 *  hand-escaping the expectation — the point is that the banner renders the
 *  SOURCE string, and a hand-escaped copy in the test would be a second
 *  transcription that could drift. */
const decoded = (kind: ChainHealthKind | null) =>
  render(kind).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("ChainHealthBanner — which states render", () => {
  it("renders nothing for live", () => {
    expect(render("live")).toBe("");
  });

  // D1: both transient states are replaced within one poll tick and neither
  // pauses anything, so a banner there would fire on every popup open.
  it("renders nothing for the transient states", () => {
    expect(render("loading")).toBe("");
    expect(render("reconnecting")).toBe("");
  });

  it("renders nothing before the first health verdict", () => {
    expect(render(null)).toBe("");
  });

  it("renders for every degraded state, with its short line", () => {
    for (const kind of BANNER_STATES) {
      expect(render(kind), `${kind} should render`).not.toBe("");
      expect(decoded(kind), kind).toContain(CHAIN_STATE_COPY[kind].short!);
    }
  });
});

describe("ChainHealthBanner — tint", () => {
  // Three tints, not eight: the palette shares --err across four states
  // deliberately, so the banner must not imply a distinction it does not make.
  it("uses the warn tint for stalled", () => {
    expect(render("stalled")).toContain("ext-chain-warn");
  });

  it("uses the danger tint for the four --err states", () => {
    for (const kind of ["untrusted", "regenesis", "quarantined", "offline"] as const) {
      expect(render(kind), kind).toContain("ext-chain-danger");
    }
  });
});

describe("ChainHealthBanner — dismissal", () => {
  it("offers a dismiss control on the self-healing states", () => {
    for (const kind of ["stalled", "untrusted", "quarantined", "offline"] as const) {
      expect(render(kind), kind).toContain("aria-label=\"Dismiss");
    }
  });

  // D3: regenesis is sticky — never re-probed, and persisted, so it survives a
  // restart. A warning the user can permanently silence for a condition that
  // cannot clear on its own is the one case dismissal is wrong.
  it("does NOT offer a dismiss control for regenesis", () => {
    expect(render("regenesis")).not.toContain("aria-label=\"Dismiss");
  });
});

describe("ChainHealthBanner — accessibility", () => {
  // Polite, matching IndexerStaleBanner. Assertive would interrupt a screen
  // reader on every LIVE<->STALLED oscillation.
  it("is a polite live region", () => {
    const html = render("offline");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("offers the explain action", () => {
    expect(render("offline")).toContain("What does this mean?");
  });
});
