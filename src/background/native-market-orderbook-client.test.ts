import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./networks.js", () => ({
  getActiveOperators: () => [
    { name: "operator-test", region: "x", rpc: "http://test.example" },
  ],
  verifyOperatorGenesis: async () => true,
}));

const { readNativeMarketOrderBookDeltas } = await import(
  "./native-market-orderbook-client.js"
);
const {
  buildNativeMarketOrderBookReplayQuery,
  validateNativeMarketOrderBookReplayResponse,
} = await import("../shared/native-market-orderbook.js");

const originalFetch = globalThis.fetch;

const DELTA_REPLAY = {
  schemaVersion: 1,
  fromBlock: 100,
  toBlock: 110,
  limit: 25,
  cursor: null,
  nextCursor: "0x00000000000000650000000000000000",
  filters: {
    marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  replay: true,
  streamTopic: "nativeMarketOrderBook",
  deltas: [
    {
      marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      orderId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      eventName: "market.spot.order_placed",
      action: "upsert",
      side: "bid",
      price: "101",
      quantity: "9",
      remaining: "7",
      status: "open",
      blockHeight: 101,
      txIndex: 0,
      logIndex: 0,
    },
  ],
  source: {
    indexerProvider: "native_events",
    projection: "native_market_orderbook_deltas",
  },
};

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: DELTA_REPLAY }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("native market orderbook replay parsing", () => {
  it("accepts the stream-compatible replay envelope", () => {
    expect(validateNativeMarketOrderBookReplayResponse(DELTA_REPLAY)).toEqual(
      DELTA_REPLAY,
    );
  });

  it("rejects malformed or hybrid replay envelopes", () => {
    expect(
      validateNativeMarketOrderBookReplayResponse({
        ...DELTA_REPLAY,
        replay: false,
      }),
    ).toBeNull();
    expect(
      validateNativeMarketOrderBookReplayResponse({
        ...DELTA_REPLAY,
        deltas: [{ ...DELTA_REPLAY.deltas[0], action: "patch" }],
      }),
    ).toBeNull();
  });

  it("serializes bounded replay filters", () => {
    const query = buildNativeMarketOrderBookReplayQuery({
      fromBlock: 100,
      toBlock: 110,
      marketId: DELTA_REPLAY.filters.marketId,
      cursor: "0x00000000000000640000000000000000",
      limit: 25,
    });
    expect(query?.toString()).toBe(
      "fromBlock=100&toBlock=110&limit=25&cursor=0x00000000000000640000000000000000&marketId=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});

describe("readNativeMarketOrderBookDeltas", () => {
  it("fetches the replay endpoint and returns live deltas", async () => {
    const out = await readNativeMarketOrderBookDeltas({
      fromBlock: 100,
      toBlock: 110,
      marketId: DELTA_REPLAY.filters.marketId,
      limit: 25,
    });

    expect(out.kind).toBe("live");
    expect(out.data).toEqual(DELTA_REPLAY);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://test.example/api/v1/native-market-orderbook-deltas?fromBlock=100&toBlock=110&limit=25&marketId=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("fails closed when the replay endpoint returns malformed data", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ...DELTA_REPLAY, deltas: [{ marketId: "bad" }] } }),
    })) as unknown as typeof fetch;

    const out = await readNativeMarketOrderBookDeltas({
      fromBlock: 100,
      toBlock: 110,
    });

    expect(out.kind).toBe("mock-error");
    expect(out.data).toBeNull();
  });

  it("does not fabricate replay deltas when the endpoint is absent", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const out = await readNativeMarketOrderBookDeltas({
      fromBlock: 100,
      toBlock: 110,
    });

    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toBeNull();
  });
});
