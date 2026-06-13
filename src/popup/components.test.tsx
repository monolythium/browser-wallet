import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NATIVE_AGENT_MODULE_ADDRESS,
  PRECOMPILE_ADDRESSES,
  addressToTypedBech32,
  encodeNativeAgentCreateEscrowCall,
  encodeNativeAgentRecordReputationCall,
  encodeNativeAgentSetSpendingPolicyCall,
} from "@monolythium/core-sdk";
import {
  applyFeeTier,
  AssetList,
  chainHealthForFailedPoll,
  chainHealthPresentation,
  reconnectingBannerLabel,
  seedReconnectingHealth,
  shouldLabelBalanceStale,
  shouldPauseBalanceDisplay,
  pausedBalanceMonoscanUrl,
  Bridge,
  bridgeRouteDisclosureHasRequiredFloorData,
  computeNativeFeeLythoshi,
  collectBridgeRouteDisclosuresFromIndexer,
  decodeCalldata,
  formatMrcAccountRecordLine,
  formatMrcPolicyLine,
  formatIndexedTokenBalanceRow,
  formatBridgeRouteDisclosureDisplay,
  formatMrcHolderDisplayLine,
  formatMrcHolderSummaryTitle,
  formatMrcPolicySpendLine,
  formatExecutionUnits,
  formatLythoshiAmountHex,
  formatLythoshiPerExecutionUnit,
  hasNativeAgentStateSummary,
  hasMrcAccountSummary,
  lythoshiToLythString,
  MrcAccountSummary,
  NativeAgentStateSummary,
  ReqSendTx,
} from "./components.js";
import type {
  ChainEntry,
  WalletBridgeRouteDisclosure,
  WalletIndexerSnapshot,
} from "./bg.js";
import type { Account } from "./demo-data.js";

const NATIVE_MARKET_MODULE_ADDRESS = addressToTypedBech32(
  "systemModule",
  "0x4d41524b45545f4e41544956455f4d4f445f5631",
);

function sdkBridgeRoute(
  routeId: string,
  overrides: Partial<WalletBridgeRouteDisclosure> = {},
): WalletBridgeRouteDisclosure {
  return {
    routeId,
    bridge: "Chainlink CCIP",
    protocol: "chainlink-ccip",
    asset: "USDC",
    feeToken: "LINK",
    sourceChain: "Ethereum",
    destinationChain: "Mono",
    verifier: {
      model: "CCIP DON",
      participantCount: 7,
      threshold: 5,
    },
    drainCapAtomic: "100000000000",
    finalityBlocks: 64,
    cooldownSeconds: 86_400,
    adminControl: "consensusOnly",
    circuitBreaker: "armed",
    insuranceAtomic: "50000000000",
    lastIncidentDate: null,
    ...overrides,
  };
}

describe("ReqSendTx native fee helpers", () => {
  it("formats native LYTH values with 18-decimal lythoshi precision", () => {
    // Chain migrated 8 → 18 decimals: 1 LYTH = 10^18 lythoshi (1 lythoshi == 1 wei).
    expect(formatLythoshiAmountHex("0xde0b6b3a7640000")).toBe("1");
    expect(formatLythoshiAmountHex("0x1")).toBe("0.000000000000000001");
    expect(formatLythoshiAmountHex("0x1b69b498d037800")).toBe("0.12345678");
    expect(lythoshiToLythString(1_234_567_890_000_000_000n)).toBe("1.23456789");
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
    ).toBe("0.0000000000021");
  });

  it("returns null/placeholder for missing malformed fee inputs", () => {
    expect(computeNativeFeeLythoshi(null, "0x64", "medium")).toBeNull();
    expect(computeNativeFeeLythoshi("0x5208", "not-hex", "medium")).toBeNull();
    expect(formatLythoshiAmountHex("not-hex")).toBe("—");
  });

  it("renders the default approval fee as one LYTH amount", () => {
    const chain = {
      chainId: "0x10f2c",
      name: "Monolythium Testnet",
      rpc: "http://localhost:8545",
      chainIdNum: 69420,
      builtin: true,
      active: true,
    } satisfies ChainEntry;
    const html = renderToStaticMarkup(
      <ReqSendTx
        request={{
          kind: "send_tx",
          origin: "https://dapp.example",
          tx: {
            to: "0x2222222222222222222222222222222222222222",
            value: "0x0",
          },
          view: {
            executionUnitLimitHex: "0x5208",
            pricePerExecutionUnitLythoshiHex: "0x64",
            nonce: "0x1",
            simulation: null,
            chainId: "0x10f2c",
            chainLabel: "Monolythium Testnet",
          },
        }}
        custody="sw"
        signerAddress="0x1111111111111111111111111111111111111111"
        onApprove={() => undefined}
        onReject={() => undefined}
        chain={chain}
      />,
    );

    expect(html).toContain("Network fee");
    expect(html).toContain("0.0000000000021 LYTH");
    expect(html).not.toContain("Execution-unit limit");
    expect(html).not.toContain("Price / execution unit");
    expect(html).not.toContain("lythoshi");
  });
});

