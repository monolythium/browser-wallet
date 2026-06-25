// Unit coverage for the Monoscan tx-URL builder. The wallet links a tx
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
import { CANONICAL_INNER_TX_HASH } from "./__fixtures__/golden.js";

describe("monoscanTxUrl", () => {
  it("builds the hash-routed Monoscan tx URL", () => {
    const hash =
      CANONICAL_INNER_TX_HASH;
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

  it("encodeURIComponent is a no-op for a valid bech32m (URL-safe charset)", () => {
    const addr = "monoc1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46";
    expect(monoscanAddressUrl(addr)).toBe(`${MONOSCAN_ADDRESS_BASE}${addr}`);
    expect(monoscanAddressUrl(addr)).not.toContain("%");
  });

  it("percent-encodes HTML metacharacters in a malformed value (CodeQL sanitizer)", () => {
    const url = monoscanAddressUrl('"><script>');
    expect(url).not.toContain("<script>");
    expect(url).not.toContain('"');
    expect(url).toContain("%3Cscript%3E");
    expect(url.startsWith(MONOSCAN_ADDRESS_BASE)).toBe(true);
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
