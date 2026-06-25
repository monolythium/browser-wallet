import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PendingRewardsView } from "../../shared/staking.js";
import { RewardCard, pendingRewardsArePositive } from "./RewardCard.js";

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

const baseProps = {
  isMock: false,
  clusters: [],
  onClaim: () => {},
  claimDisabled: false,
} as const;

describe("pendingRewardsArePositive (always-show gate)", () => {
  it("is false for a null read", () => {
    expect(pendingRewardsArePositive(null, false)).toBe(false);
  });
  it("is false for a mock read even when the amount is positive (no-mock)", () => {
    expect(
      pendingRewardsArePositive(rewardsView({ totalAmountWei: "0x64" }), true),
    ).toBe(false);
  });
  it("is false for a live zero read", () => {
    expect(
      pendingRewardsArePositive(rewardsView({ totalAmountWei: "0x0" }), false),
    ).toBe(false);
  });
  it("is true for a live positive read", () => {
    expect(
      pendingRewardsArePositive(rewardsView({ totalAmountWei: "0x64" }), false),
    ).toBe(true);
  });
  it("is false for an unparseable amount", () => {
    expect(
      pendingRewardsArePositive(rewardsView({ totalAmountWei: "nope" }), false),
    ).toBe(false);
  });
});

describe("RewardCard — pending-rewards states", () => {
  it("renders honest absence (not 'Loading…', not mock figures) on a hard ok:false error", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={null}
        error="malformed lyth_pendingRewards response"
      />,
    );
    expect(html).toContain("Pending rewards unavailable.");
    expect(html).not.toContain("Loading");
    // No mock/illustrative fallback on a hard error.
    expect(html).not.toContain("illustrative");
    expect(html).not.toContain("Claim all");
  });

  it("error takes precedence over stale reward data", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0x5f5e100" })}
        error="lyth_pendingRewards failed"
      />,
    );
    expect(html).toContain("Pending rewards unavailable.");
    expect(html).not.toContain("Claim all");
  });

  it("still shows 'Loading…' while genuinely pending (null rewards, no error)", () => {
    const html = renderToStaticMarkup(
      <RewardCard {...baseProps} rewards={null} error={null} />,
    );
    expect(html).toContain("Loading");
    expect(html).not.toContain("unavailable");
  });

  it("renders 'No rewards yet' for the zero-reward valid-data case (ok:true, 0)", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0x0" })}
        error={null}
      />,
    );
    expect(html).toContain("No rewards yet");
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("unavailable");
  });

  it("renders ordinary reward data with a claim CTA", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0xde0b6b3a7640000" })} // 1 LYTH (1e18 lythoshi)
        error={null}
      />,
    );
    expect(html).toContain("Claim all");
    expect(html).toContain("1");
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("unavailable");
    expect(html).not.toContain("No rewards yet");
  });
});

describe("RewardCard — in-flight claim label + pending tooltip", () => {
  // Substring without the apostrophe — renderToStaticMarkup escapes ' -> &#x27;.
  const TIP = "A reward claim is pending confirmation";

  it("claimPending → 'Claiming…' label + the pending tooltip", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0x64" })}
        error={null}
        claimDisabled
        claimPending
      />,
    );
    expect(html).toContain("Claiming…");
    expect(html).toContain(TIP);
    expect(html).not.toContain("Claim all");
  });

  it("disabled for another reason (NOT pending) → normal label, NO tooltip", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0x64" })}
        error={null}
        claimDisabled
        claimPending={false}
      />,
    );
    expect(html).toContain("Claim all");
    expect(html).not.toContain("Claiming…");
    expect(html).not.toContain(TIP);
  });

  it("zero rewards (not pending) → 'No rewards yet', no tooltip, no 'Claiming…'", () => {
    const html = renderToStaticMarkup(
      <RewardCard
        {...baseProps}
        rewards={rewardsView({ totalAmountWei: "0x0" })}
        error={null}
        claimPending={false}
      />,
    );
    expect(html).toContain("No rewards yet");
    expect(html).not.toContain("Claiming…");
    expect(html).not.toContain(TIP);
  });
});
