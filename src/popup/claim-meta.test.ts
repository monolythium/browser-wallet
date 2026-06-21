// Unit coverage for the shared reward-claim capture helper. The claimed AMOUNT
// is no longer captured at submit (the submit-time pending-rewards value is
// wrong — settled-only, pre-execution); it is decoded from the receipt's
// `Claimed` log after confirmation (see shared/claimed-log.ts). buildClaimMeta
// now only freezes the fiat rate + currency. Mocks the popup currency pref + the
// (null) fiat source so the test is pure.

import { describe, expect, it, vi } from "vitest";

vi.mock("./display-prefs.js", () => ({
  loadDisplayCurrency: async () => "USD",
}));
vi.mock("../shared/fiat.js", () => ({
  getLythFiatRate: () => null, // no oracle yet
}));

import { buildClaimMeta } from "./claim-meta.js";

describe("buildClaimMeta", () => {
  it("freezes currency + null rate; claimedAmount is null at submit (decoded from the log later)", async () => {
    const m = await buildClaimMeta();
    // No wrong pre-confirmation figure — the real amount is decoded from the
    // Claimed log once the receipt lands (no-mock).
    expect(m.claimedAmount).toBeNull();
    expect(m.rateAtClaim).toBeNull(); // no oracle yet
    expect(m.currency).toBe("USD");
  });

  it("takes no arguments (the submit-time pending-rewards capture is gone)", () => {
    expect(buildClaimMeta.length).toBe(0);
  });
});
