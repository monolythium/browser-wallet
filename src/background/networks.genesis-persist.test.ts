// Genesis-cache persistence + C6 (R3) hardening.
//
// A DEFINITIVE verdict is persisted to chrome.storage.session and rehydrated on
// the next SW boot so the first probe after a cold wake reads from cache instead
// of re-probing. C6 makes that persistence FAIL-SAFE:
//  - the blob is PIN-QUALIFIED (`{ pin, entries }`) — a re-pin (or any pin-less /
//    malformed blob) is DROPPED on rehydrate, never rehydrated as trusted (T11);
//  - a definitive POSITIVE ("passed") verdict is bounded by a re-probe TTL so an
//    operator that passed once then silently forked is re-detected (T12);
//  - a definitive MISMATCH stays sticky (keeps the wallet paused);
//  - a NON-definitive "couldn't read" keeps its short TTL and is not persisted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGenesisCache,
  rehydrateGenesisCache,
  snapshotGenesisCache,
  verifyOperatorGenesis,
} from "./networks.js";
import {
  TESTNET_BLOCK0_HASH,
  TESTNET_GENESIS_HASH,
} from "../shared/build-info.js";

const SESSION_KEY = "mono.session.genesis-cache.v2";
const RPC = "http://persist-operator.invalid:8545";

/** Must mirror networks.ts `currentGenesisPinTag()`. */
const pinTag = () =>
  `${TESTNET_GENESIS_HASH.toLowerCase()}|${TESTNET_BLOCK0_HASH.toLowerCase()}`;

interface StorageMap {
  [k: string]: unknown;
}

function installChromeSessionStub(): { storage: StorageMap } {
  const storage: StorageMap = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: (key: string) =>
          Promise.resolve(key in storage ? { [key]: storage[key] } : {}),
        set: (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) storage[k] = v;
          return Promise.resolve();
        },
      },
    },
  };
  return { storage };
}

function installFetch(
  handler: (req: { method: string; params: unknown[] }) => Promise<unknown>,
) {
  globalThis.fetch = vi.fn(async (_url, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      method?: unknown;
      params?: unknown;
    };
    const body = await handler({
      method: typeof payload.method === "string" ? payload.method : "",
      params: Array.isArray(payload.params) ? payload.params : [],
    });
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const matchBody = () => ({
  jsonrpc: "2.0",
  id: 1,
  result: { genesisHash: TESTNET_GENESIS_HASH },
});

describe("genesis-cache persistence + C6 (R3) hardening", () => {
  const originalFetch = globalThis.fetch;
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeSessionStub());
    clearGenesisCache(); // empties in-memory + writes {pin, entries:{}} to the stub
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it("persists a DEFINITIVE verdict, pin-qualified", async () => {
    installFetch(async () => matchBody());
    await verifyOperatorGenesis(RPC);

    const blob = storage[SESSION_KEY] as {
      pin: string;
      entries: Record<string, { observed?: string }>;
    };
    expect(blob.pin).toBe(pinTag());
    expect(blob.entries?.[RPC]?.observed).toBe(TESTNET_GENESIS_HASH);
  });

  it("does NOT persist a non-definitive (observed === null) verdict", async () => {
    installFetch(async ({ method }) =>
      method === "lyth_chainStats"
        ? { jsonrpc: "2.0", id: 1, error: { message: "method not found" } }
        : { jsonrpc: "2.0", id: 1, result: null },
    );
    await verifyOperatorGenesis(RPC);

    const blob = storage[SESSION_KEY] as {
      entries?: Record<string, unknown>;
    };
    expect(blob.entries?.[RPC]).toBeUndefined();
  });

  it("rehydrates a CURRENT-pin verdict and (within the positive TTL) skips the probe", async () => {
    storage[SESSION_KEY] = {
      pin: pinTag(),
      entries: {
        [RPC]: { ok: true, observed: TESTNET_GENESIS_HASH, checkedAt: Date.now() },
      },
    };

    await rehydrateGenesisCache();
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(TESTNET_GENESIS_HASH);

    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called within the positive TTL");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T11 (R3): DROPS a blob persisted under a DIFFERENT pin — never trusts it, re-probes", async () => {
    storage[SESSION_KEY] = {
      pin: "0xOLDPIN|0xOLDBLOCK0",
      entries: {
        [RPC]: { ok: true, observed: "0xOLDPIN", checkedAt: Date.now() },
      },
    };

    await rehydrateGenesisCache();
    // The stale-pin verdict must NOT have been seeded.
    expect(snapshotGenesisCache().get(RPC)).toBeUndefined();

    // A subsequent verify therefore re-probes against the LIVE pin.
    let fetched = false;
    globalThis.fetch = vi.fn(async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => matchBody(),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(fetched).toBe(true);
  });

  it("T12 (R3): re-probes a POSITIVE verdict older than the bound (silent-fork detection)", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    installFetch(async () => matchBody());

    // Probe #1 → cached ok:true at t=1_000_000.
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Within the TTL → served from cache, NO re-probe.
    nowSpy.mockReturnValue(1_000_000 + 30_000);
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsAfterFirst);

    // Past the TTL → the positive verdict is re-validated (re-probe).
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(callsAfterFirst);
  });

  it("keeps a definitive MISMATCH sticky (no positive TTL applies to a fail)", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(2_000_000);
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        genesisHash:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    }));
    expect(await verifyOperatorGenesis(RPC)).toBe(false);
    const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // Long past any TTL → a definitive mismatch is still served from cache, NO
    // re-probe (it correctly keeps the wallet paused until resolved).
    nowSpy.mockReturnValue(2_000_000 + 10 * 60_000);
    expect(await verifyOperatorGenesis(RPC)).toBe(false);
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsAfterFirst);
  });

  it("clearGenesisCache mirrors the eviction into the persisted blob", async () => {
    installFetch(async () => matchBody());
    await verifyOperatorGenesis(RPC);
    expect(
      (storage[SESSION_KEY] as { entries: Record<string, unknown> }).entries[
        RPC
      ],
    ).toBeDefined();

    clearGenesisCache();
    expect(
      (storage[SESSION_KEY] as { entries: Record<string, unknown> }).entries[
        RPC
      ],
    ).toBeUndefined();
  });
});
