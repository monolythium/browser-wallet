import { describe, expect, it } from "vitest";
import {
  collectWalletBridgeRouteDisclosures,
  validateWalletBridgeRouteDisclosureList,
  validateWalletTokenBalanceList,
} from "./token-balances.js";

describe("wallet token-balance validators", () => {
  it("preserves optional MRC identity and normalizes null token ids", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "0xopaque",
          balance: "7",
          updatedAtBlock: 12,
          mrc: {
            standard: "mrc1155",
            assetId: "0xcollection",
            tokenId: "0xreal",
          },
        },
        {
          tokenId: "0xmrc20",
          balance: "100",
          updatedAtBlock: 13,
          mrc: {
            standard: "mrc20",
            assetId: "0xasset",
            tokenId: null,
          },
        },
        {
          tokenId: "0xlegacy",
          balance: "1",
          updatedAtBlock: 14,
          mrc: null,
        },
      ]),
    ).toEqual([
      {
        tokenId: "0xopaque",
        balance: "7",
        updatedAtBlock: 12,
        mrc: {
          standard: "mrc1155",
          assetId: "0xcollection",
          tokenId: "0xreal",
        },
      },
      {
        tokenId: "0xmrc20",
        balance: "100",
        updatedAtBlock: 13,
        mrc: {
          standard: "mrc20",
          assetId: "0xasset",
        },
      },
      {
        tokenId: "0xlegacy",
        balance: "1",
        updatedAtBlock: 14,
      },
    ]);
  });

  it("drops malformed rows instead of leaking partial MRC identity", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "0xok",
          balance: "1",
          updatedAtBlock: 1,
        },
        {
          tokenId: "0xbad",
          balance: "2",
          updatedAtBlock: 2,
          mrc: {
            standard: "mrc721",
            tokenId: "0xreal",
          },
        },
        {
          tokenId: "0xbad2",
          balance: 3,
          updatedAtBlock: 3,
        },
      ]),
    ).toEqual([
      {
        tokenId: "0xok",
        balance: "1",
        updatedAtBlock: 1,
      },
    ]);
  });

  it("preserves bounded bridge route disclosure fields without inventing defaults", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "0xbridged",
          balance: "5",
          updatedAtBlock: 42,
          bridgeRouteDisclosure: {
            trustModel: "committee",
            liquidityFloor: "1000000",
            route: {
              source: "ethereum",
              destination: "monolythium",
            },
          },
          bridgeRouteDisclosures: [
            {
              trust: { threshold: "5/7" },
              liquidity: { available: "2000000" },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        tokenId: "0xbridged",
        balance: "5",
        updatedAtBlock: 42,
        bridgeRouteDisclosure: {
          trustModel: "committee",
          liquidityFloor: "1000000",
          route: {
            source: "ethereum",
            destination: "monolythium",
          },
        },
        bridgeRouteDisclosures: [
          {
            trust: { threshold: "5/7" },
            liquidity: { available: "2000000" },
          },
        ],
      },
    ]);
  });

  it("drops malformed bridge disclosure data while keeping the balance row neutral", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "0xok",
          balance: "1",
          updatedAtBlock: 1,
          bridgeRouteDisclosure: {
            liquidityFloor: Number.NaN,
          },
          bridgeRouteDisclosures: [
            {
              trustModel: "committee",
              liquidityFloor: "100",
            },
            {
              trustModel: "too-large",
              routes: Array.from({ length: 21 }, (_, i) => i),
            },
          ],
        },
      ]),
    ).toEqual([
      {
        tokenId: "0xok",
        balance: "1",
        updatedAtBlock: 1,
        bridgeRouteDisclosures: [
          {
            trustModel: "committee",
            liquidityFloor: "100",
          },
        ],
      },
    ]);
  });
});

describe("bridge route disclosure validators", () => {
  it("accepts singular and plural API fields from an enclosing response", () => {
    expect(
      collectWalletBridgeRouteDisclosures({
        bridgeRouteDisclosure: {
          trustModel: "light-client",
          liquidityFloor: "500",
        },
        bridgeRouteDisclosures: [
          {
            trust: { verifier: "zk" },
            floor: { units: "250" },
          },
        ],
      }),
    ).toEqual([
      {
        trustModel: "light-client",
        liquidityFloor: "500",
      },
      {
        trust: { verifier: "zk" },
        floor: { units: "250" },
      },
    ]);
  });

  it("returns an empty list for absent or non-object disclosure fields", () => {
    expect(validateWalletBridgeRouteDisclosureList(undefined)).toEqual([]);
    expect(collectWalletBridgeRouteDisclosures(null)).toEqual([]);
    expect(
      collectWalletBridgeRouteDisclosures({
        bridgeRouteDisclosure: "not-an-object",
        bridgeRouteDisclosures: [null, []],
      }),
    ).toEqual([]);
  });
});
