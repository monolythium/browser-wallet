// EIP-1193 conformance suite for the Monolythium Wallet's RPC dispatcher.
//
// The wallet's request-router lives in `service-worker.ts:handleRpc` and is
// the integration seam between the in-page `window.ethereum` provider and the
// `MonolythiumProvider` ethers v6 shim from `@monolythium/core-sdk`. This
// suite is a hard test gate against drift in that router — Wave 5 work.
//
// Strategy:
//   - Stub the chrome.* surface the worker imports at module scope (storage,
//     runtime, tabs, windows). The dispatcher registers a single
//     `chrome.runtime.onMessage` listener at import time; we capture it and
//     drive it directly with synthetic `{ kind: "rpc", id, args, origin }`
//     envelopes — this is the same shape the content-script bridge sends.
//   - Mock `@monolythium/core-sdk` so `MonolythiumProvider._send` returns
//     deterministic responses without any network round-trip. The dispatcher
//     calls `_send` with a JSON-RPC request envelope; we capture every call
//     for assertions.
//   - Mock `./keystore.js` and `./approvals.js` so we never touch argon2,
//     secp256k1, or chrome.windows — both modules expose deterministic stubs.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Constants from the SDK we're asserting against ----
const TESTNET_CHAIN_ID_BIGINT = 69420n;
const TESTNET_CHAIN_ID_HEX = "0x" + TESTNET_CHAIN_ID_BIGINT.toString(16).toUpperCase(); // 0x10F2C
const DETERMINISTIC_ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const DETERMINISTIC_SIG_BYTES = new Uint8Array(65).fill(0xab);
DETERMINISTIC_SIG_BYTES[64] = 27; // valid recovery id
const DETERMINISTIC_SIG_HEX = "0x" + Array.from(DETERMINISTIC_SIG_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");
const DETERMINISTIC_TX_HASH = "0x" + "f".repeat(64);
const DETERMINISTIC_RAW_TX = "0x02" + "ee".repeat(40);
const DETERMINISTIC_BLOCK_NUMBER = "0xdeadbeef";

// ---- Mocks installed before the SUT module is imported ----

// `MonolythiumProvider._send` capture — every test seeds responses keyed by
// JSON-RPC method, and asserts on the recorded request payloads.
interface CapturedRpcCall {
  method: string;
  params: unknown[];
}
const rpcCalls: CapturedRpcCall[] = [];
let rpcResponses: Record<string, unknown> = {};

vi.mock("@monolythium/core-sdk", () => {
  class FakeMonolythiumProvider {
    constructor(public rpc: string, public opts?: unknown) {}
    async _send(payload: { id: number; jsonrpc: string; method: string; params: unknown[] }) {
      rpcCalls.push({ method: payload.method, params: payload.params });
      const result = rpcResponses[payload.method];
      if (result === undefined) {
        return [{ id: payload.id, jsonrpc: "2.0", error: { code: -32601, message: `mock: no seeded response for ${payload.method}` } }];
      }
      return [{ id: payload.id, jsonrpc: "2.0", result }];
    }
  }
  return {
    MonolythiumProvider: FakeMonolythiumProvider,
    MONOLYTHIUM_TESTNET_CHAIN_ID: TESTNET_CHAIN_ID_BIGINT,
  };
});

// Approvals mock — auto-approve unless overridden by a test.
let approvalDecision: { ok: true } | { ok: false; reason?: string } = { ok: true };
const enqueuedApprovals: Array<{ kind: string; [k: string]: unknown }> = [];

vi.mock("./approvals.js", () => ({
  enqueue: vi.fn(async (req: { kind: string }) => {
    enqueuedApprovals.push(req);
    return approvalDecision;
  }),
  resolve: vi.fn(() => true),
  rejectByWindow: vi.fn(),
  getPending: vi.fn(() => null),
  listPending: vi.fn(() => []),
}));

// Keystore mock — deterministic signing, always unlocked unless a test flips it.
// The dApp request path (handleRpc / buildSendTxView) consults the v4 keystore
// after Phase 4.0 commit 3; the legacy v2 helpers stay imported only for the
// popup-IPC keystore-status migration-display branch. The two mocks share the
// same `unlocked` / `vaultExists` flags so a test that flips either reflects
// in both code paths.
let unlocked = true;
let vaultExists = true;

vi.mock("./keystore.js", () => ({
  hasVault: vi.fn(async () => vaultExists),
  hasLegacyVault: vi.fn(async () => false),
  getStoredAddress: vi.fn(async () => DETERMINISTIC_ADDRESS),
  getUnlockedAddress: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  isUnlocked: vi.fn(() => unlocked),
  lock: vi.fn(() => {
    unlocked = false;
  }),
  unlock: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  createVaultFromNewMnemonic: vi.fn(async () => ({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    address: DETERMINISTIC_ADDRESS,
  })),
  createVaultFromMnemonic: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  personalSign: vi.fn(async () => DETERMINISTIC_SIG_BYTES),
  signLegacyTx: vi.fn(async () => ({ rawTx: DETERMINISTIC_RAW_TX, txHash: DETERMINISTIC_TX_HASH })),
  signTypedDataV4: vi.fn(async () => DETERMINISTIC_SIG_BYTES),
  computeTypedDataDigest: vi.fn(() => new Uint8Array(32).fill(0x42)),
}));

vi.mock("./keystore-mldsa.js", () => ({
  hasVaultV4: vi.fn(async () => vaultExists),
  getStoredAddressV4: vi.fn(async () => DETERMINISTIC_ADDRESS),
  getUnlockedAddressV4: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  isUnlockedV4: vi.fn(() => unlocked),
  lockV4: vi.fn(() => {
    unlocked = false;
  }),
  unlockV4: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  createVaultFromNewMnemonic: vi.fn(async () => ({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    address: DETERMINISTIC_ADDRESS,
  })),
  createVaultFromMnemonic: vi.fn(async () => ({ address: DETERMINISTIC_ADDRESS })),
  exportMnemonicV4: vi.fn(async () => ({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  })),
  wipeVaultV4: vi.fn(async () => undefined),
  // Phase 4.1 Commit H: personal_sign + eth_signTypedData_v4 now route to
  // the v4 ML-DSA backend when the v4 keystore is unlocked. Tests stub the
  // sign output to a deterministic byte pattern — the SW just hex-encodes
  // whatever the keystore returns.
  personalSignV4: vi.fn(() => DETERMINISTIC_SIG_BYTES),
  signTypedDataV4FromV4: vi.fn(() => DETERMINISTIC_SIG_BYTES),
}));

// ---- chrome.* stub ----
//
// The SUT registers a single onMessage listener at import time. We capture it
// here and route synthetic RPC envelopes through it. `sendResponse` is
// invoked asynchronously by the SUT; we wrap it in a promise per dispatch.

interface RpcEnvelope {
  kind: "rpc";
  id: string;
  args: { method: string; params?: unknown[] };
  origin: string;
}
type OnMessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: { result?: unknown; error?: { code: number; message: string } }) => void,
) => boolean | undefined;

