import { describe, expect, it } from "vitest";
import {
  computeEstimatedNftFeeLythoshi,
  lythoshiToLythString,
} from "./SendNft.js";

describe("SendNft native fee display math", () => {
  const fee = {
    maxPriorityFeePerGas: "0x5",
    maxFeePerGas: "0x8",
    baseFeePerGas: "0x3",
    gasLimit: null,
  };

  it("computes the NFT estimate in lythoshi from compatibility fee fields", () => {
    expect(computeEstimatedNftFeeLythoshi(fee)).toBe(2_000_000n);
  });

  it("formats native LYTH fee display with 8-decimal lythoshi precision", () => {
    expect(lythoshiToLythString(1n)).toBe("0.00000001");
    expect(lythoshiToLythString(2_000_000n)).toBe("0.02");
    expect(lythoshiToLythString(123_456_789n)).toBe("1.23456789");
    expect(lythoshiToLythString(100_000_000n)).toBe("1");
  });

  it("renders the default quote as a LYTH amount without legacy fee-unit wording", () => {
    const estimated = computeEstimatedNftFeeLythoshi(fee);
    const text = `${lythoshiToLythString(estimated ?? 0n)} LYTH`;

    expect(text).toBe("0.02 LYTH");
    expect(text).not.toMatch(/gwei|gas|wei|lythoshi/i);
  });

  it("returns null when the fee suggestion cannot be parsed", () => {
    expect(
      computeEstimatedNftFeeLythoshi({
        ...fee,
        maxFeePerGas: "not-a-hex-quantity",
      }),
    ).toBeNull();
  });
});
