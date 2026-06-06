import { describe, expect, it } from "vitest";
import {
  CHAIN_RETURNS_LEGACY_WEI,
  WEI_PER_LYTHOSHI,
  chainAmountToLythoshi,
  legacyChainBalanceHexToLythoshiHex,
  legacyChainFeeSuggestionWeiToLythoshi,
} from "./chain-units.js";
import { formatNativeLythAmount } from "./native-fee-display.js";

describe("chain-units (lythoshi-native wire; dc919df8)", () => {
  it("WEI_PER_LYTHOSHI is 10^10 (the wei-vs-lythoshi unit ratio)", () => {
    expect(WEI_PER_LYTHOSHI).toBe(10_000_000_000n);
  });

  it("legacy mode is OFF: operators run the lythoshi-native binary dc919df8", () => {
    // Flipped to false on 2026-05-29 once operators upgraded past the
    // lythoshi-rescaling commits (a2a9e1fc et al). The chain now reports
    // balance/gas price/fee fields in canonical lythoshi directly, so
    // every helper below is an identity passthrough.
    expect(CHAIN_RETURNS_LEGACY_WEI).toBe(false);
  });

  it("chainAmountToLythoshi is identity (no /10^10 down-scale)", () => {
    // Lythoshi-native: 10^10 lythoshi stays 10^10 lythoshi,
    // NOT divided down to 1 lythoshi as the legacy-wei path would.
    expect(chainAmountToLythoshi(10_000_000_000n)).toBe(10_000_000_000n);
  });

  it("chainAmountToLythoshi passes through small magnitudes unchanged", () => {
    expect(chainAmountToLythoshi(1n)).toBe(1n);
    expect(chainAmountToLythoshi(10_000_000n)).toBe(10_000_000n);
  });

  it("legacyChainBalanceHexToLythoshiHex is identity for the live-balance case", () => {
    // Live evidence: the wallet must NOT touch chain values; the wire is
    // already lythoshi.
    expect(legacyChainBalanceHexToLythoshiHex("0x2540be400")).toBe("0x2540be400");
  });

  it("end-to-end: a 100-LYTH balance passes through and displays as 100 LYTH", () => {
    // Regression guard for the wei-down-scale bug. The chain migrated to
    // 18 decimals (1 lythoshi == 1 wei), so a 100-LYTH balance is now
    // 100 * 10^18 lythoshi. The boundary passes it through unchanged and
    // the display helper renders 100 LYTH. The compensation path stays a
    // no-op identity now that the wire IS the lythoshi domain.
    const oneHundredLyth = 100n * 1_000_000_000_000_000_000n;
    const wireHex = "0x" + oneHundredLyth.toString(16);
    const lythoshi = BigInt(legacyChainBalanceHexToLythoshiHex(wireHex));
    expect(lythoshi).toBe(oneHundredLyth);
    expect(formatNativeLythAmount(lythoshi)).toBe("100 LYTH");
  });

  it("legacyChainBalanceHexToLythoshiHex passes through 0x0", () => {
    expect(legacyChainBalanceHexToLythoshiHex("0x0")).toBe("0x0");
  });

  it("legacyChainBalanceHexToLythoshiHex returns malformed input unchanged (defensive)", () => {
    expect(legacyChainBalanceHexToLythoshiHex("not-a-hex")).toBe("not-a-hex");
    expect(legacyChainBalanceHexToLythoshiHex("0x")).toBe("0x");
  });

  it("legacyChainBalanceHexToLythoshiHex passes magnitudes through unchanged", () => {
    // Lythoshi-native: no truncation, no down-scale. Both values are
    // already lythoshi and round-trip identically.
    expect(
      legacyChainBalanceHexToLythoshiHex("0x" + 9_999_999_999n.toString(16)),
    ).toBe("0x" + 9_999_999_999n.toString(16));
    expect(
      legacyChainBalanceHexToLythoshiHex("0x" + 10_000_000_000n.toString(16)),
    ).toBe("0x" + 10_000_000_000n.toString(16));
  });

  it("legacyChainFeeSuggestionWeiToLythoshi passes the three fee fields through unchanged", () => {
    // Lythoshi-native: fee fields are already canonical lythoshi, so the
    // helper is an identity passthrough — no /10^10 compensation.
    const input = {
      maxPriorityFeePerGas: "0x2540be400",
      maxFeePerGas: "0x4a817c800",
      baseFeePerGas: "0x2540be400",
    };
    const out = legacyChainFeeSuggestionWeiToLythoshi(input);
    expect(out.maxPriorityFeePerGas).toBe("0x2540be400");
    expect(out.maxFeePerGas).toBe("0x4a817c800");
    expect(out.baseFeePerGas).toBe("0x2540be400");
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

  it("legacyChainFeeSuggestionWeiToLythoshi leaves a small base fee unchanged", () => {
    // Lythoshi-native: a base of 0x1 lythoshi is a legitimate small fee
    // and is preserved (NOT truncated to 0x0 as the legacy-wei path did).
    const out = legacyChainFeeSuggestionWeiToLythoshi({
      maxPriorityFeePerGas: "0x2540be400",
      maxFeePerGas: "0x2540be401",
      baseFeePerGas: "0x1",
    });
    expect(out.baseFeePerGas).toBe("0x1");
    expect(out.maxPriorityFeePerGas).toBe("0x2540be400");
    expect(out.maxFeePerGas).toBe("0x2540be401");
  });
});
