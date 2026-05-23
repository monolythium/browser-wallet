import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyFeeTier,
  Bridge,
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
import type { WalletBridgeRouteDisclosure } from "./bg.js";

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
          bridgeRouteDisclosures: [sdkBridgeRoute("catalogue-only")],
          tokenBalances: [],
          addressLabel: null,
          delegationHistory: [],
          addressActivity: [],
          errors: {},
        }}
      />,
    );

    expect(html).toContain("catalogue-only is the top SDK-ranked accepted route.");
    expect(html).toMatch(/SDK rank 1[\s\S]*catalogue-only[\s\S]*Selected/);
    expect(html).toContain("Transfer intent / quote preview");
    expect(html).toContain("standalone SDK exposes route-intent selection only");
    expect(html).toContain("standalone SDK exposes no live bridge submit helper");
    expect(html).toContain("Request quote");
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
