import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClusterDirectoryEntry } from "../../shared/staking.js";
import { RedelegateForm } from "./RedelegateForm.js";

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
    expect(html).toContain("Moving 5 LYTH of 10 LYTH staked in alpha");
  });

  it("omits the preview when the amount is empty/zero", () => {
    const html = renderToStaticMarkup(
      <RedelegateForm {...baseProps} amountStr="" />,
    );
    expect(html).not.toContain("Moving");
  });
});