describe("ReqSendTx native market calldata decode", () => {
  it("decodes native bincode spot limit order approvals only for the market system module", () => {
    const marketId = "11".repeat(32);
    const owner = "22".repeat(20);
    const payload =
      "0x000000000100000011111111111111111111111111111111111111111111111111111111111111110000000022222222222222222222222222222222222222220700000000000000000000007d00000000000000000000000000000032000000000000000000000000000000e703000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeSpotPlaceLimitOrder");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["market id", `0x${marketId}`],
      ["owner", addressToTypedBech32("user", `0x${owner}`)],
      ["nonce", "7"],
      ["side", "bid"],
      ["price", "125"],
      ["quantity", "50"],
      ["expires at block", "999"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode spot cancel order approvals only for the market system module", () => {
    const orderId = "33".repeat(32);
    const caller = "44".repeat(20);
    const payload =
      "0x00000000040000003333333333333333333333333333333333333333333333333333333333333333000000004444444444444444444444444444444444444444";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeSpotCancelOrder");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["order id", `0x${orderId}`],
      ["caller", addressToTypedBech32("user", `0x${caller}`)],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT create listing approvals only for the market system module", () => {
    const seller = "11".repeat(20);
    const collectionId = "22".repeat(32);
    const tokenId = "33".repeat(32);
    const paymentAsset = "44".repeat(32);
    const payload =
      "0x010000000000000000000000" +
      seller +
      "0700000000000000" +
      "00000000" +
      collectionId +
      tokenId +
      "01000000000000000000000000000000" +
      paymentAsset +
      "7b000000000000000000000000000000" +
      "00000000" +
      "e703000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftCreateListing");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["seller", addressToTypedBech32("user", `0x${seller}`)],
      ["nonce", "7"],
      ["standard", "mrc721"],
      ["collection id", `0x${collectionId}`],
      ["token id", `0x${tokenId}`],
      ["quantity", "1"],
      ["payment asset", `0x${paymentAsset}`],
      ["price", "123"],
      ["listing kind", "fixed-price"],
      ["expires at block", "999"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT buy listing approvals only for the market system module", () => {
    const listingId = "55".repeat(32);
    const buyer = "66".repeat(20);
    const payload =
      "0x010000000100000055555555555555555555555555555555555555555555555555555555555555550000000066666666666666666666666666666666666666660903000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftBuyListing");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["listing id", `0x${listingId}`],
      ["buyer", addressToTypedBech32("user", `0x${buyer}`)],
      ["current block", "777"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT cancel listing approvals only for the market system module", () => {
    const listingId = "55".repeat(32);
    const caller = "66".repeat(20);
    const payload =
      "0x01000000020000005555555555555555555555555555555555555555555555555555555555555555000000006666666666666666666666666666666666666666";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftCancelListing");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["listing id", `0x${listingId}`],
      ["caller", addressToTypedBech32("user", `0x${caller}`)],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT sweep approvals only for the market system module", () => {
    const first = "77".repeat(32);
    const second = "88".repeat(32);
    const payload =
      "0x01000000030000000200000000000000" +
      first +
      second +
      "0903000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftSweepExpiredListings");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["listing ids", `0x${first}, 0x${second}`],
      ["current block", "777"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT auction bid approvals only for the market system module", () => {
    const listingId = "55".repeat(32);
    const bidder = "66".repeat(20);
    const payload =
      "0x0100000005000000" +
      listingId +
      "00000000" +
      bidder +
      "7b000000000000000000000000000000" +
      "0903000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftPlaceAuctionBid");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["listing id", `0x${listingId}`],
      ["bidder", addressToTypedBech32("user", `0x${bidder}`)],
      ["amount", "123"],
      ["current block", "777"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native bincode NFT settle auction approvals only for the market system module", () => {
    const listingId = "55".repeat(32);
    const payload =
      "0x0100000006000000" +
      listingId +
      "0903000000000000";

    const decoded = decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("nativeNftSettleAuction");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["listing id", `0x${listingId}`],
      ["current block", "777"],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes CLOB placeLimitOrder approvals only for the CLOB precompile", () => {
    const base = "11".repeat(32);
    const quote = "22".repeat(32);
    const calldata =
      "0x2468786f" +
      base +
      quote +
      word(1n) +
      word(125n) +
      word(50n) +
      word(999n);

    const decoded = decodeCalldata(calldata, PRECOMPILE_ADDRESSES.CLOB);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("placeLimitOrder");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["base asset", `0x${base}`],
      ["quote asset", `0x${quote}`],
      ["side", "sell"],
      ["price", "125"],
      ["quantity", "50"],
      ["expires at block", "999"],
    ]);
    expect(decodeCalldata(calldata, PRECOMPILE_ADDRESSES.BRIDGE)).toBeNull();
  });

  it("decodes CLOB placeMarketOrder approvals only for the CLOB precompile", () => {
    const base = "33".repeat(32);
    const quote = "44".repeat(32);
    const calldata =
      "0xb9b1fa86" +
      base +
      quote +
      word(0n) +
      word(75n) +
      word(250n);

    const decoded = decodeCalldata(calldata, PRECOMPILE_ADDRESSES.CLOB);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("placeMarketOrder");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["base asset", `0x${base}`],
      ["quote asset", `0x${quote}`],
      ["side", "buy"],
      ["amount", "75"],
      ["max slippage bps", "250"],
    ]);
    expect(decodeCalldata(calldata, PRECOMPILE_ADDRESSES.BRIDGE)).toBeNull();
  });

  it("decodes CLOB placeMarketOrderEx approvals only for the CLOB precompile", () => {
    const base = "55".repeat(32);
    const quote = "66".repeat(32);
    const calldata =
      "0xa6f092f0" +
      base +
      quote +
      word(1n) +
      word(125n) +
      word(100n) +
      word(1n);

    const decoded = decodeCalldata(calldata, PRECOMPILE_ADDRESSES.CLOB);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("placeMarketOrderEx");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["base asset", `0x${base}`],
      ["quote asset", `0x${quote}`],
      ["side", "sell"],
      ["amount", "125"],
      ["max slippage bps", "100"],
      ["mode", "fill or rest at cap"],
    ]);
    expect(decodeCalldata(calldata, PRECOMPILE_ADDRESSES.BRIDGE)).toBeNull();
  });

  it("decodes CLOB cancelOrder approvals only for the CLOB precompile", () => {
    const orderId = "77".repeat(32);
    const calldata = "0x7489ec23" + orderId;

    const decoded = decodeCalldata(calldata, PRECOMPILE_ADDRESSES.CLOB);

    expect(decoded?.surface).toBe("native-market");
    expect(decoded?.name).toBe("cancelOrder");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["order id", `0x${orderId}`],
    ]);
    expect(decodeCalldata(calldata, PRECOMPILE_ADDRESSES.BRIDGE)).toBeNull();
  });
});

