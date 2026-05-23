import { describe, expect, it } from "vitest";
import { validateWalletTokenBalanceList } from "./token-balances.js";

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
});
