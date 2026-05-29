// v5 wiring — bridge circuit-breaker / drain health reader tests.
//
// Pins the new SW readers to the §20/§25.2 disclosure-only contract:
//   - param assembly mirrors the SDK `lythBridgeHealth(cursor, limit)`
//     shape (forward only the slots that are set);
//   - a not-deployed operator (-32601) collapses to mock-not-deployed
//     with the empty sentinel, not a throw;
//   - a malformed response routes to mock-error.

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

const { readBridgeHealth, readBridgeDrainStatus } = await import(
  "./bridge-health-client.js"
);

const HEALTH_RESPONSE = {
  schemaVersion: 1,
  source: "native_state_storage",
  precompile: "0x0000000000000000000000000000000000001008",
  records: [
    {
      bridgeId: "0xabc",
      status: "active",
      statusCode: 1,
      latestAnchor: {
        headerRoot: "0xdead",
        headerBlock: 100,
        updatedAtProtocoreBlock: 200,
      },
      circuitBreaker: {
        defaultDrainCapPerWindow: "0x64",
        defaultDrainWindowBlocks: 1200,
        paused: false,
        pausedAtBlock: null,
        resumeCooldownBlocks: 600,
      },
    },
  ],
  nextCursor: null,
};

const DRAIN_RESPONSE = {
  schemaVersion: 1,
  source: "native_state_storage",
  precompile: "0x0000000000000000000000000000000000001008",
  bridgeId: "0xabc",
  wrappedAsset: "mono1wrapped",
  capPerWindow: "0x64",
  windowBlocks: 1200,
  currentBucket: 3,
  drainedThisBucket: "0x10",
  remaining: "0x54",
  bridgeDefault: { drainCapPerWindow: "0x64", drainWindowBlocks: 1200 },
};

beforeEach(() => {
  stub.response = undefined;
  stub.error = null;
  stub.calls = [];
});

describe("readBridgeHealth", () => {
  it("forwards no params when neither cursor nor limit is set", async () => {
    stub.response = HEALTH_RESPONSE;
    const out = await readBridgeHealth();
    expect(stub.calls).toEqual([{ method: "lyth_bridgeHealth", params: [] }]);
    expect(out.kind).toBe("live");
    if (out.kind === "live") {
      expect(out.data.records).toHaveLength(1);
      expect(out.data.records[0]!.circuitBreaker.paused).toBe(false);
    }
  });

  it("forwards [cursor, limit] when both are set", async () => {
    stub.response = HEALTH_RESPONSE;
    await readBridgeHealth("0xnext", 25);
    expect(stub.calls).toEqual([
      { method: "lyth_bridgeHealth", params: ["0xnext", 25] },
    ]);
  });

  it("forwards [null] when only limit-less cursor=null is passed via explicit limit", async () => {
    stub.response = HEALTH_RESPONSE;
    await readBridgeHealth(null, 10);
    expect(stub.calls).toEqual([
      { method: "lyth_bridgeHealth", params: [null, 10] },
    ]);
  });

  it("collapses to mock-not-deployed when the method is absent", async () => {
    const err = new Error("method not found") as Error & { code: number };
    err.code = -32601;
    stub.error = err;
    const out = await readBridgeHealth();
    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data.records).toEqual([]);
  });

  it("routes a malformed response to mock-error", async () => {
    stub.response = { schemaVersion: 1 }; // no records array
    const out = await readBridgeHealth();
    expect(out.kind).toBe("mock-error");
    expect(out.data.records).toEqual([]);
  });
});

describe("readBridgeDrainStatus", () => {
  it("forwards [bridgeId, wrappedAsset] and returns the live bucket", async () => {
    stub.response = DRAIN_RESPONSE;
    const out = await readBridgeDrainStatus("0xabc", "mono1wrapped");
    expect(stub.calls).toEqual([
      { method: "lyth_bridgeDrainStatus", params: ["0xabc", "mono1wrapped"] },
    ]);
    expect(out.kind).toBe("live");
    if (out.kind === "live") {
      expect(out.data.remaining).toBe("0x54");
      expect(out.data.capPerWindow).toBe("0x64");
    }
  });

  it("collapses to mock-not-deployed when the method is absent", async () => {
    const err = new Error("method not found") as Error & { code: number };
    err.code = -32601;
    stub.error = err;
    const out = await readBridgeDrainStatus("0xabc", "mono1wrapped");
    expect(out.kind).toBe("mock-not-deployed");
    // Mock echoes the requested ids so the disclosure panel stays stable.
    expect(out.data.bridgeId).toBe("0xabc");
    expect(out.data.wrappedAsset).toBe("mono1wrapped");
    expect(out.data.remaining).toBe("0x0");
  });
});
