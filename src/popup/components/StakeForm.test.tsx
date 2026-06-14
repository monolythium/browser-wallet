import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClusterDirectoryEntry } from "../../shared/staking.js";
import { StakeForm } from "./StakeForm.js";

const cluster: ClusterDirectoryEntry = {
  clusterId: 0,
  name: "alpha",
  size: 10,
  threshold: 7,
  health: "healthy",
  regions: [],
  active: true,
  entity: null,
};

const baseProps = {
  cluster,
  onAmountChange: () => {},
  balanceLythoshi: 100n * 10n ** 18n, // 100 LYTH
  existingWeightBps: 0,
  capBps: null,
  onContinue: () => {},
  onBack: () => {},
} as const;

describe("StakeForm — >100% validation", () => {
  it("warns when the percent exceeds 100", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} amountStr="150" />,
    );
    expect(html).toContain(
      "Enter a percent between 0.01% and 100% of your balance.",
    );
  });

  it("does not warn for a valid percent", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} amountStr="50" />,
    );
    expect(html).not.toContain("Enter a percent between 0.01% and 100%");
  });
});

describe("StakeForm — quick-fill buttons", () => {
  it("renders 25/50/75 quick-fills (not 100 — Max covers that)", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} amountStr="" />,
    );
    expect(html).toContain(">25%</button>");
    expect(html).toContain(">50%</button>");
    expect(html).toContain(">75%</button>");
    expect(html).not.toContain(">100%</button>");
  });
});
