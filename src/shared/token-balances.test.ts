import { describe, expect, it } from "vitest";
import {
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

  it("preserves bare MRC-4626 vault share balance identities", () => {
    const vaultId = `0x${"62".repeat(32)}`;
    expect(
      validateWalletTokenBalanceList([
        {
          tokenId: "indexer-balance-key",
          balance: "99",
          updatedAtBlock: 200,
          mrc: {
            standard: "mrc4626",
            assetId: vaultId,
            tokenId: null,
          },
        },
      ]),
    ).toEqual([
      {
        tokenId: "indexer-balance-key",
        balance: "99",
        updatedAtBlock: 200,
        mrc: {
          standard: "mrc4626",
          assetId: vaultId,
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