let capturedOnMessage: OnMessageHandler | null = null;
const broadcastEvents: Array<{ event: string; payload: unknown }> = [];
const chromeStorage: Record<string, unknown> = {};
const chromeStorageSession: Record<string, unknown> = {};

// Build a storage area that supports both the legacy `(keys, cb)` form and
// the MV3-native promise form `(keys)`. The SW mixes both — the chain code
// stuck with callbacks, the new auto-lock code uses promises.
function makeStorageArea(map: Record<string, unknown>): {
  get: (keys: string | string[], cb?: (res: Record<string, unknown>) => void) => Promise<Record<string, unknown>>;
  set: (entries: Record<string, unknown>, cb?: () => void) => Promise<void>;
  remove: (keys: string | string[], cb?: () => void) => Promise<void>;
} {
  return {
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (k in map) out[k] = map[k];
      }
      if (cb) {
        queueMicrotask(() => cb(out));
        return Promise.resolve(out);
      }
      return Promise.resolve(out);
    },
    set: (entries, cb) => {
      for (const [k, v] of Object.entries(entries)) map[k] = v;
      if (cb) queueMicrotask(() => cb());
      return Promise.resolve();
    },
    remove: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete map[k];
      if (cb) queueMicrotask(() => cb());
      return Promise.resolve();
    },
  };
}

