// CodeQL js/xss-through-dom hardening — ExternalLink must only emit a navigable
// anchor for allowlisted schemes (https/http/mailto). Any other scheme, or an
// unparseable/relative href, renders inert (a <span>, no href) so an untrusted
// URL can never become a clickable script-scheme navigation.
//
// Node test env (no jsdom): components render to a string via renderToStaticMarkup,
// matching the rest of the popup component tests.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExternalLink } from "./ExternalLink";

describe("ExternalLink scheme allowlist (CodeQL js/xss-through-dom)", () => {
  it("renders a navigable anchor for an https: href (incl. hash-routed monoscan)", () => {
    const html = renderToStaticMarkup(
      <ExternalLink href="https://monoscan.xyz/#/tx/0xabc" title="tx">
        view tx
      </ExternalLink>,
    );
    expect(html).toContain("<a ");
    expect(html).toContain('href="https://monoscan.xyz/#/tx/0xabc"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("view tx");
  });

  it("renders inert (span, no href / no anchor) for a javascript: href", () => {
    const html = renderToStaticMarkup(
      <ExternalLink href="javascript:alert(1)">label</ExternalLink>,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span");
    // the label + trailing glyph stay visible in the inert branch
    expect(html).toContain("label");
    expect(html.toLowerCase()).toContain("<svg");
  });

  it("renders inert for data:, vbscript:, and unparseable/relative hrefs", () => {
    for (const bad of [
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "/relative/path",
      "not a url",
    ]) {
      const html = renderToStaticMarkup(<ExternalLink href={bad}>x</ExternalLink>);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href=");
    }
  });

  it("allows mailto: and http: schemes", () => {
    for (const ok of ["mailto:hi@monolythium.com", "http://example.test/"]) {
      const html = renderToStaticMarkup(<ExternalLink href={ok}>x</ExternalLink>);
      expect(html).toContain("<a ");
      expect(html).toContain(`href="${ok}"`);
    }
  });
});
