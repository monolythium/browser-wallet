import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OperatorDirectory } from "./OperatorDirectory.js";

describe("OperatorDirectory", () => {
  // renderToStaticMarkup does not run effects, so bgOperatorsHealth() is not
  // invoked — the page renders its initial (probing) state. This guards the
  // page shell + the four collapsed section/nav buttons against render crashes.
  it("opens on the four operator buttons in the probing state", () => {
    const html = renderToStaticMarkup(
      <OperatorDirectory
        onBack={() => undefined}
        onManageOperators={() => undefined}
      />,
    );

    // Header + the four buttons the page opens with.
    expect(html).toContain("Operators");
    expect(html).toContain("Reported attributes");
    expect(html).toContain("Risk legend");
    expect(html).toContain("Manage operators");

    // Honest loading state before the probe resolves.
    expect(html).toContain("Probing Monolythium Testnet operators");

    // Sections are collapsed by default (single-open accordion, none open).
    expect(html).toContain('aria-expanded="false"');
  });
});
