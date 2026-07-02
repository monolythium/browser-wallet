import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon, iconForDelegationKind } from "./Icon.js";

describe("iconForDelegationKind — distinct glyph per delegation action (E)", () => {
  it("maps each kind to a distinct icon", () => {
    expect(iconForDelegationKind("delegate")).toBe("stake");
    expect(iconForDelegationKind("undelegate")).toBe("unstake");
    expect(iconForDelegationKind("redelegate")).toBe("restake");
  });
});

describe("Icon — reward glyph", () => {
  it("renders the gift-box reward path, distinct from receive", () => {
    const html = renderToStaticMarkup(<Icon name="reward" size={13} />);
    expect(html).toContain('d="M5 12v9h14v-9"');
    expect(html).not.toContain("M12 5v14M5 12l7 7 7-7"); // not the receive ↓ arrow
  });
});

describe("Icon — unstake glyph", () => {
  it("renders the unstake path (cluster satellites + center down arrow)", () => {
    const html = renderToStaticMarkup(<Icon name="unstake" size={13} />);
    expect(html).toContain('d="M12 7v8M9 13l3 3 3-3"');
    expect(html).toContain('cx="5" cy="7"'); // shares delegate's cluster satellites
    expect(html).not.toContain('cx="12" cy="12" r="3"'); // but NOT the stake center node
  });
});

describe("Icon — restake glyph", () => {
  it("renders the restake path (cluster satellites + center ↔ arrow)", () => {
    const html = renderToStaticMarkup(<Icon name="restake" size={13} />);
    expect(html).toContain('d="M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3"'); // center bidirectional arrow
    expect(html).toContain('cx="5" cy="7"'); // shares delegate's cluster satellites
    expect(html).not.toContain('cx="12" cy="12" r="3"'); // but NOT the stake center node
    expect(html).not.toContain("M7 10h14l-4-4M17 14H3l4 4"); // not the generic swap glyph
  });
});
