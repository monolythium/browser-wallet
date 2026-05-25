import { describe, expect, it } from "vitest";
import {
  CHAIN_RETURNS_LEGACY_WEI,
  WEI_PER_LYTHOSHI,
  chainAmountToLythoshi,
  legacyChainBalanceHexToLythoshiHex,
} from "./chain-units.js";

describe("chain-units (V4-LIVE-0008 wei-on-wire compatibility)", () => {
  it("WEI_PER_LYTHOSHI is 10^10 (the wei-vs-lythoshi unit ratio)", () => {
    expect(WEI_PER_LYTHOSHI).toBe(10_000_000_000n);
  });

  it("legacy mode is on while operators run V4-LIVE-0008 (commit 5aead0f0)", () => {
    expect(CHAIN_RETURNS_LEGACY_WEI).toBe(true);
  });

  it("chainAmountToLythoshi divides by 10^10 (0.1 LYTH wei -> lythoshi)", () => {
    // 0.1 LYTH = 10^17 wei = 10^7 lythoshi.
    expect(chainAmountToLythoshi(100_000_000_000_000_000n)).toBe(10_000_000n);
  });

  it("chainAmountToLythoshi clamps negative input to 0", () => {
    expect(chainAmountToLythoshi(-1n)).toBe(0n);
  });

  it("chainAmountToLythoshi truncates sub-lythoshi remainder", () => {
    // 10^10 - 1 wei is less than 1 lythoshi; truncates to 0.
    expect(chainAmountToLythoshi(9_999_999_999n)).toBe(0n);
    expect(chainAmountToLythoshi(10_000_000_000n)).toBe(1n);
  });

  it("legacyChainBalanceHexToLythoshiHex reproduces the 0.1 LYTH case", () => {
    // The user-reported smoke test: chain returns 0.1 LYTH as 10^17 wei
    // -> wallet must coerce to 10^7 lythoshi before passing to display
    //    (formatLyth divides by 10^8 to render "0.1 LYTH").
    expect(legacyChainBalanceHexToLythoshiHex("0x16345785d8a0000")).toBe(
      "0x" + 10_000_000n.toString(16),
    );
  });

  it("legacyChainBalanceHexToLythoshiHex passes through 0x0", () => {
    expect(legacyChainBalanceHexToLythoshiHex("0x0")).toBe("0x0");
  });

  it("legacyChainBalanceHexToLythoshiHex returns malformed input unchanged (defensive)", () => {
    expect(legacyChainBalanceHexToLythoshiHex("not-a-hex")).toBe("not-a-hex");
    expect(legacyChainBalanceHexToLythoshiHex("0x")).toBe("0x");
  });

  it("legacyChainBalanceHexToLythoshiHex truncates sub-lythoshi remainder", () => {
    // 10^10 - 1 wei truncates to 0 lythoshi.
    expect(
      legacyChainBalanceHexToLythoshiHex("0x" + 9_999_999_999n.toString(16)),
    ).toBe("0x0");
    expect(
      legacyChainBalanceHexToLythoshiHex("0x" + 10_000_000_000n.toString(16)),
    ).toBe("0x1");
  });
});
