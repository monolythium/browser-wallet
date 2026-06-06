import { beforeEach, describe, expect, it, vi } from "vitest";

interface RpcStub {
  responses: Record<string, unknown>;
  errors: Record<string, { code?: number; message: string }>;
  calls: Array<{ method: string; params: unknown[] }>;
}

const stub: RpcStub = { responses: {}, errors: {}, calls: [] };

vi.mock("./tx-mldsa.js", () => ({
  testnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
    stub.calls.push({ method, params });
    if (stub.errors[method] !== undefined) {
      const e = stub.errors[method]!;
      const err = new Error(e.message) as Error & { code?: number };
      if (e.code !== undefined) err.code = e.code;
      throw err;
    }
    if (stub.responses[method] !== undefined) {
      return { result: stub.responses[method], via: "test-operator" };
    }
    throw new Error(`no seed for ${method}`);
  }),
}));

const { readNativeMarketState } = await import("./native-market-state-client.js");
const {
  buildNativeMarketStateRpcFilter,
  validateNativeMarketStateResponse,
} = await import("../shared/native-market-state.js");

const MARKET_STATE = {
  schemaVersion: 1,
  limit: 25,
  filters: {
    marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    includeSpotOrders: true,
  },
  spotMarkets: [
    {
      marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      owner: "mono1owner",
      baseAssetId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      quoteAssetId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      tickSize: "100",
      lotSize: "10",
      minQuantity: "10",
      minNotional: "1000",
      tradeCount: "2",
      totalVolumeBase: "40",
      lastPrice: "120",
      lastBlockHeight: 42,
      createdAtBlock: 1,
      updatedAtBlock: 42,
    },
  ],
  spotOrders: [
    {
      orderId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      owner: "mono1maker",
      side: "ask",
      price: "120",
      quantity: "50",
      remaining: "10",
      status: "open",
      expiresAtBlock: 0,
      updatedAtBlock: 42,
    },
  ],
  nftListings: [
    {
      listingId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      seller: "mono1seller",
      standard: "mrc721",
      collectionId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      tokenId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      quantity: "1",
      paymentAssetId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      price: "500",
      listingKind: { kind: "fixedPrice" },
      status: "open",
      expiresAtBlock: 0,
      highestBidder: null,
      highestBid: null,
      updatedAtBlock: 43,
    },
  ],
  collectionRoyalties: [
    {
      collectionId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      creator: "mono1creator",
      recipient: "mono1recipient",
      bps: 250,
      updatedAtBlock: 44,
    },
  ],
  source: {
    indexerProvider: "native_market_state",
    projection: "native_market_state",
  },
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("native-market-state parsing", () => {
  it("preserves spot market, spot order, NFT listing, and royalty rows", () => {
    expect(validateNativeMarketStateResponse(MARKET_STATE)).toEqual(MARKET_STATE);
  });

  it("accepts snake_case row arrays from REST-style envelopes", () => {
    const parsed = validateNativeMarketStateResponse({
      schemaVersion: 1,
      limit: 10,
      filters: {},
      spot_markets: MARKET_STATE.spotMarkets,
      spot_orders: MARKET_STATE.spotOrders,
      nft_listings: MARKET_STATE.nftListings,
      collection_royalties: MARKET_STATE.collectionRoyalties,
      source: null,
    });

    expect(parsed?.spotMarkets).toEqual(MARKET_STATE.spotMarkets);
    expect(parsed?.spotOrders).toEqual(MARKET_STATE.spotOrders);
    expect(parsed?.nftListings).toEqual(MARKET_STATE.nftListings);
    expect(parsed?.collectionRoyalties).toEqual(MARKET_STATE.collectionRoyalties);
  });

  it("rejects envelopes without the current-state row families", () => {
    expect(validateNativeMarketStateResponse({ schemaVersion: 1, limit: 10 })).toBeNull();
  });

  it("builds a bounded RPC filter without inventing default includes", () => {
    expect(
      buildNativeMarketStateRpcFilter({
        marketId: "",
        orderId: "0x01",
        includeSpotOrders: true,
        limit: 25,
      }),
    ).toEqual({ orderId: "0x01", includeSpotOrders: true, limit: 25 });
  });
});

describe("readNativeMarketState", () => {
  it("calls lyth_nativeMarketState and returns live current state", async () => {
    stub.responses["lyth_nativeMarketState"] = MARKET_STATE;

    const out = await readNativeMarketState({
      marketId: MARKET_STATE.spotMarkets[0]!.marketId as string,
      includeSpotOrders: true,
      limit: 25,
    });

    expect(stub.calls).toEqual([
      {
        method: "lyth_nativeMarketState",
        params: [
          {
            marketId: MARKET_STATE.spotMarkets[0]!.marketId,
            includeSpotOrders: true,
            limit: 25,
          },
        ],
      },
    ]);
    expect(out.kind).toBe("live");
    expect(out.data).toEqual(MARKET_STATE);
  });

  it("does not fabricate state when the chain method is absent", async () => {
    stub.errors["lyth_nativeMarketState"] = {
      code: -32601,
      message: "method not found",
    };

    const out = await readNativeMarketState();

    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toBeNull();
  });

  it("does not fabricate state for malformed current-state responses", async () => {
    stub.responses["lyth_nativeMarketState"] = {
      schemaVersion: 1,
      limit: 10,
      spotMarkets: [],
    };

    const out = await readNativeMarketState();

    expect(out.kind).toBe("mock-error");
    expect(out.data).toBeNull();
  });
});
