// DA-006 — DevBadge carries its own developer-mode gate.
//
// The badge marks a surface as developer-mode-only. Before this it rendered
// unconditionally and relied entirely on being placed inside the caller's gate,
// so a badge dropped on an ungated surface would advertise "DEV" to a user who
// never opted in. Reading the flag itself makes a mis-placed badge render
// nothing.
//
// `useFeature` is stubbed here so both directions can be exercised: this asserts
// DevBadge's OWN decision, which is the thing DA-006 changes. The hook's async
// resolution is its own concern — and it seeds `false` (useFeature.ts, the
// `useState(false)` with the "safer-by-default direction" note), so the first
// paint of a correctly-placed badge is closed too.
//
// No jsdom in this codebase — renderToStaticMarkup only, so nothing here
// observes the post-resolution transition. That is hand-verification.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ enabled: false }));
vi.mock("../hooks/useFeature.js", () => ({
  useFeature: () => flag.enabled,
}));

import { DevBadge } from "./DevBadge";

describe("DevBadge — gates itself", () => {
  it("renders NOTHING when developer mode is off", () => {
    flag.enabled = false;
    expect(renderToStaticMarkup(<DevBadge />)).toBe("");
  });

  it("renders the DEV marker when developer mode is on", () => {
    flag.enabled = true;
    const html = renderToStaticMarkup(<DevBadge />);
    expect(html).toContain("DEV");
    expect(html).toContain("ext-badge-dev");
  });

  it("a badge placed OUTSIDE any gate still shows nothing when dev mode is off", () => {
    // The DA-006 scenario in one assertion: this is the call site a reviewer
    // would miss, and it is now inert rather than misleading.
    flag.enabled = false;
    const html = renderToStaticMarkup(
      <div>
        <span>Ordinary surface</span>
        <DevBadge />
      </div>,
    );
    expect(html).not.toContain("DEV");
    expect(html).not.toContain("ext-badge-dev");
  });
});
