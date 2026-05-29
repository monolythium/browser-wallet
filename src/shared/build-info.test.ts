// Unit coverage for the Monoscan tx-URL builder (C5). The wallet links a tx
// to Monoscan only when it knows the canonical hash (its own sent txs); the
// builder itself is a pure string join, pinned here so the route shape can't
// drift from the explorer's hash-routed SPA path.

import { describe, expect, it } from "vitest";
import {
  MONOSCAN_TX_BASE,
  monoscanTxUrl,
  MONOSCAN_ADDRESS_BASE,
  monoscanAddressUrl,
  SDK_PACKAGE_VERSION,
} from "./build-info.js";

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

describe("monoscanAddressUrl", () => {
  it("builds the hash-routed Monoscan address (wallet) URL from a bech32m address", () => {
    const addr = "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46";
    expect(monoscanAddressUrl(addr)).toBe(`${MONOSCAN_ADDRESS_BASE}${addr}`);
    expect(monoscanAddressUrl(addr)).toBe(
      "https://monoscan.xyz/#/wallet/mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46",
    );
  });

  it("uses the #/wallet/ SPA route base", () => {
    expect(MONOSCAN_ADDRESS_BASE).toBe("https://monoscan.xyz/#/wallet/");
  });
});

describe("SDK_PACKAGE_VERSION (build-time injected, not hardcoded)", () => {
  it("is a real semver string — not the previously-stale 0.3.9 literal", () => {
    expect(SDK_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(SDK_PACKAGE_VERSION).not.toBe("0.3.9");
    expect(SDK_PACKAGE_VERSION).not.toBe("unknown");
  });
});