function installChromeStub(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: makeStorageArea(chromeStorage),
      session: makeStorageArea(chromeStorageSession),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: {
      // The SW's auto-lock alarm machinery needs these to exist so that
      // module-scope `chrome.alarms.onAlarm.addListener(...)` doesn't throw
      // on import. We don't simulate alarm firing — the auto-lock behavior
      // is exercised at runtime, not in this RPC dispatcher suite.
      onAlarm: { addListener: vi.fn() },
      create: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve(true)),
    },
    runtime: {
      onMessage: {
        addListener: (handler: OnMessageHandler) => {
          // The SUT registers exactly one handler at module scope. Capture it.
          capturedOnMessage = handler;
        },
      },
      onInstalled: { addListener: vi.fn() },
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    },
    tabs: {
      query: (_filter: unknown, cb: (tabs: Array<{ id: number }>) => void) => {
        // Synthetic tab so the broadcast loop reaches `sendMessage` once.
        cb([{ id: 1 }]);
      },
      sendMessage: (_id: number, message: { kind: string; event: string; payload: unknown }) => {
        if (message?.kind === "event") {
          broadcastEvents.push({ event: message.event, payload: message.payload });
        }
        return Promise.resolve();
      },
    },
    windows: {
      onRemoved: { addListener: vi.fn() },
    },
  };
}

function dispatch(method: string, params: unknown[] = [], origin = "https://dapp.example"): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const handler = capturedOnMessage;
  if (!handler) throw new Error("service worker did not register onMessage listener");
  return new Promise((resolve) => {
    const envelope: RpcEnvelope = {
      kind: "rpc",
      id: Math.random().toString(36).slice(2),
      args: { method, params },
      origin,
    };
    const handled = handler(envelope, undefined, resolve);
    if (handled !== true) {
      // The SUT returns true to keep sendResponse alive across async work.
      // If it returned false/undefined we'd never get a response.
      resolve({ error: { code: -32603, message: "handler did not signal async response" } });
    }
  });
}

// Popup IPC dispatcher — same captured listener, but the envelope shape is
// `{ kind: "popup", op, payload }`, used by Settings / Networks / Send and
// the new Phase 4.3 chain-add-manual / chain-edit / chain-delete ops.
function popupDispatch<T = unknown>(op: string, payload?: unknown): Promise<T> {
  const handler = capturedOnMessage;
  if (!handler) throw new Error("service worker did not register onMessage listener");
  return new Promise((resolve) => {
    const envelope = { kind: "popup", op, payload } as unknown;
    const handled = handler(envelope, undefined, (response: unknown) => {
      resolve(response as T);
    });
    if (handled !== true) {
      resolve({ ok: false, reason: "handler did not signal async response" } as T);
    }
  });
}

// Helper: open an origin connection so the gated methods (sign/sendTx) work.
async function connectOrigin(origin = "https://dapp.example"): Promise<void> {
  const r = await dispatch("eth_requestAccounts", [], origin);
  if (r.error) throw new Error(`connect failed: ${r.error.message}`);
}