describe("ReqSendTx native agent calldata decode", () => {
  it("decodes native spending-policy approvals only for the agent system module", () => {
    const owner = "11".repeat(20);
    const controller = "22".repeat(20);
    const assetId = "33".repeat(32);
    const payload = encodeNativeAgentSetSpendingPolicyCall({
      owner: addressToTypedBech32("user", `0x${owner}`),
      controller: addressToTypedBech32("user", `0x${controller}`),
      nonce: 7,
      assetId: `0x${assetId}`,
      perActionLimit: "125",
      windowLimit: "500",
      windowSecs: 3600,
    });

    const decoded = decodeCalldata(payload, NATIVE_AGENT_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-agent");
    expect(decoded?.name).toBe("nativeAgentSetSpendingPolicy");
    expect(decoded?.selector).toBe("native-bincode");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["owner", addressToTypedBech32("user", `0x${owner}`)],
      ["controller", addressToTypedBech32("user", `0x${controller}`)],
      ["nonce", "7"],
      ["asset id", `0x${assetId}`],
      ["per-action limit", "125"],
      ["window limit", "500"],
      ["window seconds", "3600"],
    ]);
    expect(decodeCalldata(payload, NATIVE_MARKET_MODULE_ADDRESS)).toBeNull();
  });

  it("decodes native escrow approvals only for the agent system module", () => {
    const buyer = "11".repeat(20);
    const provider = "22".repeat(20);
    const arbiter = "33".repeat(20);
    const assetId = "44".repeat(32);
    const termsHash = "55".repeat(32);
    const payload = encodeNativeAgentCreateEscrowCall({
      buyer: addressToTypedBech32("user", `0x${buyer}`),
      provider: addressToTypedBech32("user", `0x${provider}`),
      arbiter: addressToTypedBech32("user", `0x${arbiter}`),
      nonce: 9,
      assetId: `0x${assetId}`,
      amount: "123",
      termsHash: `0x${termsHash}`,
    });

    const decoded = decodeCalldata(payload, NATIVE_AGENT_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-agent");
    expect(decoded?.name).toBe("nativeAgentCreateEscrow");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["buyer", addressToTypedBech32("user", `0x${buyer}`)],
      ["provider", addressToTypedBech32("user", `0x${provider}`)],
      ["arbiter", addressToTypedBech32("user", `0x${arbiter}`)],
      ["nonce", "9"],
      ["asset id", `0x${assetId}`],
      ["amount", "123"],
      ["terms hash", `0x${termsHash}`],
    ]);
    expect(decodeCalldata(payload, PRECOMPILE_ADDRESSES.CLOB)).toBeNull();
  });

  it("decodes native reputation approvals only for the agent system module", () => {
    const reviewer = "66".repeat(20);
    const subject = "77".repeat(20);
    const payloadHash = "88".repeat(32);
    const payload = encodeNativeAgentRecordReputationCall({
      reviewer: addressToTypedBech32("user", `0x${reviewer}`),
      subject: addressToTypedBech32("user", `0x${subject}`),
      categoryId: 42,
      scores: {
        speed: 5,
        quality: 4,
        communication: 3,
        accuracy: 2,
      },
      payloadHash: `0x${payloadHash}`,
    });

    const decoded = decodeCalldata(payload, NATIVE_AGENT_MODULE_ADDRESS);

    expect(decoded?.surface).toBe("native-agent");
    expect(decoded?.name).toBe("nativeAgentRecordReputation");
    expect(decoded?.args.map((arg) => [arg.name, arg.value])).toEqual([
      ["reviewer", addressToTypedBech32("user", `0x${reviewer}`)],
      ["subject", addressToTypedBech32("user", `0x${subject}`)],
      ["category id", "42"],
      ["speed", "5"],
      ["quality", "4"],
      ["communication", "3"],
      ["accuracy", "2"],
      ["payload hash", `0x${payloadHash}`],
    ]);
    expect(decodeCalldata(`${payload}00`, NATIVE_AGENT_MODULE_ADDRESS)).toBeNull();
  });
});

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

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

  it("labels MRC-4626 vault share balances by vault id", () => {
    const vaultId = "0x" + "4".repeat(64);
    expect(
      formatIndexedTokenBalanceRow({
        tokenId: vaultId,
        balance: "321",
        updatedAtBlock: 4626,
        mrc: {
          standard: "mrc4626",
          assetId: vaultId,
        },
      }),
    ).toEqual({
      title: "MRC-4626 shares 0x444444444444…44444444",
      subtitle: "vault 0x444444444444…44444444 · updated at block 4,626",
      unitsLabel: "vault shares",
    });
  });

  it("renders MRC-4626 vault share balances in the asset list", () => {
    const vaultId = "0x" + "4".repeat(64);
    const account = {
      id: "vault",
      label: "vault",
      denom: "public",
      addr: "0x1111111111111111111111111111111111111111",
      algo: "slhdsa",
      balance: 12,
      custody: "sw",
    } satisfies Account;
    const network = {
      chainId: "0x1",
      name: "Monolythium Testnet",
      rpc: "http://localhost:8545",
      chainIdNum: 1,
      builtin: true,
      active: true,
    } satisfies ChainEntry;
    const indexer = {
      tokenBalances: [
        {
          tokenId: vaultId,
          balance: "321",
          updatedAtBlock: 4626,
          mrc: {
            standard: "mrc4626",
            assetId: vaultId,
          },
        },
      ],
      mrcAccount: null,
      addressLabel: null,
      delegationHistory: [],
      addressActivity: [],
      errors: {},
    } satisfies WalletIndexerSnapshot;

    const html = renderToStaticMarkup(
      <AssetList account={account} network={network} indexer={indexer} />,
    );

    expect(html).toContain("MRC-4626 shares 0x444444444444…44444444");
    expect(html).toContain("vault 0x444444444444…44444444");
    expect(html).toContain("321");
    expect(html).toContain("vault shares");
  });

  it("formats native MRC holder summary rows without inventing totals", () => {
    // §22.7 — shortAddr converts the wire-format 0x address to bech32m
    // before truncating, so the rendered line carries the canonical
    // `mono1…` form rather than the legacy hex slice.
    expect(
      formatMrcHolderDisplayLine({
        rank: 1,
        address: "0x1111111111111111111111111111111111111111",
        balance: "42",
        updatedAtBlock: 12345,
      }),
    ).toBe("#1 mono1zyg3z…f9at · 42 · block 12,345");
  });

  it("labels MRC-4626 holder summaries as vault share holders", () => {
    expect(
      formatMrcHolderSummaryTitle({
        schemaVersion: 1,
        standard: "mrc4626",
        assetId: "0xvault",
        tokenId: null,
        limit: 1,
        holders: [],
      }),
    ).toBe("Vault share holders");
  });
});

