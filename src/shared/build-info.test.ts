// Unit coverage for the Monoscan tx-URL builder (C5). The wallet links a tx
// to Monoscan only when it knows the canonical hash (its own sent txs); the
// builder itself is a pure string join, pinned here so the route shape can't
// drift from the explorer's hash-routed SPA path.

import { describe, expect, it } from "vitest";
import { MONOSCAN_TX_BASE, monoscanTxUrl } from "./build-info.js";

describe("monoscanTxUrl", () => {
  it("builds the hash-routed Monoscan tx URL", () => {
    const hash =
      "0x36467a4360a4225ea31c348d0583e505a3d2f15b46a6d0a791163d2060e868c3";
    expect(monoscanTxUrl(hash)).toBe(`${MONOSCAN_TX_BASE}${hash}`);
    expect(monoscanTxUrl(hash)).toBe(
      "https://monoscan.xyz/#/tx/0x36467a4360a4225ea31c348d0583e505a3d2f15b46a6d0a791163d2060e868c3",
    );
  });

  it("uses the #/tx/ SPA route base", () => {
    expect(MONOSCAN_TX_BASE).toBe("https://monoscan.xyz/#/tx/");
  });
});
