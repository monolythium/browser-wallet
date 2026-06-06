import { beforeEach, describe, expect, it, vi } from "vitest";

interface RpcStub {
  response: unknown;
  error: Error | null;
  calls: Array<{ method: string; params: unknown[] }>;
}

const stub: RpcStub = { response: undefined, error: null, calls: [] };

vi.mock("./tx-mldsa.js", () => ({
  testnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
    stub.calls.push({ method, params });
    if (stub.error !== null) throw stub.error;
    return { result: stub.response, via: "test-operator" };
  }),
}));

const {
  normaliseBridgeRoutesResponse,
  readBridgeRoutes,
} = await import("./bridge-routes-client.js");

const ROUTE = {
  routeId: "ccip-usdc-eth-mono",
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
};

beforeEach(() => {
  stub.response = undefined;
  stub.error = null;
  stub.calls = [];
});

describe("normaliseBridgeRoutesResponse", () => {
  it("accepts direct route arrays", () => {
    expect(normaliseBridgeRoutesResponse([ROUTE])).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
  });

  it("accepts bounded envelope route fields", () => {
    expect(normaliseBridgeRoutesResponse({ routes: [ROUTE] })).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
    expect(
      normaliseBridgeRoutesResponse({ bridgeRouteDisclosures: [ROUTE] }),
    ).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
  });

  it("accepts legacy and snake_case catalogue aliases", () => {
    expect(normaliseBridgeRoutesResponse({ bridgeRoutes: [ROUTE] })).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
    expect(
      normaliseBridgeRoutesResponse({ bridge_route_disclosures: [ROUTE] }),
    ).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
    expect(normaliseBridgeRoutesResponse({ bridge_routes: [ROUTE] })).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
    expect(normaliseBridgeRoutesResponse({ route_disclosures: [ROUTE] })).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: null,
    });
  });

  it("combines discovery-only readiness envelopes with catalogue routes", () => {
    const bridgeBoundDuplicate = {
      ...ROUTE,
      bridgeId: "catalogue-bridge-eth-usdc",
      wrappedAsset: "mrc:wrapped-usdc",
    };
    const bridgeBoundRoute = {
      ...ROUTE,
      routeId: "arb-usdc-mainnet",
      bridgeId: "catalogue-bridge-arb-usdc",
      wrappedAsset: "mrc:wrapped-usdc",
      sourceChain: "Arbitrum",
    };
    expect(
      normaliseBridgeRoutesResponse({
        selection: {
          selected: null,
          candidates: [],
          blockedReasons: ["bridge route selection requires transfer intent"],
        },
        routeSelectionReady: false,
        quoteReady: false,
        submitReady: false,
        blockedReasons: ["bridge route selection requires transfer intent"],
        warnings: [],
        routes: [ROUTE],
        bridgeRouteDisclosures: [bridgeBoundDuplicate, bridgeBoundRoute],
        source: {
          address: null,
          routeCount: 2,
          globalRouteIndexAvailable: true,
          routeDisclosureSource: "indexer.bridgeRouteDisclosures",
        },
      }),
    ).toEqual({
      bridgeRouteDisclosures: [bridgeBoundDuplicate, bridgeBoundRoute],
      readiness: {
        routeSelectionReady: false,
        quoteReady: false,
        submitReady: false,
        blockedReasons: ["bridge route selection requires transfer intent"],
        warnings: [],
      },
    });
  });

  it("rejects unknown object shapes", () => {
    expect(normaliseBridgeRoutesResponse({ data: [ROUTE] })).toBeNull();
  });
});

describe("readBridgeRoutes", () => {
  it("calls lyth_bridgeRoutes with no params and returns discovery catalogues", async () => {
    stub.response = {
      selection: {
        selected: null,
        candidates: [],
        blockedReasons: ["bridge route selection requires transfer intent"],
      },
      routeSelectionReady: false,
      quoteReady: false,
      submitReady: false,
      blockedReasons: ["bridge route selection requires transfer intent"],
      warnings: [],
      routes: [ROUTE],
      bridgeRouteDisclosures: [ROUTE],
    };

    const out = await readBridgeRoutes();

    expect(stub.calls).toEqual([{ method: "lyth_bridgeRoutes", params: [] }]);
    expect(out.kind).toBe("live");
    expect(out.data).toEqual({
      bridgeRouteDisclosures: [ROUTE],
      readiness: {
        routeSelectionReady: false,
        quoteReady: false,
        submitReady: false,
        blockedReasons: ["bridge route selection requires transfer intent"],
        warnings: [],
      },
    });
  });

  it("keeps route discovery closed when the method is absent", async () => {
    const err = new Error("method not found") as Error & { code: number };
    err.code = -32601;
    stub.error = err;

    const out = await readBridgeRoutes();

    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toEqual({
      bridgeRouteDisclosures: [],
      readiness: null,
    });
  });
});
