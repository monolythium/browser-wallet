// Genesis-cache persistence across SW hibernation.
//
// The audit's orphan-fork pinning (be73670) put a genesis check after the
// old net_version-only probe — up to two extra sequential round-trips per
// operator. The verdict was cached in-memory ONLY, so every ~30 s SW
// hibernation wiped it and each wallet reopen re-paid the round-trips.
//
// These cover the fix: a DEFINITIVE verdict is persisted to
// chrome.storage.session and rehydrated on the next SW boot, so the first
// probe after a cold wake reads from cache instead of re-probing. A
// NON-definitive ("couldn't read") verdict must NOT persist (it keeps its
// short TTL and re-probes so a transient blip self-heals), and clearing the
// cache must mirror into the persisted blob (so a force-refresh after a
// regenesis can't rehydrate a stale verdict).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGenesisCache,
  rehydrateGenesisCache,
  snapshotGenesisCache,
  verifyOperatorGenesis,
} from "./networks.js";
import { TESTNET_GENESIS_HASH } from "../shared/build-info.js";

const SESSION_KEY = "mono.session.genesis-cache.v1";
const RPC = "http://persist-operator.invalid:8545";

interface StorageMap {
  [k: string]: unknown;
}

/** Promise-based chrome.storage.session stub (the MV3 shape the module uses).
 *  Mutates the backing record synchronously inside set() so the fire-and-forget
 *  persist is observable right after the awaited call that triggered it. */
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
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("genesis-cache persistence", () => {
  const originalFetch = globalThis.fetch;
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeSessionStub());
    clearGenesisCache(); // empties in-memory + writes {} to the stub
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("persists a DEFINITIVE verdict to chrome.storage.session", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { genesisHash: TESTNET_GENESIS_HASH },
    }));

    await verifyOperatorGenesis(RPC);

    const blob = storage[SESSION_KEY] as Record<string, { observed?: string }>;
    expect(blob?.[RPC]?.observed).toBe(TESTNET_GENESIS_HASH);
  });

  it("does NOT persist a non-definitive (observed === null) verdict", async () => {
    // lyth_chainStats unsupported + block 0 result null → probe-not-supported,
    // observed === null. This must keep its short TTL, not survive a wake.
    installFetch(async ({ method }) =>
      method === "lyth_chainStats"
        ? { jsonrpc: "2.0", id: 1, error: { message: "method not found" } }
        : { jsonrpc: "2.0", id: 1, result: null },
    );

    await verifyOperatorGenesis(RPC);

    const blob = storage[SESSION_KEY] as Record<string, unknown> | undefined;
    expect(blob?.[RPC]).toBeUndefined();
  });

  it("rehydrates a persisted verdict and skips the genesis round-trips", async () => {
    // Simulate a prior SW lifetime: a definitive verdict sits in session
    // storage while the in-memory cache is empty (cleared in beforeEach).
    storage[SESSION_KEY] = {
      [RPC]: { ok: true, observed: TESTNET_GENESIS_HASH, checkedAt: 1 },
    };

    await rehydrateGenesisCache();
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(TESTNET_GENESIS_HASH);

    // A subsequent verify must read the rehydrated cache, NOT hit the network.
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called after rehydrate");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clearGenesisCache mirrors the eviction into the persisted blob", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { genesisHash: TESTNET_GENESIS_HASH },
    }));
    await verifyOperatorGenesis(RPC);
    expect((storage[SESSION_KEY] as Record<string, unknown>)?.[RPC]).toBeDefined();

    clearGenesisCache();
    expect((storage[SESSION_KEY] as Record<string, unknown>)?.[RPC]).toBeUndefined();
  });
});
