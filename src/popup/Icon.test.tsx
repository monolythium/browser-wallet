import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon, iconForDelegationKind } from "./Icon.js";

describe("iconForDelegationKind — distinct glyph per delegation action (E)", () => {
  it("maps each kind to a distinct icon", () => {
    expect(iconForDelegationKind("delegate")).toBe("stake");
    expect(iconForDelegationKind("undelegate")).toBe("unstake");
    expect(iconForDelegationKind("redelegate")).toBe("swap");
  });
});

describe("Icon — unstake glyph", () => {
  it("renders the unstake path (node + down arrow), distinct from stake", () => {
    const html = renderToStaticMarkup(<Icon name="unstake" size={13} />);
    expect(html).toContain('d="M12 11v7M8 14l4 4 4-4"');
    expect(html).toContain('<circle cx="12" cy="5" r="3">');
    // Not the 5-circle stake cluster.
    expect(html).not.toContain('cx="5" cy="7"');
  });
});
