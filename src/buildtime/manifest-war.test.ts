import { describe, expect, it } from "vitest";

import { applyDynamicWarUrl } from "./manifest-war.js";

describe("applyDynamicWarUrl (P6-003)", () => {
  it("flips use_dynamic_url false → true, preserving resources/matches", () => {
    const src = JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [
        {
          matches: ["<all_urls>"],
          resources: ["assets/provider.js", "assets/bridge.js"],
          use_dynamic_url: false,
        },
      ],
    });
    const out = JSON.parse(applyDynamicWarUrl(src)) as {
      web_accessible_resources: Array<{
        use_dynamic_url: boolean;
        resources: string[];
        matches: string[];
      }>;
    };
    expect(out.web_accessible_resources[0]!.use_dynamic_url).toBe(true);
    expect(out.web_accessible_resources[0]!.resources).toEqual([
      "assets/provider.js",
      "assets/bridge.js",
    ]);
    expect(out.web_accessible_resources[0]!.matches).toEqual(["<all_urls>"]);
  });

  it("is idempotent when already true (returns the input unchanged)", () => {
    const src = JSON.stringify({
      web_accessible_resources: [{ resources: ["a.js"], use_dynamic_url: true }],
    });
    expect(applyDynamicWarUrl(src)).toBe(src);
  });

  it("is a no-op when there's no WAR block", () => {
    const src = JSON.stringify({ manifest_version: 3, name: "x" });
    expect(applyDynamicWarUrl(src)).toBe(src);
  });
});
