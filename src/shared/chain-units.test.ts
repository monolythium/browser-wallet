import { describe, expect, it } from "vitest";
import {
  CHAIN_RETURNS_LEGACY_WEI,
  WEI_PER_LYTHOSHI,
  chainAmountToLythoshi,
  legacyChainBalanceHexToLythoshiHex,
  legacyChainFeeSuggestionWeiToLythoshi,
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

  it("legacyChainFeeSuggestionWeiToLythoshi compensates the three fee fields", () => {
    // Real-world Sprintnet shape: base ≈ next-block base wei (small),
    // priority floor = 10^10 wei (constant), maxFee = base + priority.
    const input = {
      maxPriorityFeePerGas: "0x2540be400", // 10^10 wei -> 1 lythoshi
      maxFeePerGas: "0x4a817c800", // 2 * 10^10 wei -> 2 lythoshi
      baseFeePerGas: "0x2540be400", // 10^10 wei -> 1 lythoshi
    };
    const out = legacyChainFeeSuggestionWeiToLythoshi(input);
    expect(out.maxPriorityFeePerGas).toBe("0x1");
    expect(out.maxFeePerGas).toBe("0x2");
    expect(out.baseFeePerGas).toBe("0x1");
  });

  it("legacyChainFeeSuggestionWeiToLythoshi preserves extra fields", () => {
    const input = {
      maxPriorityFeePerGas: "0x2540be400",
      maxFeePerGas: "0x2540be400",
      baseFeePerGas: "0x2540be400",
      gasLimit: "0x7530",
      structuredFee: { kind: "native" } as unknown,
    };
    const out = legacyChainFeeSuggestionWeiToLythoshi(input);
    expect(out.gasLimit).toBe("0x7530");
    expect(out.structuredFee).toEqual({ kind: "native" });
  });

  it("legacyChainFeeSuggestionWeiToLythoshi truncates sub-lythoshi base fee", () => {
    // Test-fixture pattern from service-worker.activity.test.ts: feeHistory
    // base of 0x1 wei is below 1 lythoshi and truncates to 0; the popup
    // sees `baseFeePerGas: 0x0` for display while the SW path keeps wei.
    const out = legacyChainFeeSuggestionWeiToLythoshi({
      maxPriorityFeePerGas: "0x2540be400",
      maxFeePerGas: "0x2540be401",
      baseFeePerGas: "0x1",
    });
    expect(out.baseFeePerGas).toBe("0x0");
    expect(out.maxPriorityFeePerGas).toBe("0x1");
    expect(out.maxFeePerGas).toBe("0x1"); // sub-lythoshi remainder truncated
  });
});
