import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClusterDirectoryEntry } from "../../shared/staking.js";
import { StakeForm, bindingHeadroomBps, headroomExhausted } from "./StakeForm.js";

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
  totalDelegatedBps: 0,
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

describe("bindingHeadroomBps", () => {
  it("is the full 100% when nothing delegated and the cap is disabled", () => {
    expect(bindingHeadroomBps(null, 0, 0)).toBe(10000);
  });

  it("uses the global 100% ceiling when the cap is disabled", () => {
    // 51% already delegated across all clusters → 49% left.
    expect(bindingHeadroomBps(null, 0, 5100)).toBe(4900);
  });

  it("takes the smaller of per-cluster cap headroom and global headroom", () => {
    // cap 50%, 10% in this cluster → cluster headroom 40%; global total 51% → 49%.
    expect(bindingHeadroomBps(5000, 1000, 5100)).toBe(4000);
    // cap 50%, 40% in this cluster → cluster 10%; global 90% delegated → 10%.
    expect(bindingHeadroomBps(5000, 4000, 9000)).toBe(1000);
  });

  it("never returns negative headroom", () => {
    expect(bindingHeadroomBps(5000, 6000, 0)).toBe(0); // already past the cap
    expect(bindingHeadroomBps(null, 0, 10000)).toBe(0); // fully delegated
  });
});

describe("StakeForm — active/remaining headroom line", () => {
  it("shows delegated vs available across all clusters", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} totalDelegatedBps={5100} amountStr="" />,
    );
    expect(html).toContain("51.00% delegated");
    expect(html).toContain("49.00% available");
  });
});

describe("headroomExhausted", () => {
  it("is true only when no headroom remains", () => {
    expect(headroomExhausted(0)).toBe(true);
    expect(headroomExhausted(-1)).toBe(true);
    expect(headroomExhausted(1)).toBe(false);
    expect(headroomExhausted(10000)).toBe(false);
  });
});

describe("StakeForm — limit-warning prominence (Request 2)", () => {
  it("escalates the headroom line to the prominent warn treatment when fully delegated", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} totalDelegatedBps={10000} amountStr="" />,
    );
    expect(html).toContain("0.00% available");
    expect(html).toContain("ext-warn-prominent"); // headroom line is now prominent
  });

  it("keeps the headroom line quiet (no prominent class) when headroom remains", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} totalDelegatedBps={0} amountStr="" />,
    );
    expect(html).toContain("100.00% available");
    expect(html).not.toContain("ext-warn-prominent"); // no warning showing → quiet
  });

  it("renders limit/clamp warnings with the prominent class", () => {
    const html = renderToStaticMarkup(
      <StakeForm {...baseProps} amountStr="150" />, // >100% → exceedsHundred warning
    );
    expect(html).toContain("Enter a percent between 0.01% and 100%");
    expect(html).toContain("ext-warn-prominent");
  });
});
