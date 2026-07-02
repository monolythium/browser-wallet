// CodeQL js/xss-through-dom hardening — AddressLink must only emit a Monoscan
// <a> link when the value decodes as a well-formed bech32m; any unresolved /
// garbage value (the unreachable raw-recipient fallback CodeQL traces) renders
// as inert plain text (a <span>, no href), so user input never reaches the
// href as a navigable link. Node test env (no jsdom): renderToStaticMarkup,
// matching the rest of the popup component tests.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddressLink } from "./Send";

describe("AddressLink — link only a validated bech32m (CodeQL js/xss-through-dom)", () => {
  it("renders a Monoscan <a> link for a valid 0x address (→ canonical bech32m)", () => {
    const html = renderToStaticMarkup(
      <AddressLink addr0x="0x0000000000000000000000000000000000000001" />,
    );
    expect(html).toContain("<a ");
    expect(html).toContain("https://monoscan.xyz/#/wallet/mono1");
  });

  it("renders inert plain text (no <a>, no monoscan href) for a garbage value", () => {
    // Non-0x, non-bech32m → bech32mDisplay passes it through → tryDecodeBech32m
    // returns null → the inert <span> branch. The HTML-metacharacter payload is
    // additionally React-escaped in the span text (no tag injection possible).
    const html = renderToStaticMarkup(
      <AddressLink addr0x={'evil"><script>alert(1)</script>'} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("monoscan.xyz");
    expect(html).not.toContain("<script>"); // React-escaped in the span
  });

  it("renders inert plain text for a bech32m string with a broken checksum", () => {
    const html = renderToStaticMarkup(
      <AddressLink addr0x="mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc47" />,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("monoscan.xyz");
  });
});
