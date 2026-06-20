// Unit coverage for the shared reward-claim capture helper. Mocks the popup
// currency pref + the (null) fiat source so the test is pure; the real
// lythoshi→LYTH converter runs. Pins the no-mock guarantee: a mock/absent
// rewards snapshot yields a null claimedAmount (never a fabricated figure).

import { describe, expect, it, vi } from "vitest";

vi.mock("./display-prefs.js", () => ({
  loadDisplayCurrency: async () => "USD",
}));
vi.mock("../shared/fiat.js", () => ({
  getLythFiatRate: () => null, // no oracle yet
}));

import { buildClaimMeta } from "./claim-meta.js";
import type { PendingRewardsView } from "../shared/staking.js";

function rewards(settledLythoshiDecimal: string): PendingRewardsView {
  return {
    wallet: "0x01029862840d227ee9e76a845c8cbb80ba1d7d23",
    totalAmountLythoshi: settledLythoshiDecimal,
    settledPendingLythoshi: settledLythoshiDecimal,
    unsettledAmountLythoshi: "0",
    autoCompound: false,
    totalAmountWei: "0x0",
    rows: [],
    blockHeight: "1",
  };
}

describe("buildClaimMeta", () => {
  it("converts live settledPendingLythoshi → decimal LYTH; rate null until oracle", async () => {
    // 6.51 LYTH = 6_510_000_000_000_000_000 lythoshi (18 decimals).
    const m = await buildClaimMeta(rewards("6510000000000000000"), false);
    expect(m.claimedAmount).toBe("6.51");
    expect(m.rateAtClaim).toBeNull();
    expect(m.currency).toBe("USD");
  });

  it("no-mock: null claimedAmount when rewards are mock or absent", async () => {
    const mock = await buildClaimMeta(rewards("6510000000000000000"), true);
    expect(mock.claimedAmount).toBeNull();
    const absent = await buildClaimMeta(null, false);
    expect(absent.claimedAmount).toBeNull();
  });
});
