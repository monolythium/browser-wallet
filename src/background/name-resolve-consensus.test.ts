// Unit coverage for testnetResolveNameConsensus — the cross-operator QUORUM
// for §22.8 forward name resolution (P5-002 close).
//
// Background: the resolved name → address feeds a SIGNED recipient, so a
// single rogue (or MITM'd) operator returning a different address must not be
// trusted. This helper fans lyth_resolveName across all genesis-trusted
// operators (mirroring the balance-consensus fan-out) and applies an
// EXACT-MATCH agreement reduce — fail-closed on any disagreement, and
// fail-closed unless at least NAME_RESOLVE_QUORUM_MIN (2) operators agree, so
// no single operator is ever the sole authority for a signed address.

import { afterEach, describe, expect, it, vi } from "vitest";
import { addressToBech32m } from "../shared/bech32m.js";

const OPERATORS = [
  { name: "op-a", region: "x", rpc: "http://op-a.test" },
  { name: "op-b", region: "y", rpc: "http://op-b.test" },
  { name: "op-c", region: "z", rpc: "http://op-c.test" },
];

vi.mock("./networks.js", () => ({
  getActiveOperators: () => OPERATORS,
  // genesis-pin: stub always-true so this suite tests the agreement reduce,
  // not the genesis check (covered separately).
  verifyOperatorGenesis: async () => true,
}));

import { testnetResolveNameConsensus } from "./tx-mldsa.js";

// Two distinct, well-formed owner addresses. The consensus decodes the
// returned `mono…` bech32m back to a lowercased 0x, so the round-trip is exact.
const ADDR_A_0X = "0x" + "11".repeat(20);
const ADDR_B_0X = "0x" + "22".repeat(20);
const MONO_A = addressToBech32m(ADDR_A_0X);
const MONO_B = addressToBech32m(ADDR_B_0X);

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

/** A lyth_resolveName response: a `mono…` address on a hit, null on a miss. */
function resolveResponse(addressBech32: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { name: "alice.mono", address: addressBech32, category: "human" },
    }),
  };
}

function rpcErrorResponse(code: number, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { code, message } }),
  };
}

describe("testnetResolveNameConsensus (P5-002 quorum)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("confirmed-hit when all operators agree on the same owner address", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_A),
      "http://op-b.test": async () => resolveResponse(MONO_A),
      "http://op-c.test": async () => resolveResponse(MONO_A),
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("confirmed-hit");
    expect(r.addr0x).toBe(ADDR_A_0X);
    expect(r.agreeing).toBe(3);
  });

  it("confirmed-hit when a quorum (2) agrees and a third operator is down", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_A),
      "http://op-b.test": async () => resolveResponse(MONO_A),
      "http://op-c.test": async () => {
        throw new TypeError("network down");
      },
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("confirmed-hit");
    expect(r.addr0x).toBe(ADDR_A_0X);
    expect(r.agreeing).toBe(2);
  });

  it("confirmed-miss when all operators agree the name is unregistered", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(null),
      "http://op-b.test": async () => resolveResponse(null),
      "http://op-c.test": async () => resolveResponse(null),
    });
    const r = await testnetResolveNameConsensus("nobody.mono");
    expect(r.status).toBe("confirmed-miss");
    expect(r.addr0x).toBeNull();
  });

  it("FAIL-CLOSED: disagreement when one operator returns a DIFFERENT address (the rogue)", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_A),
      "http://op-b.test": async () => resolveResponse(MONO_A),
      "http://op-c.test": async () => resolveResponse(MONO_B), // rogue
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("disagreement");
    expect(r.addr0x).toBeNull();
  });

  it("FAIL-CLOSED: disagreement on a hit-vs-miss split (a rogue suppressing OR a lagging operator)", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_A),
      "http://op-b.test": async () => resolveResponse(null), // miss
      "http://op-c.test": async () => resolveResponse(MONO_A),
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("disagreement");
    expect(r.addr0x).toBeNull();
  });

  it("FAIL-CLOSED: a LONE rogue (only responder) is insufficient — it cannot win alone", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_B), // rogue, the only answer
      "http://op-b.test": async () => {
        throw new TypeError("network down");
      },
      "http://op-c.test": async () => rpcErrorResponse(-32603, "operator down"),
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("insufficient");
    expect(r.addr0x).toBeNull();
    expect(r.agreeing).toBe(1);
  });

  it("FAIL-CLOSED: insufficient when fewer than the quorum answer", async () => {
    installFetchPerUrl({
      "http://op-a.test": async () => resolveResponse(MONO_A),
      "http://op-b.test": async () => rpcErrorResponse(-32601, "method not found"),
      "http://op-c.test": async () => {
        throw new TypeError("network down");
      },
    });
    const r = await testnetResolveNameConsensus("alice.mono");
    expect(r.status).toBe("insufficient");
    expect(r.addr0x).toBeNull();
  });
});
