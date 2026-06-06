import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OperatorDirectory } from "./OperatorDirectory.js";
import { useFeature } from "../hooks/useFeature";

// The "Reported attributes" section + per-operator telemetry are
// developer-mode-gated. Mock useFeature so ONLY DEVELOPER_MODE is on (other
// flags keep their real default-off, so this doesn't mask another flag's
// gating). The OFF-path test flips DEVELOPER_MODE false to assert the gate.
vi.mock("../hooks/useFeature", () => ({
  useFeature: vi.fn((flag: string) => flag === "DEVELOPER_MODE"),
}));

// Each test starts from the scoped default; the OFF-path test overrides it.
beforeEach(() => {
  vi.mocked(useFeature).mockImplementation(
    (flag: string) => flag === "DEVELOPER_MODE",
  );
});

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

  it("hides technical operator detail when developer mode is off", () => {
    vi.mocked(useFeature).mockImplementation(() => false);
    const html = renderToStaticMarkup(
      <OperatorDirectory
        onBack={() => undefined}
        onManageOperators={() => undefined}
      />,
    );

    // The dev-only "Reported attributes" capability-telemetry section is
    // gated away (it renders in the probing state when dev mode is ON — see
    // the test above — so its absence here proves the gate, not just an
    // unpopulated list).
    expect(html).not.toContain("Reported attributes");

    // KEEP shell survives for everyone: the operator list, risk legend,
    // manage-operators entry, and the honest probing state.
    expect(html).toContain("Operators");
    expect(html).toContain("Risk legend");
    expect(html).toContain("Manage operators");
    expect(html).toContain("Probing Monolythium Testnet operators");
  });
});
