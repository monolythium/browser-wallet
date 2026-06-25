import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClusterDirectoryEntry } from "../../shared/staking.js";
import {
  RedelegateForm,
  redelegateQuickFillPercent,
} from "./RedelegateForm.js";

const srcCluster: ClusterDirectoryEntry = {
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
  srcCluster,
  srcWeightBps: 1000, // 10% of balance staked at the source
  dstCluster: null,
  dstExistingWeightBps: 0,
  capBps: null,
  onAmountChange: () => {},
  onPickDestination: () => {},
  balanceLythoshi: 100n * 10n ** 18n, // 100 LYTH
  onContinue: () => {},
  onBack: () => {},
} as const;

describe("RedelegateForm — in-form amount preview", () => {
  it("derives the moved amount + source stake from balance × weight", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="5" />,
    );
    // 5% of 100 LYTH = 5 LYTH moved; 10% source weight of 100 LYTH = 10 LYTH staked.
    // Amounts are wrapped in emphasized <strong> spans.
    expect(html).toContain(">5 LYTH</strong>");
    expect(html).toContain(">10 LYTH</strong>");
    expect(html).toContain("delegated to alpha");
  });

  it("omits the preview when the amount is empty/zero", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="" />,
    );
    expect(html).not.toContain("Moving");
  });
});

describe("RedelegateForm — >100% validation", () => {
  it("warns when the percent exceeds 100", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="150" />,
    );
    expect(html).toContain(
      "Enter a percent between 0.01% and 100% of your balance.",
    );
  });

  it("does not warn for a valid percent", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="50" />,
    );
    expect(html).not.toContain("Enter a percent between 0.01% and 100%");
  });
});

describe("RedelegateForm — quick-fill buttons", () => {
  it("renders 25/50/75 quick-fills (not 100 — Max covers that)", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="" />,
    );
    expect(html).toContain(">25%</button>");
    expect(html).toContain(">50%</button>");
    expect(html).toContain(">75%</button>");
    expect(html).not.toContain(">100%</button>");
  });

  it("quick-fills compute a fraction of the SOURCE weight, not % of balance", () => {
    // Source staked = 10.50% (1050 bps). 25% of source = 2.63%; Max = 100% = 10.5%.
    expect(redelegateQuickFillPercent(1050, 25)).toBe("2.63");
    expect(redelegateQuickFillPercent(1050, 50)).toBe("5.25");
    expect(redelegateQuickFillPercent(1050, 75)).toBe("7.88");
    expect(redelegateQuickFillPercent(1050, 100)).toBe("10.5"); // == Max
    expect(redelegateQuickFillPercent(0, 25)).toBe("0");
  });
});

describe("RedelegateForm — per-wallet cap guard (0x0213 pre-flight)", () => {
  const dstCluster: ClusterDirectoryEntry = {
    clusterId: 1,
    name: "beta",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: [],
    active: true,
    entity: null,
  };
  // capBps:null = the v2 case (lyth_getDelegationCap reports the DISABLED
  // aggregate cap → null). srcWeightBps high so `exceedsSource` doesn't mask.
  const capProps = {
    ...baseProps,
    srcWeightBps: 5000,
    dstCluster,
    capBps: null,
  } as const;

  it("flags a destination already at the 50% cap (dst holds 5000 bps)", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...capProps} dstExistingWeightBps={5000} amountStr="5" />,
    );
    expect(html).toContain("already at the");
    expect(html).toContain("pick another destination");
  });

  it("allows a move that stays within the cap (4000 + 500 = 4500 ≤ 5000)", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...capProps} dstExistingWeightBps={4000} amountStr="5" />,
    );
    expect(html).not.toContain("per-wallet cap");
  });

  it("warns 'over the cap' when the move exceeds it (4000 + 1500 = 5500 > 5000)", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...capProps} dstExistingWeightBps={4000} amountStr="15" />,
    );
    expect(html).toContain("per-wallet cap by");
  });

  it("fires even when the aggregate cap is null — the null cap no longer disables the guard", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...capProps} dstExistingWeightBps={5000} amountStr="10" />,
    );
    expect(html).toContain("per-wallet cap");
  });
});
