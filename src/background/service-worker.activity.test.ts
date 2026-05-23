// Integration coverage for the Phase 4.4 SW handlers:
//   - wallet-activity-get      (commit 5)
//   - wallet-resolve-names     (commit 6)
//   - wallet-indexer-status    (commit 7)
//   - persistPendingRowBackground side-effect of wallet-send-tx (commit 8)
//
// Strategy mirrors service-worker.eip1193.test.ts:
//   1. Stub the chrome.* surface (storage.local + storage.session +
//      runtime.onMessage + alarms + tabs + windows) before importing
//      the SW.
//   2. Mock @monolythium/core-sdk, ./keystore.js, ./keystore-mldsa.js,
//      ./approvals.js, ./tx-mldsa.js, ./networks.js so the SW boots
//      without any real RPC, real crypto, or real chain registry.
//   3. Capture the chrome.runtime.onMessage handler the SW registers
//      at module scope; drive it directly with synthetic `{ kind:
//      "popup", op, payload }` envelopes.
//   4. Pure logic of the schema (mergeIndexerSnapshot, reconcilePending,
//      validators) is already covered by shared/activity.test.ts and
//      shared/name-resolution.test.ts; this file covers what only the
//      SW boundary can reach — chrome.storage round-trip, RPC error
//      codes, fire-and-forget timing.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const DETERMINISTIC_ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const TESTNET_CHAIN_ID_HEX = "0x10F2C";

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — installed before the SW is imported.
// ─────────────────────────────────────────────────────────────────────────────

// Capture of sprintnetJsonRpc calls. Each test seeds responses keyed by
// JSON-RPC method; failures can be seeded with explicit error codes.
interface CapturedRpcCall {
  method: string;
  params: unknown[];
}
const rpcCalls: CapturedRpcCall[] = [];
let rpcResponses: Record<string, unknown> = {};
let rpcErrors: Record<string, { code: number; message: string }> = {};

vi.mock("./tx-mldsa.js", () => ({
  sprintnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
    rpcCalls.push({ method, params });
    if (rpcErrors[method] !== undefined) {
      const err = new Error(rpcErrors[method]!.message) as Error & { code: number };
      err.code = rpcErrors[method]!.code;
      throw err;
    }
    if (rpcResponses[method] !== undefined) {
      return { result: rpcResponses[method], via: "mock-operator" };
    }
    const err = new Error(`mock: no seeded response for ${method}`) as Error & {
      code: number;
    };
    err.code = -32601;
    throw err;
  }),
  sprintnetMaxBalanceConsensus: vi.fn(async (_address: string) => ({
    balanceHex: "0x0",
    contributing: [{ name: "mock-operator", balanceHex: "0x0" }],
    failing: [],
  })),
  submitEncryptedMlDsaTx: vi.fn(async () => {
    if (submitFailure !== null) {
      throw submitFailure;
    }
    return { txHash: SUBMITTED_TX_HASH, via: "mock-operator" };
  }),
}));

const SUBMITTED_TX_HASH = "0x" + "a".repeat(64);
let submitFailure: (Error & { code?: number }) | null = null;

// Networks: only the bits the handlers touch. Sprintnet chain id is
// "MlDsa" per the SW's gating helper; suggestFee returns a deterministic
// fee structure so wallet-send-tx can complete the broadcast preamble.
vi.mock("./networks.js", () => ({
  chainRequiresMlDsa: vi.fn((chainIdHex: string) =>
    chainIdHex.toUpperCase() === TESTNET_CHAIN_ID_HEX.toUpperCase(),
  ),
  SPRINTNET_TRANSFER_GAS_LIMIT_HEX: "0x5208",
  probeFirstAliveOperator: vi.fn(async () => ({ name: "mock", rpc: "http://mock" })),
  BUILTIN_CHAINS: [
    {
      chainId: TESTNET_CHAIN_ID_HEX,
      name: "Sprintnet",
      rpc: "http://mock",
      chainIdNum: 69420,
      official: true,
    },
  ],
  loadOperatorOverride: vi.fn(async () => undefined),
  setOperatorOverride: vi.fn(async () => undefined),
  readOperatorOverride: vi.fn(async () => null),
  getDefaultOperators: vi.fn(() => []),
  getActiveOperators: vi.fn(() => []),
}));

