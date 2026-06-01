// Unit coverage for sprintnetMaxBalanceConsensus — the parallel
// MAX-across-operators resilience fix for wallet-balance.
//
// Background: operators on the same chain can briefly lag behind each
// other after a regenesis or binary rollout. The single-operator
// failover in sprintnetJsonRpc would latch onto the first responder's
// stale "0x0" envelope; this helper queries all operators in parallel
// and returns the MAX, which is safe specifically for balance (a
// lagging operator can only under-report, never over-report).

import { afterEach, describe, expect, it, vi } from "vitest";

const OPERATORS = [
  { name: "op-a", region: "x", rpc: "http://op-a.test" },
  { name: "op-b", region: "y", rpc: "http://op-b.test" },
  { name: "op-c", region: "z", rpc: "http://op-c.test" },
];

vi.mock("./networks.js", () => ({
  getActiveOperators: () => OPERATORS,
  // genesis-pin: stub to always-true so this suite tests the
  // consensus shape, not the genesis check (covered separately).
  verifyOperatorGenesis: async () => true,
}));

import { sprintnetMaxBalanceConsensus } from "./tx-mldsa.js";

interface FetchHandlerArgs {
  url: string;
}
type FetchHandler = (args: FetchHandlerArgs) => Promise<unknown> | unknown;

function installFetchPerUrl(handlers: Record<string, FetchHandler>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = handlers[url];
    if (handler === undefined) {
      throw new Error(`unmocked fetch to ${url}`);
    }
    return (await handler({ url })) as Response;
  }) as unknown as typeof fetch;
}

function envelopeResponse(valueHex: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        blockNumber: "0x1",
        proof: "0x",
        stateRoot: "0x" + "00".repeat(32),
        value: valueHex,
      },
    }),
  };
}

function plainHexResponse(valueHex: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: valueHex }),
  };
}

function errorBodyResponse(code: number, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code, message },
    }),
  };
}

function malformedResponse() {
  return {
    ok: true,
    status: 200,
    // Missing the `value` field — light-client envelope without the
    // payload should be ignored, not crash.
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { blockNumber: "0x1", proof: "0x", stateRoot: "0x" + "00".repeat(32) },
    }),
  };
}

describe("sprintnetMaxBalanceConsensus", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns MAX when one operator reports the correct balance and others lag", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => envelopeResponse("0x0"),
      "http://op-b.test": async () => envelopeResponse("0x989680"), // 0.1 LYTH
      "http://op-c.test": async () => envelopeResponse("0x0"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x989680");
    // T4-03: the spend guard is the LOWEST contributing balance (the two
    // lagging 0x0 operators), so an inflated Max can't pass the spend gate.
    expect(r.spendGuardHex).toBe("0x0");
    expect(r.contributing).toHaveLength(3);
    expect(r.failing).toHaveLength(0);
  });

  it("returns the unanimous value when all operators agree", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => envelopeResponse("0x989680"),
      "http://op-b.test": async () => envelopeResponse("0x989680"),
      "http://op-c.test": async () => envelopeResponse("0x989680"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x989680");
    expect(r.contributing).toHaveLength(3);
    expect(r.failing).toHaveLength(0);
  });

  it("returns max of survivors when one errors and the rest disagree", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => errorBodyResponse(-32603, "operator down"),
      "http://op-b.test": async () => envelopeResponse("0x5"),
      "http://op-c.test": async () => envelopeResponse("0xa"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0xa");
    expect(r.contributing).toHaveLength(2);
    expect(r.failing).toHaveLength(1);
    expect(r.failing[0]?.name).toBe("op-a");
    expect(r.failing[0]?.reason).toContain("operator down");
  });

  it("throws when every operator fails", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => {
        throw new TypeError("network down");
      },
      "http://op-b.test": async () => errorBodyResponse(-32603, "boom"),
      "http://op-c.test": async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    await expect(sprintnetMaxBalanceConsensus("0xabc")).rejects.toThrow(
      /all 3 Monolythium Testnet operators failed/,
    );
  });

  it("ignores a malformed envelope shape and uses the remaining operators", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => malformedResponse(),
      "http://op-b.test": async () => envelopeResponse("0x2"),
      "http://op-c.test": async () => envelopeResponse("0x3"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x3");
    expect(r.contributing.map((c) => c.name).sort()).toEqual(["op-b", "op-c"]);
    expect(r.failing).toHaveLength(1);
    expect(r.failing[0]?.name).toBe("op-a");
    expect(r.failing[0]?.reason).toContain("malformed");
  });

  it("accepts the plain hex-string return shape alongside the proof envelope", async () => {
    // Non-Sprintnet chains return raw hex strings for eth_getBalance.
    // Helper should still handle that shape if it ever shows up on a
    // mixed cluster — robustness, not just envelope-specific.
    installFetchPerUrl({
      "http://op-a.test": async () => plainHexResponse("0x1"),
      "http://op-b.test": async () => plainHexResponse("0x5"),
      "http://op-c.test": async () => plainHexResponse("0x2"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x5");
  });

  it("drops an operator whose balance exceeds total supply (T4-03 sanity bound)", async () => {
    // op-a reports an impossible balance (1e18 lythoshi ~ 50x total supply);
    // it must be dropped to `failing`, never win the MAX or skew the guard.
    installFetchPerUrl({
      "http://op-a.test": async () => envelopeResponse("0xde0b6b3a7640000"), // 1e18
      "http://op-b.test": async () => envelopeResponse("0x5"),
      "http://op-c.test": async () => envelopeResponse("0x3"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x5"); // the real max, not the absurd value
    expect(r.spendGuardHex).toBe("0x3"); // lowest real
    expect(r.contributing.map((c) => c.name).sort()).toEqual(["op-b", "op-c"]);
    expect(r.failing).toHaveLength(1);
    expect(r.failing[0]?.name).toBe("op-a");
    expect(r.failing[0]?.reason).toContain("exceeds total supply");
  });

  it("spendGuardHex is the lowest contributing balance, balanceHex the highest", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => envelopeResponse("0x9"),
      "http://op-b.test": async () => envelopeResponse("0x2"),
      "http://op-c.test": async () => envelopeResponse("0x7"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x9");
    expect(r.spendGuardHex).toBe("0x2");
  });

  // SDK contract anchor. The strict
  // AccountProofResponse binding (mono-core-sdk @0fd8a79) annotates
  // `state_root`/`block_number` in snake_case, but the chain serializer
  // emits camelCase on the wire (`stateRoot`, `blockNumber`). The
  // wallet only reads `.value`, so the case mismatch is a no-op for
  // balance reads — but pin a fixture in both shapes to catch any
  // future serializer rotation early.
  it("parses both wire-case forms of the AccountProofResponse envelope", async () => {
    // camelCase wire form (what the chain currently emits)
    const camelCase = {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: "0x7",
          stateRoot: "0x" + "11".repeat(32),
          blockNumber: "0x100",
          proof: null,
        },
      }),
    };
    // snake_case wire form (what the ts-rs binding annotates)
    const snakeCase = {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: "0x9",
          state_root: "0x" + "22".repeat(32),
          block_number: "0x100",
          proof: null,
        },
      }),
    };
    installFetchPerUrl({
      "http://op-a.test": async () => camelCase,
      "http://op-b.test": async () => snakeCase,
      "http://op-c.test": async () => envelopeResponse("0x3"),
    });
    const r = await sprintnetMaxBalanceConsensus("0xabc");
    expect(r.balanceHex).toBe("0x9");
    expect(r.contributing).toHaveLength(3);
  });
});
