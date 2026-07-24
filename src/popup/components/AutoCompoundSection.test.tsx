import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PendingRewardsView } from "../../shared/staking.js";
import {
  AutoCompoundSection,
  autoCompoundSectionVisible,
} from "./AutoCompoundSection.js";

function rewardsView(partial: Partial<PendingRewardsView>): PendingRewardsView {
  return {
    wallet: "0x" + "11".repeat(20),
    totalAmountLythoshi: "0",
    settledPendingLythoshi: "0",
    unsettledAmountLythoshi: "0",
    autoCompound: false,
    totalAmountWei: "0x0",
    rows: [],
    blockHeight: "100",
    ...partial,
  };
}

const CHAIN = "0x10F2C";

describe("autoCompoundSectionVisible — no-mock gate", () => {
  it("is visible for a LIVE read (real data)", () => {
    expect(autoCompoundSectionVisible(rewardsView({ totalAmountWei: "0x64" }), false)).toBe(true);
    // visible even at zero pending — the preference can be set for future rewards
    expect(autoCompoundSectionVisible(rewardsView({}), false)).toBe(true);
  });
  it("is HIDDEN for a mock/illustrative read (never flip a fabricated flag)", () => {
    expect(autoCompoundSectionVisible(rewardsView({ totalAmountWei: "0x64" }), true)).toBe(false);
  });
  it("is HIDDEN while loading (null read)", () => {
    expect(autoCompoundSectionVisible(null, false)).toBe(false);
  });
});

describe("AutoCompoundSection — the explained Delegate-page section", () => {
  it("renders the heading, explanatory copy, and the enable-claims hint with real data", () => {
    const html = renderToStaticMarkup(
      <AutoCompoundSection
        rewards={rewardsView({ autoCompound: false, totalAmountWei: "0x64" })}
        isMock={false}
        chainId={CHAIN}
      />,
    );
    expect(html).toContain("Auto-compound");
    expect(html).toContain("Automatically claim your delegation rewards and delegate them back");
    // the section copy hints at the enable-claims (the full disclosure is in the modal)
    expect(html).toContain("also claims your current pending rewards now");
    // the toggle is present, reflecting the current OFF flag
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(">Off<");
  });

  it("reflects an ON flag", () => {
    const html = renderToStaticMarkup(
      <AutoCompoundSection
        rewards={rewardsView({ autoCompound: true })}
        isMock={false}
        chainId={CHAIN}
      />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">On<");
  });

  it("renders NOTHING for a mock read (no-mock preserved)", () => {
    const html = renderToStaticMarkup(
      <AutoCompoundSection
        rewards={rewardsView({ totalAmountWei: "0x64" })}
        isMock={true}
        chainId={CHAIN}
      />,
    );
    expect(html).toBe("");
  });

  it("renders NOTHING while loading (null rewards)", () => {
    const html = renderToStaticMarkup(
      <AutoCompoundSection rewards={null} isMock={false} chainId={CHAIN} />,
    );
    expect(html).toBe("");
  });
});