// Keystore (v2 + v4) — fixed unlocked address, never actually signs.
let unlocked = true;
vi.mock("./keystore.js", () => ({
  hasVault: vi.fn(async () => true),
  hasLegacyVault: vi.fn(async () => false),
  getStoredAddress: vi.fn(async () => DETERMINISTIC_ADDRESS),
  getUnlockedAddress: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  isUnlocked: vi.fn(() => unlocked),
  lock: vi.fn(() => {
    unlocked = false;
  }),
  unlock: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  personalSign: vi.fn(() => new Uint8Array(65)),
  signLegacyTx: vi.fn(() => "0x"),
  signTypedDataV4: vi.fn(() => new Uint8Array(65)),
  computeTypedDataDigest: vi.fn(() => new Uint8Array(32)),
}));

vi.mock("./keystore-mldsa.js", () => ({
  hasVaultV4: vi.fn(async () => true),
  getStoredAddressV4: vi.fn(async () => DETERMINISTIC_ADDRESS),
  getUnlockedAddressV4: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  isUnlockedV4: vi.fn(() => unlocked),
  unlockV4: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  lockV4: vi.fn(() => {
    unlocked = false;
  }),
  createVaultFromNewMnemonic: vi.fn(async () => ({
    mnemonic: "",
    address: DETERMINISTIC_ADDRESS,
  })),
  createVaultFromMnemonic: vi.fn(async () => ({
    address: DETERMINISTIC_ADDRESS,
  })),
  exportMnemonicV4: vi.fn(async () => ({ mnemonic: "" })),
  wipeVaultV4: vi.fn(async () => undefined),
  personalSignV4: vi.fn(() => new Uint8Array(65)),
  signTypedDataV4FromV4: vi.fn(() => new Uint8Array(65)),
}));

vi.mock("./approvals.js", () => ({
  enqueue: vi.fn(async () => ({ ok: true })),
  resolve: vi.fn(() => true),
  rejectByWindow: vi.fn(),
  getPending: vi.fn(() => null),
  listPending: vi.fn(() => []),
  clearPending: vi.fn(async () => {}),
  focusApproval: vi.fn(async () => ({ focused: false })),
}));

vi.mock("./connected-sites.js", () => ({
  loadConnectedSites: vi.fn(async () => ({})),
  saveConnectedSite: vi.fn(async () => undefined),
  removeConnectedSite: vi.fn(async () => undefined),
  clearAllConnectedSites: vi.fn(async () => undefined),
}));

