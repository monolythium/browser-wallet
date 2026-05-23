import { describe, expect, it } from "vitest";
import {
  applyFeeTier,
  bridgeRouteDisclosureHasRequiredFloorData,
  computeNativeFeeLythoshi,
  collectBridgeRouteDisclosuresFromIndexer,
  formatIndexedTokenBalanceRow,
  formatBridgeRouteDisclosureDisplay,
  formatExecutionUnits,
  formatLythoshiAmountHex,
  formatLythoshiPerExecutionUnit,
  lythoshiToLythString,
} from "./components.js";

describe("ReqSendTx native fee helpers", () => {
  it("formats native LYTH values with 8-decimal lythoshi precision", () => {
    expect(formatLythoshiAmountHex("0x5f5e100")).toBe("1");
    expect(formatLythoshiAmountHex("0x1")).toBe("0.00000001");
    expect(formatLythoshiAmountHex("0x00bc614e")).toBe("0.12345678");
    expect(lythoshiToLythString(123_456_789n)).toBe("1.23456789");
  });

  it("keeps execution-unit price as lythoshi, not gwei", () => {
    expect(formatExecutionUnits("0x5208")).toBe("21000");
    expect(formatLythoshiPerExecutionUnit("0x64")).toBe("100");
  });

  it("computes tiered max fee in lythoshi", () => {
    expect(applyFeeTier(100n, "low")).toBe(90n);
    expect(applyFeeTier(100n, "medium")).toBe(100n);
    expect(applyFeeTier(100n, "high")).toBe(130n);

    expect(computeNativeFeeLythoshi("0x5208", "0x64", "medium")).toBe(
      2_100_000n,
    );
    expect(
      lythoshiToLythString(
        computeNativeFeeLythoshi("0x5208", "0x64", "medium") ?? 0n,
      ),
    ).toBe("0.021");
  });

  it("returns null/placeholder for missing malformed fee inputs", () => {
    expect(computeNativeFeeLythoshi(null, "0x64", "medium")).toBeNull();
    expect(computeNativeFeeLythoshi("0x5208", "not-hex", "medium")).toBeNull();
    expect(formatLythoshiAmountHex("not-hex")).toBe("—");
  });
});

describe("indexed token balance display", () => {
  it("keeps legacy indexer rows on the historical token-id label", () => {
    expect(
      formatIndexedTokenBalanceRow({
        tokenId: "0x" + "a".repeat(64),
        balance: "9",
        updatedAtBlock: 1234,
      }),
    ).toEqual({
      title: "0xaaaaaaaaaaaa…aaaaaaaa",
      subtitle: "updated at block 1,234",
      unitsLabel: "raw units",
    });
  });

  it("uses MRC collection and real token ids for NFT-style rows", () => {
    const display = formatIndexedTokenBalanceRow({
      tokenId: "0x" + "f".repeat(64),
      balance: "4",
      updatedAtBlock: 77,
      mrc: {
        standard: "mrc1155",
        assetId: "0x" + "c".repeat(64),
        tokenId: "0x" + "d".repeat(64),
      },
    });

    expect(display.title).toBe("MRC-1155 0xdddddddddddd…dddddddd");
    expect(display.subtitle).toBe(
      "collection 0xcccccccccccc…cccccccc · token 0xdddddddddddd…dddddddd · updated at block 77",
    );
    expect(display.subtitle).not.toContain("0xffffffffffff");
  });

  it("labels MRC-20 rows by asset id", () => {
    expect(
      formatIndexedTokenBalanceRow({
        tokenId: "0x" + "b".repeat(64),
        balance: "100",
        updatedAtBlock: 88,
        mrc: {
          standard: "mrc20",
          assetId: "0x" + "a".repeat(64),
        },
      }),
    ).toEqual({
      title: "MRC-20 0xaaaaaaaaaaaa…aaaaaaaa",
      subtitle: "asset 0xaaaaaaaaaaaa…aaaaaaaa · updated at block 88",
      unitsLabel: "raw units",
    });
  });
});

describe("bridge route disclosure display", () => {
  it("collects top-level and token-level disclosures without defaults", () => {
    expect(
      collectBridgeRouteDisclosuresFromIndexer({
        bridgeRouteDisclosures: [
          {
            trustModel: "committee",
            liquidityFloor: "1000",
          },
        ],
        tokenBalances: [
          {
            tokenId: "0xwrapped",
            balance: "7",
            updatedAtBlock: 12,
            bridgeRouteDisclosure: {
              trust: { threshold: "5/7" },
              liquidity: { available: "900" },
            },
          },
        ],
        addressLabel: null,
        delegationHistory: [],
        addressActivity: [],
        errors: {},
      }),
    ).toEqual([
      {
        trustModel: "committee",
        liquidityFloor: "1000",
      },
      {
        trust: { threshold: "5/7" },
        liquidity: { available: "900" },
      },
    ]);
  });

  it("classifies trust and liquidity fields and treats missing floors as closed", () => {
    const complete = formatBridgeRouteDisclosureDisplay({
      routeLabel: "eth-to-mono",
      trustModel: "light-client",
      liquidityFloor: "1000",
      insurancePool: "500",
    });

    expect(complete.trustRows).toEqual([
      { keyPath: "trustModel", value: "light-client" },
    ]);
    expect(complete.liquidityRows).toEqual([
      { keyPath: "liquidityFloor", value: "1000" },
      { keyPath: "insurancePool", value: "500" },
    ]);
    expect(complete.otherRows).toEqual([
      { keyPath: "routeLabel", value: "eth-to-mono" },
    ]);
    expect(bridgeRouteDisclosureHasRequiredFloorData(complete)).toBe(true);

    const incomplete = formatBridgeRouteDisclosureDisplay({
      trustModel: "committee",
    });
    expect(incomplete.trustRows).toHaveLength(1);
    expect(incomplete.liquidityRows).toHaveLength(0);
    expect(bridgeRouteDisclosureHasRequiredFloorData(incomplete)).toBe(false);

    const missingFloor = formatBridgeRouteDisclosureDisplay({
      trustModel: "committee",
      liquidity: { available: "900" },
    });
    expect(missingFloor.liquidityRows).toEqual([
      { keyPath: "liquidity.available", value: "900" },
    ]);
    expect(bridgeRouteDisclosureHasRequiredFloorData(missingFloor)).toBe(false);
  });
});
