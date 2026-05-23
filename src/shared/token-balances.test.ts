import { describe, expect, it } from "vitest";
import {
  collectWalletBridgeRouteDisclosures,
  validateWalletBridgeRouteDisclosureList,
  validateWalletBridgeRouteReadiness,
  validateWalletMrcHoldersResponse,
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

  it("preserves MRC-4626 vault share balances with null holder token ids", () => {
    const vaultId = `0x${"46".repeat(32)}`;
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: vaultId,
          balance: "12345",
          updatedAtBlock: 4626,
          mrc: {
            standard: "mrc4626",
            assetId: vaultId,
            tokenId: null,
          },
          mrcHolders: {
            schemaVersion: 1,
            standard: "mrc4626",
            assetId: vaultId,
            tokenId: null,
            limit: 1,
            holders: [
              {
                rank: 1,
                address: "0x1111111111111111111111111111111111111111",
                balance: "12345",
                updatedAtBlock: 5000,
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        tokenId: vaultId,
        balance: "12345",
        updatedAtBlock: 4626,
        mrc: {
          standard: "mrc4626",
          assetId: vaultId,
        },
        mrcHolders: {
          schemaVersion: 1,
          standard: "mrc4626",
          assetId: vaultId,
          tokenId: null,
          limit: 1,
          holders: [
            {
              rank: 1,
              address: "0x1111111111111111111111111111111111111111",
              balance: "12345",
              updatedAtBlock: 5000,
            },
          ],
        },
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

  it("preserves SDK-shaped bridge route disclosures from token balance rows", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "0xsdkroute",
          balance: "10",
          updatedAtBlock: 77,
          bridgeRouteDisclosures: [
            {
              routeId: "ccip-usdc-eth",
              bridge: "CCIP",
              asset: "USDC",
              sourceChain: "Ethereum",
              destinationChain: "Mono",
              verifier: {
                model: "DON",
                participantCount: 7,
                threshold: 5,
              },
              drainCapAtomic: "100000000000",
              finalityBlocks: 64,
              cooldownSeconds: 86400,
              adminControl: "consensusOnly",
              circuitBreaker: "armed",
              insuranceAtomic: "50000000000",
              lastIncidentDate: null,
            },
            {
              routeId: "paused-usdc-eth",
              bridge: "CCIP",
              asset: "USDC",
              sourceChain: "Ethereum",
              destinationChain: "Mono",
              verifier: {
                model: "DON",
                participantCount: 7,
                threshold: 5,
              },
              drainCapAtomic: "100000000000",
              finalityBlocks: 64,
              cooldownSeconds: 0,
              adminControl: "consensusOnly",
              circuitBreaker: "paused",
              insuranceAtomic: "0",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        tokenId: "0xsdkroute",
        balance: "10",
        updatedAtBlock: 77,
        bridgeRouteDisclosures: [
          {
            routeId: "ccip-usdc-eth",
            bridge: "CCIP",
            asset: "USDC",
            sourceChain: "Ethereum",
            destinationChain: "Mono",
            verifier: {
              model: "DON",
              participantCount: 7,
              threshold: 5,
            },
            drainCapAtomic: "100000000000",
            finalityBlocks: 64,
            cooldownSeconds: 86400,
            adminControl: "consensusOnly",
            circuitBreaker: "armed",
            insuranceAtomic: "50000000000",
            lastIncidentDate: null,
          },
          {
            routeId: "paused-usdc-eth",
            bridge: "CCIP",
            asset: "USDC",
            sourceChain: "Ethereum",
            destinationChain: "Mono",
            verifier: {
              model: "DON",
              participantCount: 7,
              threshold: 5,
            },
            drainCapAtomic: "100000000000",
            finalityBlocks: 64,
            cooldownSeconds: 0,
            adminControl: "consensusOnly",
            circuitBreaker: "paused",
            insuranceAtomic: "0",
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

  it("preserves bounded MRC holder rows on native NFT balances", () => {
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "balance-key",
          balance: "1",
          updatedAtBlock: 99,
          mrc: {
            standard: "mrc721",
            assetId: "0xcollection",
            tokenId: "0xtoken",
          },
          mrcHolders: {
            schemaVersion: 1,
            standard: "mrc721",
            assetId: "0xcollection",
            tokenId: "0xtoken",
            limit: 2,
            holders: [
              {
                rank: 1,
                address: "0x1111111111111111111111111111111111111111",
                balance: "1",
                updatedAtBlock: "123",
              },
              {
                rank: 2,
                address: "0x2222222222222222222222222222222222222222",
                balance: "1",
                updatedAtBlock: 124n,
              },
              {
                rank: 3,
                address: "0x3333333333333333333333333333333333333333",
                balance: "1",
                updatedAtBlock: 125,
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        tokenId: "balance-key",
        balance: "1",
        updatedAtBlock: 99,
        mrc: {
          standard: "mrc721",
          assetId: "0xcollection",
          tokenId: "0xtoken",
        },
        mrcHolders: {
          schemaVersion: 1,
          standard: "mrc721",
          assetId: "0xcollection",
          tokenId: "0xtoken",
          limit: 2,
          holders: [
            {
              rank: 1,
              address: "0x1111111111111111111111111111111111111111",
              balance: "1",
              updatedAtBlock: 123,
            },
            {
              rank: 2,
              address: "0x2222222222222222222222222222222222222222",
              balance: "1",
              updatedAtBlock: 124,
            },
          ],
        },
      },
    ]);
  });
});

describe("MRC holder validators", () => {
  it("rejects unsupported standards and malformed holder rows", () => {
    expect(
      validateWalletMrcHoldersResponse({
        schemaVersion: 1,
        standard: "mrc20",
        assetId: "0xasset",
        tokenId: "0xtoken",
        limit: 2,
        holders: [],
      }),
    ).toBeNull();

    expect(
      validateWalletMrcHoldersResponse({
        schemaVersion: 1,
        standard: "mrc1155",
        assetId: "0xasset",
        tokenId: "0xtoken",
        limit: 2,
        holders: [
          { rank: 0, address: "0x1", balance: "1", updatedAtBlock: 1 },
          { rank: 1, address: "0x2", balance: "2", updatedAtBlock: 2 },
        ],
      }),
    ).toEqual({
      schemaVersion: 1,
      standard: "mrc1155",
      assetId: "0xasset",
      tokenId: "0xtoken",
      limit: 2,
      holders: [
        { rank: 1, address: "0x2", balance: "2", updatedAtBlock: 2 },
      ],
    });
  });

  it("accepts MRC-4626 holder responses without token ids", () => {
    const vaultId = `0x${"46".repeat(32)}`;
    expect(
      validateWalletMrcHoldersResponse({
        schemaVersion: 1,
        standard: "mrc4626",
        assetId: vaultId,
        tokenId: null,
        limit: 1,
        holders: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      standard: "mrc4626",
      assetId: vaultId,
      tokenId: null,
      limit: 1,
      holders: [],
    });

    expect(
      validateWalletMrcHoldersResponse({
        schemaVersion: 1,
        standard: "mrc4626",
        assetId: vaultId,
        limit: 1,
        holders: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      standard: "mrc4626",
      assetId: vaultId,
      tokenId: null,
      limit: 1,
      holders: [],
    });

    expect(
      validateWalletMrcHoldersResponse({
        schemaVersion: 1,
        standard: "mrc4626",
        assetId: vaultId,
        tokenId: "0xnot-a-share-token",
        limit: 1,
        holders: [],
      }),
    ).toBeNull();
  });
});

describe("bridge route disclosure validators", () => {
  it("normalizes catalogue readiness flags and bounded reason lists", () => {
    expect(
      validateWalletBridgeRouteReadiness({
        routeSelectionReady: false,
        quote_ready: false,
        submitReady: false,
        blocked_reasons: ["bridge route selection requires transfer intent"],
        warnings: ["catalogue discovery only"],
      }),
    ).toEqual({
      routeSelectionReady: false,
      quoteReady: false,
      submitReady: false,
      blockedReasons: ["bridge route selection requires transfer intent"],
      warnings: ["catalogue discovery only"],
    });
  });

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