vi.mock("@monolythium/core-sdk", () => ({
  MonolythiumProvider: class {
    async _send() {
      return [];
    }
  },
  MONOLYTHIUM_TESTNET_CHAIN_ID: 69420n,
  getRpcEndpoints: () => [
    { url: "http://test.invalid:8545", provider: "test", region: "test", tier: "official" },
  ],
  // GAP #11: shared/build-info.ts reads TESTNET_69420.genesis_hash at
  // module init; stub just the fields the wallet actually reads.
  TESTNET_69420: {
    chain_id: 69420,
    genesis_hash:
      "0x325057e476b7be3730a22c92b9289f4a14a3414a2a081bd279b43eeba36b0075",
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// chrome.* stub
// ─────────────────────────────────────────────────────────────────────────────

type OnMessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let capturedOnMessage: OnMessageHandler | null = null;
const onChangedListeners: Array<
  (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void
> = [];
let storageLocal: Record<string, unknown> = {};
let storageSession: Record<string, unknown> = {};

function makeStorageArea(map: () => Record<string, unknown>, areaName: string) {
  return {
    get: (
      keys: string | string[] | null,
      cb?: (res: Record<string, unknown>) => void,
    ) => {
      const list = keys === null ? null : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      const m = map();
      if (list === null) {
        Object.assign(out, m);
      } else {
        for (const k of list) {
          if (k in m) out[k] = m[k];
        }
      }
      if (cb) {
        queueMicrotask(() => cb(out));
        return Promise.resolve(out);
      }
      return Promise.resolve(out);
    },
    set: (entries: Record<string, unknown>, cb?: () => void) => {
      const m = map();
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const [k, v] of Object.entries(entries)) {
        changes[k] = { oldValue: m[k], newValue: v };
        m[k] = v;
      }
      for (const listener of onChangedListeners) listener(changes, areaName);
      if (cb) queueMicrotask(() => cb());
      return Promise.resolve();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      const m = map();
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete m[k];
      if (cb) queueMicrotask(() => cb());
      return Promise.resolve();
    },
  };
}

function installChromeStub(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: makeStorageArea(() => storageLocal, "local"),
      session: makeStorageArea(() => storageSession, "session"),
      onChanged: {
        addListener: (l: (typeof onChangedListeners)[number]) => {
          onChangedListeners.push(l);
        },
        removeListener: vi.fn(),
      },
    },
    alarms: {
      onAlarm: { addListener: vi.fn() },
      create: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve(true)),
    },
    runtime: {
      onMessage: {
        addListener: (handler: OnMessageHandler) => {
          capturedOnMessage = handler;
        },
      },
      onInstalled: { addListener: vi.fn() },
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    tabs: {
      query: (_f: unknown, cb: (tabs: unknown[]) => void) => {
        cb([]);
      },
      sendMessage: vi.fn(),
    },
    windows: {
      create: vi.fn(() => Promise.resolve({ id: 1 })),
      onRemoved: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(() => Promise.resolve()),
      setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test driver
// ─────────────────────────────────────────────────────────────────────────────

interface PopupEnvelope {
  kind: "popup";
  op: string;
  payload?: unknown;
}

async function dispatchPopup(envelope: PopupEnvelope): Promise<unknown> {
  if (!capturedOnMessage) throw new Error("SW did not register onMessage handler");
  return new Promise((resolve) => {
    capturedOnMessage!(envelope, {}, resolve);
  });
}

beforeAll(async () => {
  installChromeStub();
  await import("./service-worker.js");
  if (!capturedOnMessage) {
    throw new Error("SW failed to register chrome.runtime.onMessage handler");
  }
});

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResponses = {};
  rpcErrors = {};
  submitFailure = null;
  unlocked = true;
  storageLocal = {};
  storageSession = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-activity-get
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-activity-get", () => {
  it("rejects non-Sprintnet chain ids", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: "0x1" },
    })) as { ok: false; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Sprintnet");
  });

  it("first call: fetches, validates, merges, persists", async () => {
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [
      {
        blockHeight: 100,
        txIndex: 0,
        logIndex: 0,
        kind: "transfer",
        direction: "out",
        counterparty: "0xdead",
        tokenId: null,
        amount: "1.5",
        cluster: null,
        weightBps: null,
        subKind: null,
      },
    ];
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; cache: { confirmed: Array<{ kind: string }> } };
    expect(r.ok).toBe(true);
    expect(r.cache.confirmed).toHaveLength(1);
    expect(r.cache.confirmed[0]?.kind).toBe("tx_send");
    // Persisted to chrome.storage.local under the per-(addr, chain) key.
    const key =
      `mono.activity.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    expect(storageLocal[key]).toBeDefined();
  });

  it("second call within staleness window: serves from cache, no RPC", async () => {
    // Seed: first call populates the cache.
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];
    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    const firstFetchCount = rpcCalls.length;
    expect(firstFetchCount).toBe(4); // tokenBalances + addressLabel + delegationHistory + addressActivity
    // Second call immediately after — cache is fresh, should NOT hit RPC.
    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    expect(rpcCalls.length).toBe(firstFetchCount); // unchanged — no new RPC fired
  });

  it("preserves prev cache when BOTH activity and delegation streams fail", async () => {
    // Seed cache with a row.
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [
      {
        blockHeight: 100,
        txIndex: 0,
        logIndex: 0,
        kind: "transfer",
        direction: "in",
        counterparty: "0xdead",
        tokenId: null,
        amount: "5",
        cluster: null,
        weightBps: null,
        subKind: null,
      },
    ];
    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    // Force staleness by aging the lastFetchedAtMs.
    const key =
      `mono.activity.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    const stored = storageLocal[key] as {
      confirmed: unknown[];
      lastFetchedAtMs: number;
    };
    storageLocal[key] = { ...stored, lastFetchedAtMs: stored.lastFetchedAtMs - 60_000 };
    // Now make BOTH streams fail.
    rpcErrors["lyth_getDelegationHistory"] = { code: -32603, message: "down" };
    rpcErrors["lyth_getAddressActivity"] = { code: -32603, message: "down" };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      cache: { confirmed: Array<{ kind: string }> };
      errors: Record<string, string>;
    };
    expect(r.ok).toBe(true);
    // Prev cache preserved (one row survives), errors map surfaced.
    expect(r.cache.confirmed).toHaveLength(1);
    expect(r.errors.addressActivity).toBeDefined();
    expect(r.errors.delegationHistory).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-resolve-names
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-resolve-names", () => {
  it("dedupes + lowercases input addresses", async () => {
    rpcResponses["lyth_getAddressLabel"] = null;
    await dispatchPopup({
      kind: "popup",
      op: "wallet-resolve-names",
      payload: {
        addresses: ["0xABC", "0xabc", "0xABC", "0xdef"],
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    });
    // 0xABC + 0xabc collapse to one address; 0xdef is a second. Two
    // lyth_getAddressLabel calls expected.
    const labelCalls = rpcCalls.filter((c) => c.method === "lyth_getAddressLabel");
    expect(labelCalls).toHaveLength(2);
  });

  it("trips method-gate on -32601 and skips RPC on subsequent miss", async () => {
    rpcErrors["lyth_getAddressLabel"] = { code: -32601, message: "Method not found" };
    await dispatchPopup({
      kind: "popup",
      op: "wallet-resolve-names",
      payload: { addresses: ["0xabc"], chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    const firstCount = rpcCalls.filter(
      (c) => c.method === "lyth_getAddressLabel",
    ).length;
    expect(firstCount).toBe(1);
    // Second call with a DIFFERENT address (cache miss) — gate should
    // short-circuit, no new RPC.
    await dispatchPopup({
      kind: "popup",
      op: "wallet-resolve-names",
      payload: { addresses: ["0xdef"], chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    const secondCount = rpcCalls.filter(
      (c) => c.method === "lyth_getAddressLabel",
    ).length;
    expect(secondCount).toBe(1); // unchanged — gate prevented RPC
    expect(storageLocal["mono.names.method-gate"]).toBeDefined();
  });

  it("serves cache hits even when method-gate is tripped", async () => {
    // Populate cache with a real label.
    rpcResponses["lyth_getAddressLabel"] = {
      address: "0xabc",
      category: "foundation",
      displayName: "Foundation-1",
      updatedAtBlock: 1,
    };
    await dispatchPopup({
      kind: "popup",
      op: "wallet-resolve-names",
      payload: { addresses: ["0xabc"], chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    // Now flip to method-not-found and ask again — the cached hit must
    // still return regardless of gate state.
    rpcErrors["lyth_getAddressLabel"] = { code: -32601, message: "Method not found" };
    delete rpcResponses["lyth_getAddressLabel"];
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-resolve-names",
      payload: { addresses: ["0xabc"], chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      resolved: Record<string, { displayName?: string } | null>;
    };
    expect(r.resolved["0xabc"]).toBeTruthy();
    expect(r.resolved["0xabc"]?.displayName).toBe("Foundation-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-indexer-status
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-indexer-status", () => {
  it("returns stale=true when lag exceeds threshold", async () => {
    rpcResponses["lyth_indexerStatus"] = {
      currentHeight: 1000,
      latestHeight: 1050,
      schemaVersion: 1,
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; stale: boolean; lagBlocks: number | null };
    expect(r.ok).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.lagBlocks).toBe(50);
  });

  it("returns stale=false when lag is within threshold", async () => {
    rpcResponses["lyth_indexerStatus"] = {
      currentHeight: 1000,
      latestHeight: 1005,
      schemaVersion: 1,
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; stale: boolean; lagBlocks: number };
    expect(r.stale).toBe(false);
    expect(r.lagBlocks).toBe(5);
  });

  it("method-not-found returns defensive { stale: false, lagBlocks: null }", async () => {
    rpcErrors["lyth_indexerStatus"] = { code: -32601, message: "Method not found" };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      stale: boolean;
      lagBlocks: number | null;
      currentHeight: number | null;
      latestHeight: number | null;
    };
    expect(r.ok).toBe(true);
    expect(r.stale).toBe(false); // critical: NOT a false-positive banner
    expect(r.lagBlocks).toBeNull();
    expect(r.currentHeight).toBeNull();
    expect(r.latestHeight).toBeNull();
    // Method gate is tripped — distinct storage key from names gate.
    expect(storageLocal["mono.indexerStatus.method-gate"]).toBeDefined();
    expect(storageLocal["mono.names.method-gate"]).toBeUndefined();
  });

  it("recovers when method becomes available — gate is cleared on success", async () => {
    rpcErrors["lyth_indexerStatus"] = { code: -32601, message: "Method not found" };
    await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    expect(storageLocal["mono.indexerStatus.method-gate"]).toBeDefined();
    // Wait out the gate by aging it manually (test driver doesn't run real clocks).
    // Must include `supported: false` so readMethodGate's validator accepts the
    // entry — without it, the handler reads an empty gate and the recovery
    // branch (which clears the entry) never fires.
    const gateKey = "mono.indexerStatus.method-gate";
    const gate = storageLocal[gateKey] as Record<
      string,
      { supported: false; checkedAtMs: number }
    >;
    gate[TESTNET_CHAIN_ID_HEX] = {
      supported: false,
      checkedAtMs: Date.now() - 10 * 60 * 1000,
    };
    // Method comes back.
    delete rpcErrors["lyth_indexerStatus"];
    rpcResponses["lyth_indexerStatus"] = {
      currentHeight: 100,
      latestHeight: 100,
      schemaVersion: 1,
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; stale: boolean; currentHeight: number | null };
    expect(r.currentHeight).toBe(100);
    // Gate cleared after the successful call.
    const afterGate = storageLocal[gateKey] as Record<string, unknown>;
    expect(afterGate[TESTNET_CHAIN_ID_HEX]).toBeUndefined();
  });

  it("malformed indexer response returns defensive default WITHOUT tripping gate", async () => {
    // Method responding with garbage is a transient error, not a missing
    // method. Defensive return, but no gate trip.
    rpcResponses["lyth_indexerStatus"] = { not_what_we_expect: 1 };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-status",
      payload: { chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; stale: boolean };
    expect(r.stale).toBe(false);
    expect(storageLocal["mono.indexerStatus.method-gate"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-send-tx → persistPendingRowBackground (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-send-tx pending-row prepend", () => {
  it("successful broadcast writes a pending row", async () => {
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };
    rpcResponses["eth_blockNumber"] = "0x64"; // 100
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x989680", // 0.1 LYTH in lythoshi
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    })) as { ok: true; txHash: string };
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe(SUBMITTED_TX_HASH);
    // The fire-and-forget write is on the microtask queue. Yield once to
    // let it settle, then assert.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const pendingKey =
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    const persisted = storageLocal[pendingKey] as {
      pending: Array<{
        kind: string;
        txHash: string;
        to: string;
        amountDecimal: string;
        broadcastBlockHeight: number | null;
      }>;
    };
    expect(persisted).toBeDefined();
    expect(persisted.pending).toHaveLength(1);
    expect(persisted.pending[0]?.kind).toBe("pending_tx");
    expect(persisted.pending[0]?.txHash).toBe(SUBMITTED_TX_HASH);
    expect(persisted.pending[0]?.to).toBe("0xrecipient");
    expect(persisted.pending[0]?.amountDecimal).toBe("0.1");
    expect(persisted.pending[0]?.broadcastBlockHeight).toBe(100);
  });

  it("FAILED broadcast does NOT write a pending row", async () => {
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };
    submitFailure = new Error("broadcast rejected") as Error & { code: number };
    submitFailure.code = -32003;
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x989680",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    })) as { ok: false; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("broadcast rejected");
    // Yield any pending microtasks — there should be none from the
    // pending writer (it was never reached).
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const pendingKey =
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    expect(storageLocal[pendingKey]).toBeUndefined();
  });

  it("fire-and-forget timing: send-tx reply resolves BEFORE pending storage write completes", async () => {
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };
    // Make eth_blockNumber slow so the pending writer is provably still
    // running when the send-tx reply has already resolved. Resolve order
    // of two promises is the explicit assertion — no setTimeout polling.
    let resolveBlock: ((v: { result: string }) => void) | null = null;
    rpcResponses["eth_blockNumber"] = new Promise<{ result: string }>((res) => {
      resolveBlock = res;
    });
    const observed: string[] = [];
    const sendPromise = dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x989680",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    }).then(() => {
      observed.push("send-tx-reply");
    });
    // The send-tx reply should resolve without waiting on
    // eth_blockNumber. If the pending writer were awaited, send-tx-reply
    // would only push to `observed` after we resolve the block-number
    // promise — and the test would deadlock here.
    await sendPromise;
    expect(observed).toEqual(["send-tx-reply"]);
    // Now resolve the block fetch. The pending write completes on the
    // microtask after this resolves. Yield enough to let it settle.
    resolveBlock!({ result: "0x64" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // Confirm the pending write did eventually land (just not blocking
    // the reply).
    const pendingKey =
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    expect(storageLocal[pendingKey]).toBeDefined();
  });

  it("eth_blockNumber failure → broadcastBlockHeight is null (TTL-only eviction path)", async () => {
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };
    rpcErrors["eth_blockNumber"] = { code: -32603, message: "down" };
    await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x989680",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const pendingKey =
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    const persisted = storageLocal[pendingKey] as {
      pending: Array<{ broadcastBlockHeight: number | null }>;
    };
    expect(persisted).toBeDefined();
    expect(persisted.pending[0]?.broadcastBlockHeight).toBeNull();
  });
});