describe("MRC account summary display", () => {
  const account = addressToTypedBech32(
    "smartAccount",
    "0x1111111111111111111111111111111111111111",
  );
  const controller = addressToTypedBech32(
    "user",
    "0x2222222222222222222222222222222222222222",
  );
  const recovery = addressToTypedBech32(
    "user",
    "0x3333333333333333333333333333333333333333",
  );

  it("formats compact smart, policy, and spend rows", () => {
    expect(
      formatMrcAccountRecordLine({
        kind: "smart_account",
        account,
        controller,
        recovery,
        policyHash: null,
        policy: null,
        nonce: "7",
        updatedAtBlock: 1234,
      }),
    ).toContain("Smart");
    expect(
      formatMrcAccountRecordLine({
        kind: "policy_account",
        account,
        controller,
        recovery: null,
        policyHash: "0x" + "55".repeat(32),
        policy: {
          enabled: true,
          perActionLimit: "20",
          windowLimit: "100",
          allowedAssets: ["0x" + "44".repeat(32)],
        },
        nonce: null,
        updatedAtBlock: 1235,
      }),
    ).toContain("Policy");
    expect(
      formatMrcPolicySpendLine({
        account,
        assetId: "0x" + "44".repeat(32),
        window: "9",
        amount: "20",
        spent: "45",
        updatedAtBlock: 1236,
      }),
    ).toBe("Spend 0x444444444444…44444444 · window 9 · spent 45 · block 1,236");
    expect(
      formatMrcPolicyLine({
        enabled: true,
        perActionLimit: "20",
        windowLimit: "100",
        allowedAssets: [
          "0x" + "44".repeat(32),
          "0x" + "45".repeat(32),
          "0x" + "46".repeat(32),
        ],
      }),
    ).toBe(
      "Policy body enabled · per action 20 · window 100 · assets 0x444444444444…44444444, 0x454545454545…45454545 + 1 more",
    );
  });

  it("renders the summary only when a record or spend row exists", () => {
    const empty = {
      schemaVersion: 1 as const,
      account,
      spendLimit: 4,
      smartAccount: null,
      policyAccount: null,
      policySpends: [],
    };
    expect(hasMrcAccountSummary(empty)).toBe(false);
    expect(renderToStaticMarkup(<MrcAccountSummary mrcAccount={empty} />)).toBe("");

    const html = renderToStaticMarkup(
      <MrcAccountSummary
        mrcAccount={{
          ...empty,
          policyAccount: {
            kind: "policy_account",
            account,
            controller,
            recovery: null,
            policyHash: "0x" + "55".repeat(32),
            policy: {
              enabled: true,
              perActionLimit: "20",
              windowLimit: "100",
              allowedAssets: ["0x" + "44".repeat(32)],
            },
            nonce: null,
            updatedAtBlock: 99,
          },
          policySpends: [
            {
              account,
              assetId: "0x" + "44".repeat(32),
              window: "9",
              amount: "20",
              spent: "45",
              updatedAtBlock: 100,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("MRC account");
    expect(html).toContain("Policy");
    expect(html).toContain("Policy body enabled");
    expect(html).toContain("per action 20");
    expect(html).toContain("spend window 4");
    expect(html).toContain("spent 45");
  });
});

describe("native agent state summary", () => {
  it("renders policy and escrow rows without placeholders", () => {
    const empty = {
      schemaVersion: 1,
      limit: 10,
      filters: {},
      issuers: [],
      attestations: [],
      consents: [],
      services: [],
      availability: [],
      arbiters: [],
      reputationReviews: [],
      spendingPolicies: [],
      policySpends: [],
      escrows: [],
      source: null,
    };
    expect(hasNativeAgentStateSummary(empty)).toBe(false);
    expect(renderToStaticMarkup(<NativeAgentStateSummary nativeAgentState={empty} />)).toBe("");

    const html = renderToStaticMarkup(
      <NativeAgentStateSummary
        nativeAgentState={{
          ...empty,
          issuers: [
            {
              issuer_id: "0x" + "11".repeat(32),
              issuer: "mono1agentowner",
              nonce: 1,
              updated_at_block: 45,
            },
          ],
          attestations: [
            {
              attestationId: "0x" + "12".repeat(32),
              nonce: "2",
              subject: "mono1agentcontroller",
              active: false,
              updatedAtBlock: 46,
            },
          ],
          consents: [
            {
              consent_id: "0x" + "13".repeat(32),
              grantee: "mono1agentarbiter",
              nonce: 3,
              active: true,
              updated_at_block: 47,
            },
          ],
          services: [
            {
              serviceId: "0x" + "14".repeat(32),
              provider: "mono1agentprovider",
              nonce: "0x4",
              active: true,
              updatedAtBlock: 48,
            },
          ],
          availability: [
            {
              provider: "mono1agentprovider",
              max_concurrent: 8,
              open_requests: 2,
              paused: false,
              updated_at_block: 49,
            },
          ],
          arbiters: [
            {
              arbiter_id: "0x" + "15".repeat(32),
              arbiter: "mono1agentarbiter",
              nonce: 5,
              tier: 2,
              updated_at_block: 50,
            },
          ],
          spendingPolicies: [
            {
              policyId: "0x" + "aa".repeat(32),
              owner: "mono1agentowner",
              controller: "mono1agentcontroller",
              assetId: "0x" + "cc".repeat(32),
              nonce: "6",
              enabled: true,
              perActionLimit: "100",
              windowLimit: "500",
              windowSecs: 60,
              updatedAtBlock: 42,
            },
          ],
          policySpends: [
            {
              policyId: "0x" + "aa".repeat(32),
              controller: "mono1agentcontroller",
              assetId: "0x" + "cc".repeat(32),
              window: 7,
              amount: "25",
              spent: "125",
              updatedAtBlock: 43,
            },
          ],
          escrows: [
            {
              escrowId: "0x" + "bb".repeat(32),
              buyer: "mono1agentowner",
              provider: "mono1agentprovider",
              arbiter: "mono1agentarbiter",
              assetId: "0x" + "cc".repeat(32),
              nonce: 7,
              amount: "1000",
              termsHash: "0x" + "dd".repeat(32),
              round: 2,
              buyerAccepted: true,
              providerAccepted: false,
              submittedPayloadHash: null,
              status: "accepted",
              resolution: null,
              lastActor: "mono1agentowner",
              createdAtBlock: 40,
              updatedAtBlock: 44,
            },
          ],
          reputationReviews: [
            {
              review_id: "0x" + "16".repeat(32),
              reviewer: "mono1agentowner",
              subject: "mono1agentprovider",
              quality_score: 8,
              accuracy_score: 9,
              updated_at_block: 51,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Native agent state");
    expect(html).toContain("Registry");
    expect(html).toContain("Trust");
    expect(html).toContain("Policy");
    expect(html).toContain("Escrow");
    expect(html).toContain("10 indexed rows");
    expect(html).toContain("issuer");
    expect(html).toContain("attestation");
    expect(html).toContain("consent");
    expect(html).toContain("service");
    expect(html).toContain("availability");
    expect(html).toContain("2 / 8 open");
    expect(html).toContain("arbiter");
    expect(html).toContain("review");
    expect(html).toContain("quality 8");
    expect(html).toContain("spend 125 / 25");
    expect(html).toContain("nonce 1");
    expect(html).toContain("nonce 2");
    expect(html).toContain("nonce 3");
    expect(html).toContain("nonce 0x4");
    expect(html).toContain("nonce 5");
    expect(html).toContain("nonce 6");
    expect(html).toContain("nonce 7");
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
        mrcAccount: null,
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

  it("renders SDK-ranked route choice, candidates, and floor failures", () => {
    const html = renderToStaticMarkup(
      <Bridge
        onBack={() => undefined}
        indexer={{
          bridgeRouteDisclosures: [
            sdkBridgeRoute("under-disclosed", {
              cooldownSeconds: 0,
              drainCapAtomic: "0",
              insuranceAtomic: "0",
            }),
            sdkBridgeRoute("short-cooldown", { cooldownSeconds: 60 }),
          ],
          tokenBalances: [
            {
              tokenId: "0xwrapped",
              balance: "7",
              updatedAtBlock: 12,
              bridgeRouteDisclosure: sdkBridgeRoute("healthy"),
            },
          ],
          mrcAccount: null,
          addressLabel: null,
          delegationHistory: [],
          addressActivity: [],
          errors: {},
        }}
      />,
    );

    expect(html).toContain("SDK route choice");
    expect(html).toContain("healthy is the top SDK-ranked accepted route.");
    expect(html).toMatch(/SDK rank 1[\s\S]*healthy[\s\S]*Selected/);
    expect(html).toMatch(/SDK rank 2[\s\S]*short-cooldown[\s\S]*Candidate/);
    expect(html).toContain("cooldown is under one hour");
    expect(html).toMatch(/SDK rank 3[\s\S]*under-disclosed[\s\S]*Blocked/);
    expect(html).toContain("route cooldown missing");
    expect(html).toContain("per-asset drain cap missing or zero");
    expect(html).toContain("slashable insurance pool missing or zero");
    expect(html).toContain("Transfer intent / quote preview");
    expect(html).toContain("The SDK can evaluate a transfer intent");
    expect(html).toContain("transfer amount missing or zero");
    expect(html).toContain("transfer recipient missing");
    expect(html).toContain("standalone SDK exposes route-intent selection only");
    expect(html).toContain("standalone SDK exposes no live bridge submit helper");
    expect(html).toContain("Request quote");
    expect(html).toContain("disabled");
  });

  it("renders discovery catalogue routes while keeping quote and submit disabled", () => {
    const html = renderToStaticMarkup(
      <Bridge
        onBack={() => undefined}
        indexer={{
          bridgeRouteDisclosures: [
            sdkBridgeRoute("catalogue-only", {
              bridgeId: "catalogue-bridge-arb-usdc",
              wrappedAsset: "mrc:wrapped-usdc",
            }),
          ],
          bridgeRouteReadiness: {
            routeSelectionReady: false,
            quoteReady: false,
            submitReady: false,
            blockedReasons: ["bridge route selection requires transfer intent"],
            warnings: [],
          },
          tokenBalances: [],
          mrcAccount: null,
          addressLabel: null,
          delegationHistory: [],
          addressActivity: [],
          errors: {},
        }}
      />,
    );

    expect(html).toContain("catalogue-only is the top SDK-ranked accepted route.");
    expect(html).toMatch(/SDK rank 1[\s\S]*catalogue-only[\s\S]*Selected/);
    expect(html).toContain("Bridge ID");
    expect(html).toContain("catalogue-bridge-arb-usdc");
    expect(html).toContain("Wrapped asset");
    expect(html).toContain("mrc:wrapped-usdc");
    expect(html).toContain("Catalogue readiness");
    expect(html).toContain("Selection");
    expect(html).toContain("blocked");
    expect(html).toContain("Quote");
    expect(html).toContain("disabled");
    expect(html).toContain("Submit");
    expect(html).toContain("bridge route selection requires transfer intent");
    expect(html).toContain("Transfer intent / quote preview");
    expect(html).toContain("catalogue readiness reports quote disabled");
    expect(html).toContain("catalogue readiness reports submit disabled");
    expect(html).toContain("standalone SDK exposes route-intent selection only");
    expect(html).toContain("standalone SDK exposes no live bridge submit helper");
    expect(html).toContain("Request quote");
    expect(html).toContain("Submit bridge");
    expect(html).toContain("disabled");
  });

  it("renders blocked route quote guards without constructing an intent", () => {
    const html = renderToStaticMarkup(
      <Bridge
        onBack={() => undefined}
        indexer={{
          bridgeRouteDisclosures: [
            sdkBridgeRoute("under-disclosed", {
              cooldownSeconds: 0,
              drainCapAtomic: "0",
              insuranceAtomic: "0",
            }),
          ],
          tokenBalances: [],
          mrcAccount: null,
          addressLabel: null,
          delegationHistory: [],
          addressActivity: [],
          errors: {},
        }}
      />,
    );

    expect(html).toContain("No SDK-ranked bridge route is selectable");
    expect(html).toContain("no SDK-ranked bridge route satisfies the disclosure floor");
    expect(html).toContain("No transfer intent is constructed until an SDK-shaped route is selected.");
    expect(html).toContain("quote preview requires an SDK-selected route");
    expect(html).not.toContain("transfer amount missing or zero");
    expect(html).toContain("Request quote");
    expect(html).toContain("disabled");
  });

  it("renders no-disclosure behavior without leaking route defaults", () => {
    const html = renderToStaticMarkup(
      <Bridge
        onBack={() => undefined}
        indexer={{
          tokenBalances: [],
          mrcAccount: null,
          addressLabel: null,
          delegationHistory: [],
          addressActivity: [],
          errors: {},
        }}
      />,
    );

    expect(html).toContain("Disclosure unavailable");
    expect(html).toContain("No bridgeRouteDisclosure or bridgeRouteDisclosures field was");
    expect(html).toContain("No transfer intent is constructed until an SDK-shaped route is selected.");
    expect(html).toContain("no route disclosures supplied");
    expect(html).not.toContain("SDK rank");
    expect(html).not.toContain("Asset</div>");
    expect(html).toContain("Request quote");
    expect(html).toContain("disabled");
  });
});

describe("chainHealthForFailedPoll (#42 untrusted mapping)", () => {
  it("maps cause:'untrusted' to the untrusted state", () => {
    expect(chainHealthForFailedPoll({ cause: "untrusted" })).toEqual({
      kind: "untrusted",
    });
  });

  it("maps a failure without an untrusted cause to offline (unchanged)", () => {
    expect(chainHealthForFailedPoll({ reason: "no operator" })).toEqual({
      kind: "offline",
      reason: "no operator",
    });
    expect(chainHealthForFailedPoll({ cause: "unreachable" })).toEqual({
      kind: "offline",
      reason: "unreachable",
    });
    expect(chainHealthForFailedPoll({})).toEqual({
      kind: "offline",
      reason: "unreachable",
    });
  });

  it("T9 (C5): maps cause:'regenesis' to the regenesis state (distinct from untrusted/offline)", () => {
    expect(chainHealthForFailedPoll({ cause: "regenesis" })).toEqual({
      kind: "regenesis",
    });
  });
});

describe("chainHealthPresentation (#42 untrusted = red + tap/tooltips)", () => {
  it("presents untrusted as red 'UNTRUSTED OPERATOR', tappable (same red as OFFLINE)", () => {
    expect(chainHealthPresentation("untrusted")).toMatchObject({
      label: "UNTRUSTED OPERATOR",
      color: "var(--err)",
      tappable: true,
    });
    expect(chainHealthPresentation("offline")).toMatchObject({
      label: "OFFLINE",
      color: "var(--err)",
      tappable: true,
    });
  });

  it("T9: presents regenesis as red 'ALL OPERATORS UNTRUSTED', tappable (hard trust failure)", () => {
    expect(chainHealthPresentation("regenesis")).toMatchObject({
      label: "ALL OPERATORS UNTRUSTED",
      color: "var(--err)",
      tappable: true,
    });
    expect(chainHealthPresentation("regenesis").tooltip).toMatch(
      /genesis|monoscan|network/i,
    );
  });

  it("regenesis + untrusted share the red hard-trust token (both 'on a different chain')", () => {
    expect(chainHealthPresentation("regenesis").color).toBe("var(--err)");
    expect(chainHealthPresentation("untrusted").color).toBe("var(--err)");
    // distinct copy: all-operators vs this-operator
    expect(chainHealthPresentation("regenesis").tooltip).toMatch(/^All operators/);
    expect(chainHealthPresentation("untrusted").tooltip).toMatch(/^This operator/);
  });

  it("makes the not-online states tappable, live + loading not", () => {
    expect(chainHealthPresentation("offline").tappable).toBe(true);
    expect(chainHealthPresentation("stalled").tappable).toBe(true);
    expect(chainHealthPresentation("untrusted").tappable).toBe(true);
    expect(chainHealthPresentation("live").tappable).toBe(false);
    expect(chainHealthPresentation("loading").tappable).toBe(false);
  });

  it("every state carries a non-empty hover tooltip", () => {
    for (const k of [
      "live",
      "stalled",
      "untrusted",
      "regenesis",
      "offline",
      "loading",
      "reconnecting",
    ] as const) {
      expect(chainHealthPresentation(k).tooltip.length).toBeGreaterThan(0);
    }
  });

  it("leaves live / stalled / loading labels + colors unchanged", () => {
    expect(chainHealthPresentation("live")).toMatchObject({
      label: "LIVE",
      color: "var(--ok)",
    });
    expect(chainHealthPresentation("stalled")).toMatchObject({
      label: "STALLED",
      color: "var(--warn)",
    });
    expect(chainHealthPresentation("loading")).toMatchObject({
      label: "CONNECTING…",
      color: "var(--fg-500)",
    });
  });

  it("presents reconnecting as amber, not tappable, and NOT the green LIVE token", () => {
    const pres = chainHealthPresentation("reconnecting");
    expect(pres.color).toBe("var(--warn)"); // amber, distinct from LIVE green / OFFLINE red
    expect(pres.color).not.toBe("var(--ok)"); // never the LIVE token
    expect(pres.tappable).toBe(false);
    expect(pres.label).not.toBe("LIVE");
    expect(pres.tooltip.length).toBeGreaterThan(0);
  });
});

describe("reconnectingBannerLabel (D honest warm-start label)", () => {
  it("shows the last-seen block NUMBER (decimal) with a reconnecting marker", () => {
    expect(reconnectingBannerLabel("0x10")).toBe(
      "LAST SEEN #16 · RECONNECTING…",
    );
    expect(reconnectingBannerLabel("0x1a2b")).toBe(
      "LAST SEEN #6699 · RECONNECTING…",
    );
  });

  it("never renders the word LIVE — a seeded block is not a confirmed connection", () => {
    expect(reconnectingBannerLabel("0xff")).not.toContain("LIVE");
  });
});

describe("seedReconnectingHealth (D seed validation — never asserts connectivity)", () => {
  it("lifts a valid block-hex seed to a reconnecting health (never live)", () => {
    const h = seedReconnectingHealth("0x1a2b");
    expect(h).toEqual({ kind: "reconnecting", blockHex: "0x1a2b" });
    // The hard honesty invariant: a persisted seed can NEVER produce a live
    // state — connectivity is asserted only after a this-session fetch.
    expect(h?.kind).not.toBe("live");
  });

  it("returns null for a missing or malformed seed (banner stays on CONNECTING…)", () => {
    expect(seedReconnectingHealth(undefined)).toBeNull();
    expect(seedReconnectingHealth(null)).toBeNull();
    expect(seedReconnectingHealth("")).toBeNull();
    expect(seedReconnectingHealth("not-hex")).toBeNull();
    expect(seedReconnectingHealth("0xZZZ")).toBeNull();
    expect(seedReconnectingHealth(123)).toBeNull();
    expect(seedReconnectingHealth({})).toBeNull();
  });
});

describe("shouldLabelBalanceStale (#42 balance staleness)", () => {
  it("labels a retained real balance when the chain is unreachable", () => {
    expect(shouldLabelBalanceStale(false, true, 12.5)).toBe(true);
  });

  it("never labels the pending null balance", () => {
    expect(shouldLabelBalanceStale(false, true, null)).toBe(false);
  });

  it("does not label when the balance is fresh", () => {
    expect(shouldLabelBalanceStale(false, false, 12.5)).toBe(false);
    expect(shouldLabelBalanceStale(false, undefined, 12.5)).toBe(false);
  });

  it("does not label the private (hidden) balance", () => {
    expect(shouldLabelBalanceStale(true, true, 12.5)).toBe(false);
  });
});

describe("shouldPauseBalanceDisplay (C5 / T10 — no bare 0.00 on re-genesis)", () => {
  it("T10: pauses (no bare 0.00) when the balance is unknown and operators re-genesised", () => {
    expect(shouldPauseBalanceDisplay(false, null, "regenesis")).toBe(true);
    expect(shouldPauseBalanceDisplay(false, undefined, "untrusted")).toBe(true);
  });

  it("never pauses a REAL balance (it is always shown as-is, honest absence only)", () => {
    expect(shouldPauseBalanceDisplay(false, 12.5, "regenesis")).toBe(false);
    expect(shouldPauseBalanceDisplay(false, 0, "regenesis")).toBe(false);
  });

  it("does not pause on an unreachable / transient failure (the stale label handles that)", () => {
    expect(shouldPauseBalanceDisplay(false, null, "unreachable")).toBe(false);
    expect(shouldPauseBalanceDisplay(false, null, null)).toBe(false);
    expect(shouldPauseBalanceDisplay(false, null, undefined)).toBe(false);
  });

  it("never pauses the private (hidden) balance", () => {
    expect(shouldPauseBalanceDisplay(true, null, "regenesis")).toBe(false);
  });
});

describe("pausedBalanceMonoscanUrl (C2 — trusted Monoscan balance link)", () => {
  it("builds the trusted Monoscan wallet URL (mono1… over the wallet-constant base) from a 0x address", () => {
    const url = pausedBalanceMonoscanUrl(
      "0x1111111111111111111111111111111111111111",
    );
    expect(url).not.toBeNull();
    // Trusted base + the wallet's own eoa/user (mono) bech32m — never operator-echoed.
    expect(url!.startsWith("https://monoscan.xyz/#/wallet/mono1")).toBe(true);
  });

  it("returns null for a missing / non-0x address (no broken link rendered)", () => {
    expect(pausedBalanceMonoscanUrl(null)).toBeNull();
    expect(pausedBalanceMonoscanUrl(undefined)).toBeNull();
    expect(pausedBalanceMonoscanUrl("")).toBeNull();
    expect(pausedBalanceMonoscanUrl("not-an-address")).toBeNull();
  });
});
