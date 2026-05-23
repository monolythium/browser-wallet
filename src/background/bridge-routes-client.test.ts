import { beforeEach, describe, expect, it, vi } from "vitest";

interface RpcStub {
  response: unknown;
  error: Error | null;
  calls: Array<{ method: string; params: unknown[] }>;
}

const stub: RpcStub = { response: undefined, error: null, calls: [] };

vi.mock("./tx-mldsa.js", () => ({
  sprintnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
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
    expect(normaliseBridgeRoutesResponse([ROUTE])).toEqual([ROUTE]);
  });

  it("accepts bounded envelope route fields", () => {
    expect(normaliseBridgeRoutesResponse({ routes: [ROUTE] })).toEqual([ROUTE]);
    expect(
      normaliseBridgeRoutesResponse({ bridgeRouteDisclosures: [ROUTE] }),
    ).toEqual([ROUTE]);
  });

  it("rejects unknown object shapes", () => {
    expect(normaliseBridgeRoutesResponse({ data: [ROUTE] })).toBeNull();
  });
});

describe("readBridgeRoutes", () => {
  it("calls lyth_bridgeRoutes with no params and returns live disclosures", async () => {
    stub.response = { routes: [ROUTE] };

    const out = await readBridgeRoutes();

    expect(stub.calls).toEqual([{ method: "lyth_bridgeRoutes", params: [] }]);
    expect(out.kind).toBe("live");
    expect(out.data).toEqual([ROUTE]);
  });

  it("keeps route discovery closed when the method is absent", async () => {
    const err = new Error("method not found") as Error & { code: number };
    err.code = -32601;
    stub.error = err;

    const out = await readBridgeRoutes();

    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toEqual([]);
  });
});
