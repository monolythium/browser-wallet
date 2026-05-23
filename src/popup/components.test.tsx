import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRECOMPILE_ADDRESSES, addressToTypedBech32 } from "@monolythium/core-sdk";
import {
  applyFeeTier,
  AssetList,
  Bridge,
  bridgeRouteDisclosureHasRequiredFloorData,
  computeNativeFeeLythoshi,
  collectBridgeRouteDisclosuresFromIndexer,
  decodeCalldata,
  formatMrcAccountRecordLine,
  formatIndexedTokenBalanceRow,
  formatBridgeRouteDisclosureDisplay,
  formatMrcHolderDisplayLine,
  formatMrcHolderSummaryTitle,
  formatMrcPolicySpendLine,
  formatExecutionUnits,
  formatLythoshiAmountHex,
  formatLythoshiPerExecutionUnit,
  hasMrcAccountSummary,
  lythoshiToLythString,
  MrcAccountSummary,
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
    cooldownSeconds: 86_400,
    adminControl: "consensusOnly",
    circuitBreaker: "armed",
    insuranceAtomic: "50000000000",
    lastIncidentDate: null,
    ...overrides,
  };
}

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
      name: "Sprintnet",
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
    expect(
      formatMrcHolderDisplayLine({
        rank: 1,
        address: "0x1111111111111111111111111111111111111111",
        balance: "42",
        updatedAtBlock: 12345,
      }),
    ).toBe("#1 0x11111111…1111 · 42 · block 12,345");
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
    expect(html).toContain("spend window 4");
    expect(html).toContain("spent 45");
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
    expect(html).toContain("no SDK-ranked bridge route satisfies the v4.1 disclosure floor");
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
