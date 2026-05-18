// Unit coverage for sprintnetJsonRpc's body.error stamping. Two cases
// pin the asymmetry between RPC-level rejects (which stamp method +
// via + code onto the thrown error) and transport-level failures
// (which propagate unstamped after exhausting the operator list).
//
// The popup's method-aware ErrorView in Send.tsx (Phase 4.3.1)
// depends on the body.error branch carrying the method that threw;
// these tests are the regression-catcher that pins that contract.

import { afterEach, describe, expect, it, vi } from "vitest";

// Stub getActiveOperators to a single deterministic entry. With a
// real list the post-regenesis defaults (operator-1 through operator-6)
// would drive which operator name lands in err.via; mocking lets the
// assertion be exact regardless of future default-list edits.
//
// verifyOperatorGenesis stub: Phase 11.6 disabled the genesis-hash
// enforcement, so tx-mldsa.ts no longer imports this helper. The stub
// is kept in the mock factory for symmetry with the networks.js module
// surface, returning `false` so a regression test can assert the
// dispatcher still reaches the operator — proves the guards are
// fully removed (a leftover guard would short-circuit on `false`).
// vi.mock is hoisted above the static imports below.
const { verifyOperatorGenesisSpy } = vi.hoisted(() => ({
  verifyOperatorGenesisSpy: vi.fn(async () => false),
}));
vi.mock("./networks.js", () => ({
  getActiveOperators: () => [
    { name: "operator-test", region: "x", rpc: "http://test.example" },
  ],
  verifyOperatorGenesis: verifyOperatorGenesisSpy,
}));

import { sprintnetJsonRpc } from "./tx-mldsa.js";

describe("sprintnetJsonRpc — method/via/code stamping", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("body.error stamps method + via + code on the thrown error", async () => {
    // Duck-typed Response — sprintnetJsonRpc only reads .ok, .status,
    // and .json(). Avoids depending on globalThis.Response availability
    // in the Node test env.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32049, message: "mempool: decryption failed" },
      }),
    })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sprintnetJsonRpc("lyth_getEncryptionKey", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: number;
      via?: string;
      method?: string;
    };
    expect(err.code).toBe(-32049);
    expect(err.via).toBe("operator-test");
    expect(err.method).toBe("lyth_getEncryptionKey");
    expect(err.message).toBe("mempool: decryption failed");
  });

  it("transport-only failure throws WITHOUT method/via/code stamping", async () => {
    // fetch itself rejects — the body.error branch never fires, so the
    // function falls through to the post-loop `throw lastTransportErr`
    // and that error has no stamps.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sprintnetJsonRpc("lyth_getEncryptionKey", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: number;
      via?: string;
      method?: string;
    };
    // Intentional asymmetry: transport failures don't carry attribution
    // because there's no chain-side response to attribute them to.
    expect(err.code).toBeUndefined();
    expect(err.via).toBeUndefined();
    expect(err.method).toBeUndefined();
  });
});

// Phase 11.6 regression pin — the genesis-hash enforcement has been
// disabled. With the stub `verifyOperatorGenesis` returning `false`,
// the dispatcher must still route to the operator (a leftover guard
// would short-circuit and throw "untrusted genesis" instead of letting
// the body.error propagate). This test exists to catch a future
// re-introduction of the genesis guard.
describe("sprintnetJsonRpc — Phase 11.6 genesis-disable regression", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    verifyOperatorGenesisSpy.mockClear();
  });

  it("dispatches to the operator even when verifyOperatorGenesis would return false", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x42" }),
    })) as unknown as typeof fetch;

    const { result, via } = await sprintnetJsonRpc<string>(
      "eth_blockNumber",
      [],
    );
    expect(result).toBe("0x42");
    expect(via).toBe("operator-test");
    // The dispatcher must NOT have called the genesis verifier; if a
    // future commit reinstates the guard, this assertion catches it.
    expect(verifyOperatorGenesisSpy).not.toHaveBeenCalled();
  });
});
