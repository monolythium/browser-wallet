// DA-013 — the build assertion behind the popup-op gate.
//
// The service worker admits popup ops only from a sender whose URL starts with
// `getURL("src/popup/")`. That is a real boundary ONLY while no extension HTML
// is web-accessible: a page that can frame an extension document gets a
// sender.url on the extension origin, and a prefix check cannot tell that frame
// apart from the real popup. Today the invariant holds because `src/popup/
// index.html` is the only HTML in the tree — an observation, not a gate.
//
// These tests pin the gate. They run against manifest JSON strings, which is
// what the vite post-bundle plugin actually inspects.

import { describe, expect, it } from "vitest";

import {
  assertPopupOnlyInvariant,
  findEmbeddablePageResources,
} from "./popup-only-invariant";

function manifestWith(resources: string[]): string {
  return JSON.stringify({
    manifest_version: 3,
    web_accessible_resources: [
      { resources, matches: ["<all_urls>"], use_dynamic_url: true },
    ],
  });
}

describe("findEmbeddablePageResources — what breaks the popup-only invariant", () => {
  it("passes the shape crxjs actually emits: content-script bundles only", () => {
    // The real WAR block after a build — provider/bridge chunks, no HTML.
    expect(
      findEmbeddablePageResources(
        manifestWith([
          "assets/provider.ts-loader-abc123.js",
          "assets/bridge.ts-loader-def456.js",
        ]),
      ),
    ).toEqual([]);
  });

  it("passes a manifest with no WAR block at all", () => {
    expect(
      findEmbeddablePageResources(JSON.stringify({ manifest_version: 3 })),
    ).toEqual([]);
  });

  it("flags the popup document itself — the case that would void the gate", () => {
    const found = findEmbeddablePageResources(
      manifestWith(["src/popup/index.html"]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.resource).toBe("src/popup/index.html");
    expect(found[0]!.reason).toContain("src/popup/");
  });

  it("flags ANY html, not only the popup's", () => {
    const found = findEmbeddablePageResources(manifestWith(["onboarding.html"]));
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("HTML");
  });

  it("flags .htm as well as .html", () => {
    expect(findEmbeddablePageResources(manifestWith(["legacy.htm"]))).toHaveLength(
      1,
    );
  });

  it("ignores a query string when classifying — ?surface=sidepanel is still HTML", () => {
    expect(
      findEmbeddablePageResources(
        manifestWith(["src/popup/index.html?surface=sidepanel"]),
      ),
    ).toHaveLength(1);
  });

  it("flags a wildcard that can reach the popup path", () => {
    const found = findEmbeddablePageResources(manifestWith(["src/*"]));
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain("wildcard");
  });

  it("flags a bare * — the maximally permissive entry", () => {
    expect(findEmbeddablePageResources(manifestWith(["*"]))).toHaveLength(1);
  });

  it("flags a wildcard that can reach any html outside the popup", () => {
    expect(findEmbeddablePageResources(manifestWith(["pages/*"]))).toHaveLength(1);
  });

  it("does NOT flag a wildcard confined to js assets", () => {
    expect(
      findEmbeddablePageResources(manifestWith(["assets/*.js"])),
    ).toEqual([]);
  });

  it("reports every offending resource, not just the first", () => {
    expect(
      findEmbeddablePageResources(
        manifestWith(["ok.js", "a.html", "src/popup/index.html"]),
      ),
    ).toHaveLength(2);
  });

  it("reports which WAR entry an offender came from", () => {
    const src = JSON.stringify({
      web_accessible_resources: [
        { resources: ["fine.js"] },
        { resources: ["bad.html"] },
      ],
    });
    expect(findEmbeddablePageResources(src)[0]!.entryIndex).toBe(1);
  });
});

describe("assertPopupOnlyInvariant — fails loudly and specifically", () => {
  it("is a no-op on a clean manifest", () => {
    expect(() =>
      assertPopupOnlyInvariant(manifestWith(["assets/provider.js"])),
    ).not.toThrow();
  });

  it("names the offending resource, not just 'assertion failed'", () => {
    expect(() =>
      assertPopupOnlyInvariant(manifestWith(["src/popup/index.html"])),
    ).toThrow(/src\/popup\/index\.html/);
  });

  it("explains WHY it breaks the gate, so the next person is not guessing", () => {
    let message = "";
    try {
      assertPopupOnlyInvariant(manifestWith(["a.html"]));
    } catch (e) {
      message = (e as Error).message;
    }
    // The message must connect the resource to the actual mechanism it voids.
    expect(message).toContain("sender.url");
    expect(message).toContain("src/popup/");
  });
});