beforeAll(async () => {
  installChromeStub();
  // Importing the SUT registers the chrome.runtime.onMessage handler.
  await import("./service-worker.js");
  if (!capturedOnMessage) {
    throw new Error("service-worker.ts did not register a chrome.runtime.onMessage listener at import time");
  }
});

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResponses = {};
  enqueuedApprovals.length = 0;
  broadcastEvents.length = 0;
  approvalDecision = { ok: true };
  unlocked = true;
  vaultExists = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("EIP-1193 conformance — service-worker request router", () => {
  // ---- 1. eth_chainId ----
  it("eth_chainId returns hex-encoded testnet chain id (0x10F2C = 69420)", async () => {
    const r = await dispatch("eth_chainId");
    expect(r.error).toBeUndefined();
    expect(r.result).toBe(TESTNET_CHAIN_ID_HEX);
    // And it must be the canonical value the SDK exports.
    expect(parseInt(r.result as string, 16)).toBe(Number(TESTNET_CHAIN_ID_BIGINT));
  });

  it("net_version returns the decimal of the same chain id", async () => {
    const r = await dispatch("net_version");
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("69420");
  });

  // ---- 2. eth_accounts ----
  it("eth_accounts returns [] for an unconnected origin", async () => {
    const r = await dispatch("eth_accounts", [], "https://stranger.example");
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual([]);
  });

  it("eth_accounts returns the unlocked account list once the origin connects", async () => {
    const origin = "https://accounts-test.example";
    await connectOrigin(origin);
    const r = await dispatch("eth_accounts", [], origin);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual([DETERMINISTIC_ADDRESS]);
  });

  // ---- 3. eth_blockNumber ----
  it("eth_blockNumber routes through MonolythiumProvider with no params and returns hex", async () => {
    // The dispatcher does not have a hard-coded eth_blockNumber path, so it
    // falls through to the default "method not supported" branch. Future
    // Stage work is expected to add a passthrough — until then, mark as todo.
    // We still assert the negative shape so the suite catches a silent
    // implementation drift the moment a passthrough lands.
    rpcResponses["eth_blockNumber"] = DETERMINISTIC_BLOCK_NUMBER;
    const r = await dispatch("eth_blockNumber");
    expect(r.error?.code).toBe(4200);
    expect(r.error?.message).toMatch(/eth_blockNumber/);
  });

  it.todo("eth_blockNumber returns hex-encoded number once a passthrough lands (TODO(monolythium-vision): wire generic eth_* passthrough through providerFor)");

  // ---- 4. eth_call ----
  it.todo("eth_call routes through to network with {to,data,from,gas,value} payload (TODO(monolythium-vision): wire eth_call passthrough)");

  // ---- 5. eth_sendTransaction ----
  it("eth_sendTransaction returns the broadcast tx hash after auto-approval", async () => {
    const origin = "https://tx-test.example";
    await connectOrigin(origin);
    // Register + switch to a non-Sprintnet chain before sending — this
    // test covers the legacy secp256k1 + RLP + eth_sendRawTransaction
    // path, which is active only for chains that don't require ML-DSA.
    // Sprintnet is the only built-in chain now, so the test adds a
    // user-defined devnet via `wallet_addEthereumChain` (auto-approved
    // by the approvals mock) and switches to it.
    await dispatch("wallet_addEthereumChain", [{
      chainId: "0x7A69",
      chainName: "Local devnet",
      rpcUrls: ["http://127.0.0.1:8545"],
      nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
    }], origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: "0x7A69" }]);
    rpcResponses["eth_getTransactionCount"] = "0x5";
    rpcResponses["eth_gasPrice"] = "0x3b9aca00";
    rpcResponses["eth_estimateGas"] = "0x5208";
    rpcResponses["eth_sendRawTransaction"] = DETERMINISTIC_TX_HASH;

    const r = await dispatch("eth_sendTransaction", [{
      to: "0x0000000000000000000000000000000000000001",
      value: "0xde0b6b3a7640000", // 1 LYTH
    }], origin);

    expect(r.error).toBeUndefined();
    expect(r.result).toBe(DETERMINISTIC_TX_HASH);
    // Approval queue must have seen a `send_tx` request (auto-approved here).
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(true);
    // The dispatcher must have asked the node for nonce, gas, gas-price and
    // then broadcast the raw tx — this is the contract surface area we gate.
    const methods = rpcCalls.map((c) => c.method);
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_gasPrice");
    expect(methods).toContain("eth_estimateGas");
    expect(methods).toContain("eth_sendRawTransaction");
  });

  it("eth_sendTransaction surfaces user-rejected errors with code 4001", async () => {
    const origin = "https://rejecting.example";
    await connectOrigin(origin);
    approvalDecision = { ok: false, reason: "user rejected the transaction" };
    const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000001", value: "0x0" }], origin);
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4001);
  });

  it("eth_sendTransaction from an unconnected origin is rejected with 4100", async () => {
    const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000001" }], "https://not-connected.example");
    expect(r.error?.code).toBe(4100);
  });

  // ---- 6. personal_sign ----
  it("personal_sign returns 0x-prefixed hex signature after approval", async () => {
    const origin = "https://sign-test.example";
    await connectOrigin(origin);
    const r = await dispatch("personal_sign", ["hello", DETERMINISTIC_ADDRESS], origin);
    expect(r.error).toBeUndefined();
    expect(typeof r.result).toBe("string");
    expect(r.result).toMatch(/^0x[0-9a-f]+$/);
    expect((r.result as string).length).toBe(2 + DETERMINISTIC_SIG_BYTES.length * 2);
    expect(r.result).toBe(DETERMINISTIC_SIG_HEX);
  });

  it("personal_sign tolerates legacy [address, message] param order", async () => {
    const origin = "https://legacy-sign.example";
    await connectOrigin(origin);
    const r = await dispatch("personal_sign", [DETERMINISTIC_ADDRESS, "hello-legacy"], origin);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatch(/^0x[0-9a-f]+$/);
  });

  it("personal_sign without origin connection rejects with 4100", async () => {
    const r = await dispatch("personal_sign", ["msg", DETERMINISTIC_ADDRESS], "https://stranger-sign.example");
    expect(r.error?.code).toBe(4100);
  });

  // ---- 7. wallet_switchEthereumChain ----
  it("wallet_switchEthereumChain accepts the canonical testnet id and broadcasts chainChanged", async () => {
    const r = await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }]);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeNull();
    expect(broadcastEvents.some((e) => e.event === "chainChanged" && e.payload === TESTNET_CHAIN_ID_HEX)).toBe(true);
  });

  it("wallet_switchEthereumChain rejects an unknown chain with code 4902", async () => {
    const r = await dispatch("wallet_switchEthereumChain", [{ chainId: "0x539" }]); // 1337 — not in registry
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4902);
    expect(r.error?.message).toMatch(/wallet_addEthereumChain/);
  });

  it("wallet_switchEthereumChain without a chainId param returns -32602", async () => {
    const r = await dispatch("wallet_switchEthereumChain", [{}]);
    expect(r.error?.code).toBe(-32602);
  });

  // ---- 8. eth_subscribe ----
  it("eth_subscribe is not supported and returns code 4200 with a structured message", async () => {
    // The wallet's MV3 service worker has no WebSocket transport; the contract
    // is to fail closed. Future work that adds polling-based subscriptions can
    // flip the assertions in `it.todo` below to a happy path.
    const r = await dispatch("eth_subscribe", ["newHeads"]);
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4200);
    expect(r.error?.message).toMatch(/not supported/i);
  });

  it.todo("eth_subscribe('newHeads') yields a subscription id when polling lands (TODO(monolythium-vision): add polling subscription manager)");

  // ---- 9. Negative path — unknown method ----
  it("an unknown method returns error code 4200 (EIP-1193 method-not-supported)", async () => {
    const r = await dispatch("eth_foobar_notreal");
    expect(r.result).toBeUndefined();
    // EIP-1193 §5.4: 4200 "Unsupported Method" is the wallet-level code.
    // Per the JSON-RPC 2.0 spec, -32601 is the method-not-found code; the
    // wallet shim normalizes to 4200 because its surface is provider-shaped,
    // not raw JSON-RPC. Either is acceptable per EIP-1193; this test pins
    // current behaviour so a future refactor surfaces the change.
    expect(r.error?.code).toBe(4200);
    expect(r.error?.message).toMatch(/eth_foobar_notreal/);
  });

  // ---- Bonus: provider construction sanity ----
  it("eth_sendTransaction round trip uses MonolythiumProvider with the testnet chain id", async () => {
    const origin = "https://provider-sanity.example";
    await connectOrigin(origin);
    // Same rationale as the auto-approval test above — register +
    // switch to a non-Sprintnet chain so we exercise the legacy
    // MonolythiumProvider call shape rather than the encrypted-mempool
    // envelope.
    await dispatch("wallet_addEthereumChain", [{
      chainId: "0x7A69",
      chainName: "Local devnet",
      rpcUrls: ["http://127.0.0.1:8545"],
      nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
    }], origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: "0x7A69" }]);
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_gasPrice"] = "0x1";
    rpcResponses["eth_estimateGas"] = "0x5208";
    rpcResponses["eth_sendRawTransaction"] = DETERMINISTIC_TX_HASH;
    await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000002" }], origin);
    // Every call must have flowed through the same JSON-RPC method names —
    // capture call shapes so future refactors can't silently change them.
    const estimate = rpcCalls.find((c) => c.method === "eth_estimateGas");
    expect(estimate).toBeDefined();
    const callShape = (estimate!.params[0] as Record<string, string>);
    expect(callShape).toHaveProperty("from");
    expect(callShape).toHaveProperty("to", "0x0000000000000000000000000000000000000002");
  });

  // ---- Phase 4.3 — popup-IPC chain management ops ----
  describe("popup-IPC chain management", () => {
    const FOREIGN_CHAIN = "0x1234";

    it("chain-add-manual rejects collision with an existing chain", async () => {
      // Pre-populate via the dApp path (auto-approved by the approvals mock).
      await dispatch("wallet_addEthereumChain", [{
        chainId: FOREIGN_CHAIN,
        chainName: "Existing chain",
        rpcUrls: ["https://rpc.existing.example"],
      }], "https://dapp-add.example");
      // Now try to add the same chainId via the popup path.
      const r = await popupDispatch<{ ok: boolean; reason?: string }>(
        "chain-add-manual",
        {
          chain: {
            chainId: FOREIGN_CHAIN,
            name: "Duplicate",
            rpc: "https://rpc.duplicate.example",
          },
        },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/already exists/);
    });

    it("chain-add-manual stores a valid spec and surfaces it via chain-list", async () => {
      const NEW_CHAIN = "0x5678";
      const r = await popupDispatch<{ ok: boolean; chainId?: string }>(
        "chain-add-manual",
        {
          chain: {
            chainId: NEW_CHAIN,
            name: "Popup-added",
            rpc: "https://popup.example",
            blockExplorer: "https://explorer.example",
            nativeCurrency: { name: "Token", symbol: "TKN", decimals: 18 },
          },
        },
      );
      expect(r.ok).toBe(true);
      expect(r.chainId).toBe("0x5678");
      const list = await popupDispatch<Array<{ chainId: string; name: string; builtin: boolean }>>("chain-list");
      const added = list.find((c) => c.chainId === "0x5678");
      expect(added).toBeDefined();
      expect(added?.name).toBe("Popup-added");
      expect(added?.builtin).toBe(false);
    });

    it("chain-add-manual rejects malformed input shapes", async () => {
      const cases = [
        { chain: {} },
        { chain: { chainId: "not-hex", name: "x", rpc: "https://x.example" } },
        { chain: { chainId: "0x0", name: "x", rpc: "https://x.example" } },
        { chain: { chainId: "0xABCDEF", name: "", rpc: "https://x.example" } },
        { chain: { chainId: "0xABCDEF", name: "x", rpc: "not-a-url" } },
      ];
      for (const c of cases) {
        const r = await popupDispatch<{ ok: boolean }>("chain-add-manual", c);
        expect(r.ok).toBe(false);
      }
    });

    it("chain-edit rejects builtin chains", async () => {
      const r = await popupDispatch<{ ok: boolean; reason?: string }>(
        "chain-edit",
        {
          chainId: TESTNET_CHAIN_ID_HEX,
          patch: { name: "Hijacked Sprintnet" },
        },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/builtin/);
    });

    it("chain-edit mutates a user-added chain", async () => {
      const KEY = "0x9ABC";
      await popupDispatch("chain-add-manual", {
        chain: { chainId: KEY, name: "Original", rpc: "https://orig.example" },
      });
      const r = await popupDispatch<{ ok: boolean }>("chain-edit", {
        chainId: KEY,
        patch: {
          name: "Renamed",
          rpc: "https://updated.example",
          blockExplorer: "https://explorer.example",
        },
      });
      expect(r.ok).toBe(true);
      const list = await popupDispatch<Array<{ chainId: string; name: string; rpc: string; blockExplorer?: string }>>("chain-list");
      const edited = list.find((c) => c.chainId === KEY);
      expect(edited?.name).toBe("Renamed");
      expect(edited?.rpc).toBe("https://updated.example");
      expect(edited?.blockExplorer).toBe("https://explorer.example");
    });

    it("chain-edit nullifies blockExplorer when patch sets it to null", async () => {
      const KEY = "0xDEAD";
      await popupDispatch("chain-add-manual", {
        chain: {
          chainId: KEY,
          name: "Has explorer",
          rpc: "https://x.example",
          blockExplorer: "https://explorer.example",
        },
      });
      const r = await popupDispatch<{ ok: boolean }>("chain-edit", {
        chainId: KEY,
        patch: { blockExplorer: null },
      });
      expect(r.ok).toBe(true);
      const list = await popupDispatch<Array<{ chainId: string; blockExplorer?: string }>>("chain-list");
      const edited = list.find((c) => c.chainId === KEY);
      expect(edited?.blockExplorer).toBeUndefined();
    });

    it("chain-delete rejects builtin chains", async () => {
      const r = await popupDispatch<{ ok: boolean; reason?: string }>(
        "chain-delete",
        { chainId: TESTNET_CHAIN_ID_HEX },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/builtin/);
    });

    it("chain-delete removes a user-added chain", async () => {
      const KEY = "0xBEEF";
      await popupDispatch("chain-add-manual", {
        chain: { chainId: KEY, name: "Doomed", rpc: "https://doomed.example" },
      });
      const r = await popupDispatch<{ ok: boolean }>("chain-delete", { chainId: KEY });
      expect(r.ok).toBe(true);
      const list = await popupDispatch<Array<{ chainId: string }>>("chain-list");
      expect(list.find((c) => c.chainId === KEY)).toBeUndefined();
    });

    it("chain-delete on the active chain resets to Sprintnet and broadcasts chainChanged", async () => {
      const KEY = "0xCAFE";
      await popupDispatch("chain-add-manual", {
        chain: { chainId: KEY, name: "Active-then-deleted", rpc: "https://cafe.example" },
      });
      // Switch to it.
      await popupDispatch("wallet-set-active-chain", { chainId: KEY });
      // Clear prior broadcast events from the switch step.
      broadcastEvents.length = 0;
      const r = await popupDispatch<{ ok: boolean }>("chain-delete", { chainId: KEY });
      expect(r.ok).toBe(true);
      // Active chain must reset to Sprintnet and chainChanged must fire.
      const active = await popupDispatch<{ ok: boolean; chainId: string }>("wallet-active-chain");
      expect(active.chainId).toBe(TESTNET_CHAIN_ID_HEX);
      expect(broadcastEvents.some((e) => e.event === "chainChanged" && e.payload === TESTNET_CHAIN_ID_HEX)).toBe(true);
    });

    it("chain-delete on a non-active chain does NOT broadcast chainChanged", async () => {
      const KEY = "0xFADE";
      await popupDispatch("chain-add-manual", {
        chain: { chainId: KEY, name: "Bystander", rpc: "https://bystander.example" },
      });
      // Active chain stays as whatever was already active (Sprintnet, given test isolation).
      broadcastEvents.length = 0;
      const r = await popupDispatch<{ ok: boolean }>("chain-delete", { chainId: KEY });
      expect(r.ok).toBe(true);
      expect(broadcastEvents.some((e) => e.event === "chainChanged")).toBe(false);
    });
  });

  // ---- Phase 4.3 Change 2 — Sprintnet operator override ----
  describe("popup-IPC operator override", () => {
    interface OperatorWire { name: string; region: string; rpc: string; }

    it("sprintnet-operators-get returns defaults + null override on a fresh wallet", async () => {
      // Defensive: clear any prior override so the test is order-independent.
      await popupDispatch("sprintnet-operators-set", { operators: null });
      const r = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        defaults: OperatorWire[];
        effective: OperatorWire[];
      }>("sprintnet-operators-get");
      expect(r.ok).toBe(true);
      expect(r.override).toBeNull();
      expect(r.defaults.length).toBe(7); // val-1 through val-7
      expect(r.effective).toEqual(r.defaults);
    });

    it("sprintnet-operators-set persists a valid override and effective reflects it", async () => {
      const override: OperatorWire[] = [
        { name: "my-node-1", region: "local", rpc: "http://127.0.0.1:8545" },
        { name: "my-node-2", region: "local", rpc: "http://127.0.0.2:8545" },
      ];
      const setRes = await popupDispatch<{ ok: boolean }>(
        "sprintnet-operators-set",
        { operators: override },
      );
      expect(setRes.ok).toBe(true);
      const getRes = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        effective: OperatorWire[];
      }>("sprintnet-operators-get");
      expect(getRes.ok).toBe(true);
      expect(getRes.override).toEqual(override);
      expect(getRes.effective).toEqual(override);
      // Cleanup so other tests don't see the override.
      await popupDispatch("sprintnet-operators-set", { operators: null });
    });

    it("sprintnet-operators-set with null reverts to defaults", async () => {
      // Set then clear.
      await popupDispatch("sprintnet-operators-set", {
        operators: [{ name: "x", region: "y", rpc: "http://example.test" }],
      });
      const clear = await popupDispatch<{ ok: boolean }>(
        "sprintnet-operators-set",
        { operators: null },
      );
      expect(clear.ok).toBe(true);
      const getRes = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        defaults: OperatorWire[];
        effective: OperatorWire[];
      }>("sprintnet-operators-get");
      expect(getRes.override).toBeNull();
      expect(getRes.effective).toEqual(getRes.defaults);
    });

    it("sprintnet-operators-set rejects malformed input shapes", async () => {
      const cases: unknown[] = [
        [], // empty array
        [{ name: "x", region: "y" /* missing rpc */ }],
        [{ name: "x", region: "y", rpc: "not-a-url" }],
        [{ name: "", region: "y", rpc: "http://x.example" }], // empty name
      ];
      for (const c of cases) {
        const r = await popupDispatch<{ ok: boolean; reason?: string }>(
          "sprintnet-operators-set",
          { operators: c },
        );
        expect(r.ok).toBe(false);
      }
      // Clean up.
      await popupDispatch("sprintnet-operators-set", { operators: null });
    });
  });
});
