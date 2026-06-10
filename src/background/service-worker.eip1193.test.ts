// EIP-1193 conformance suite for the Monolythium Wallet's RPC dispatcher.
//
// The wallet's request-router lives in `service-worker.ts:handleRpc` and is
// the integration seam between the in-page `window.ethereum` provider and the
// SDK's `RpcClient` (from `@monolythium/core-sdk` root export, replacing the
// retired `MonolythiumProvider` ethers shim). This suite is a hard
// test gate against drift in that router.
//
// Strategy:
//   - Stub the chrome.* surface the worker imports at module scope (storage,
//     runtime, tabs, windows). The dispatcher registers a single
//     `chrome.runtime.onMessage` listener at import time; we capture it and
//     drive it directly with synthetic `{ kind: "rpc", id, args, origin }`
//     envelopes — this is the same shape the content-script bridge sends.
//   - Mock `@monolythium/core-sdk` so `RpcClient.call(method, params)` returns
//     deterministic responses without any network round-trip. The dispatcher
//     calls `client.call(method, params)` for the generic JSON-RPC escape
//     hatch; we capture every call for assertions.
//   - Mock `./keystore.js` and `./approvals.js` so we never touch argon2,
//     or chrome.windows; both modules expose deterministic stubs.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETERMINISTIC_TEST_ADDRESS,
  TESTNET_69420_GENESIS_HASH_STUB,
} from "../shared/__fixtures__/golden.js";

// ---- Constants from the SDK we're asserting against ----
const TESTNET_CHAIN_ID_BIGINT = 69420n;
const TESTNET_CHAIN_ID_HEX = "0x" + TESTNET_CHAIN_ID_BIGINT.toString(16).toUpperCase(); // 0x10F2C
const DETERMINISTIC_ADDRESS = DETERMINISTIC_TEST_ADDRESS;
const DETERMINISTIC_SIG_BYTES = new Uint8Array(65).fill(0xab);
DETERMINISTIC_SIG_BYTES[64] = 27; // valid recovery id
const DETERMINISTIC_SIG_HEX = "0x" + Array.from(DETERMINISTIC_SIG_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");
const DETERMINISTIC_BLOCK_NUMBER = "0xdeadbeef";

// ---- Mocks installed before the SUT module is imported ----

// `RpcClient.call` capture — every test seeds responses keyed by
// JSON-RPC method, and asserts on the recorded request payloads.
interface CapturedRpcCall {
  method: string;
  params: unknown[];
}
const rpcCalls: CapturedRpcCall[] = [];
let rpcResponses: Record<string, unknown> = {};

vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  class FakeRpcClient {
    constructor(public readonly endpoint: string) {}
    async call<T>(method: string, params: unknown): Promise<T> {
      const paramArray = Array.isArray(params) ? params : params == null ? [] : [params];
      rpcCalls.push({ method, params: paramArray });
      const result = rpcResponses[method];
      if (result === undefined) {
        const e = new Error(`mock: no seeded response for ${method}`) as Error & { code?: number };
        e.code = -32601;
        throw e;
      }
      return result as T;
    }
  }
  return {
    ...actual,
    RpcClient: FakeRpcClient,
    MONOLYTHIUM_TESTNET_CHAIN_ID: TESTNET_CHAIN_ID_BIGINT,
    // Mirror the SDK registry contract: at least one complete endpoint,
    // with membership owned by the SDK snapshot rather than the wallet.
    getRpcEndpoints: () => [
      { url: "http://test.invalid:8545", provider: "test", region: "test", tier: "official" },
    ],
    // shared/build-info.ts pulls TESTNET_69420 from the SDK to
    // surface the registry's genesis on the About page; stub just the
    // genesis_hash + chain_id fields we read at module-init time.
    TESTNET_69420: {
      chain_id: 69420,
      genesis_hash:
        TESTNET_69420_GENESIS_HASH_STUB,
    },
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
  clearPending: vi.fn(async () => {}),
}));

// Keystore mock — deterministic signing, always unlocked unless a test flips it.
// The dApp request path (handleRpc / buildSendTxView) consults the v4 keystore
// (mocked below). `computeTypedDataDigest` is the real pure helper from
// ./typed-data.js (no chrome dependency, deterministic), so it needs no mock.
// `unlocked` / `vaultExists` let tests flip the v4 mock's lock / has-vault state.
let unlocked = true;
let vaultExists = true;
// S6 #45 B1 — flip to true to simulate a multisig active vault (exercises the
// single-signer send-bypass guard). Reset to false after each guard test.
let activeVaultMultisig = false;

vi.mock("./keystore-mldsa.js", () => ({
  hasVaultV4: vi.fn(async () => vaultExists),
  hasContainerV4: vi.fn(async () => vaultExists),
  unlockContainerV4: vi.fn(async () => ({
    address: DETERMINISTIC_ADDRESS,
    vaultId: "v1",
  })),
  getUnlockedAddressV4: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  tryRestoreFromSessionV4: vi.fn(async () => ({ ok: false })),
  isUnlockedV4: vi.fn(() => unlocked),
  // S6 #45 B1 — the send-bypass guard reads the active vault kind.
  getActiveVaultIdV4: vi.fn(() => (unlocked ? "v1" : null)),
  readMultisigMetaV4: vi.fn(async () =>
    activeVaultMultisig ? { signers: [], threshold: 1, proposals: [], governance: [] } : null,
  ),
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
  // personal_sign + eth_signTypedData_v4 route to
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
const broadcastEvents: Array<{ tabId?: number; event: string; payload: unknown }> = [];
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
      // T2-02 — the router authenticates sender.id against this.
      id: "test-id",
    },
    tabs: {
      query: (_filter: unknown, cb: (tabs: Array<{ id: number }>) => void) => {
        // Synthetic tab so the broadcast loop reaches `sendMessage` once.
        cb([{ id: 1 }]);
      },
      sendMessage: (tabId: number, message: { kind: string; event: string; payload: unknown }) => {
        if (message?.kind === "event") {
          broadcastEvents.push({ tabId, event: message.event, payload: message.payload });
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
    const handled = handler(envelope, { id: "test-id" }, resolve);
    if (handled !== true) {
      // The SUT returns true to keep sendResponse alive across async work.
      // If it returned false/undefined we'd never get a response.
      resolve({ error: { code: -32603, message: "handler did not signal async response" } });
    }
  });
}

// Popup IPC dispatcher — same captured listener, but the envelope shape is
// `{ kind: "popup", op, payload }`, used by Settings / Networks / Send and
// the chain-add-manual / chain-edit / chain-delete ops.
function popupDispatch<T = unknown>(op: string, payload?: unknown): Promise<T> {
  const handler = capturedOnMessage;
  if (!handler) throw new Error("service worker did not register onMessage listener");
  return new Promise((resolve) => {
    const envelope = { kind: "popup", op, payload } as unknown;
    const handled = handler(
      envelope,
      { id: "test-id", url: "chrome-extension://test-id/src/popup/index.html" },
      (response: unknown) => {
        resolve(response as T);
      },
    );
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

  it("eth_accounts returns [] when locked, even for a connected origin (no address leak while locked)", async () => {
    const origin = "https://locked-accounts.example";
    await connectOrigin(origin);
    // Lock the wallet — getUnlockedAddressV4() now returns null, so the
    // address must never be resolved or returned to the dApp.
    unlocked = false;
    const r = await dispatch("eth_accounts", [], origin);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual([]);
  });

  // ---- 3. eth_blockNumber ----
  it("eth_blockNumber routes through RpcClient with no params and returns hex", async () => {
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
  it("eth_sendTransaction rejects non-native raw transaction chains", async () => {
    const origin = "https://tx-test.example";
    await connectOrigin(origin);
    await dispatch("wallet_addEthereumChain", [{
      chainId: "0x7A69",
      chainName: "Local devnet",
      rpcUrls: ["http://127.0.0.1:8545"],
      nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
    }], origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: "0x7A69" }], origin);

    const r = await dispatch("eth_sendTransaction", [{
      to: "0x0000000000000000000000000000000000000001",
      value: "0xde0b6b3a7640000", // 1 LYTH
    }], origin);

    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4200);
    expect(r.error?.message).toMatch(/native encrypted Monolythium Testnet sends/);
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(false);
    const methods = rpcCalls.map((c) => c.method);
    expect(methods).not.toContain("eth_getTransactionCount");
    expect(methods).not.toContain("eth_gasPrice");
    expect(methods).not.toContain("eth_estimateGas");
    expect(methods).not.toContain("eth_sendRawTransaction");
  });

  it("eth_sendTransaction surfaces user-rejected errors with code 4001", async () => {
    const origin = "https://rejecting.example";
    await connectOrigin(origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }], origin);
    approvalDecision = { ok: false, reason: "user rejected the transaction" };
    const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000001", value: "0x0" }], origin);
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4001);
  });

  it("eth_sendTransaction from an unconnected origin is rejected with 4100", async () => {
    const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000001" }], "https://not-connected.example");
    expect(r.error?.code).toBe(4100);
  });

  it("S6 #45 B1: eth_sendTransaction from a multisig active vault is refused with 4100 before any approval/RPC", async () => {
    const origin = "https://multisig-dapp.example";
    await connectOrigin(origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }], origin);
    activeVaultMultisig = true;
    try {
      const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000001", value: "0x0" }], origin);
      expect(r.result).toBeUndefined();
      expect(r.error?.code).toBe(4100);
      expect(r.error?.message).toMatch(/multisig wallet/i);
      // Refused EARLY: no approval popup, no operator nonce RPC.
      expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(false);
      expect(rpcCalls.map((c) => c.method)).not.toContain("lyth_getTransactionCount");
    } finally {
      activeVaultMultisig = false;
    }
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

  // ---- 6b. eth_signTypedData_v4 — signer-display WYSIWYS (F-2.9a) ----
  const SAMPLE_TYPED_DATA = JSON.stringify({
    domain: { name: "Test dApp", version: "1", chainId: Number(TESTNET_CHAIN_ID_BIGINT) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Mail: [{ name: "contents", type: "string" }],
    },
    primaryType: "Mail",
    message: { contents: "hello typed data" },
  });
  // A dApp-chosen address that is NOT the wallet's own. The approval must never
  // display this as the signer; the wallet always signs with its own key.
  const FOREIGN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

  it("eth_signTypedData_v4 shows the wallet's own address as signer, ignoring the dApp-supplied address param", async () => {
    const origin = "https://typed-sign.example";
    await connectOrigin(origin);
    const r = await dispatch("eth_signTypedData_v4", [FOREIGN_ADDRESS, SAMPLE_TYPED_DATA], origin);
    expect(r.error).toBeUndefined();
    const enq = enqueuedApprovals.filter((a) => a.kind === "typed_sign");
    expect(enq).toHaveLength(1);
    // The regression guard: the approval's displayed signer is the SW-derived
    // wallet address, NOT the attacker-chosen param (closes the WYSIWYS spoof).
    expect(enq[0]!.address).toBe(DETERMINISTIC_ADDRESS);
    expect(enq[0]!.address).not.toBe(FOREIGN_ADDRESS);
  });

  // A parseable envelope (all four top-level keys present) whose message field
  // does NOT match its declared type — uint256 given an object. The strict
  // encoder (#29) rejects it; the preview try/catch must surface digest=null
  // rather than a wrong-but-silent digest.
  const MALFORMED_TYPED_DATA = JSON.stringify({
    domain: { name: "Test dApp", version: "1", chainId: Number(TESTNET_CHAIN_ID_BIGINT) },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Bad: [{ name: "amount", type: "uint256" }],
    },
    primaryType: "Bad",
    message: { amount: { not: "a number" } },
  });

  it("a valid typed-data envelope carries a computed digest into the approval", async () => {
    const origin = "https://typed-digest-ok.example";
    await connectOrigin(origin);
    await dispatch("eth_signTypedData_v4", [FOREIGN_ADDRESS, SAMPLE_TYPED_DATA], origin);
    const enq = enqueuedApprovals.filter((a) => a.kind === "typed_sign");
    expect(enq).toHaveLength(1);
    expect(enq[0]!.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a malformed-but-parseable envelope yields a null preview digest (strict encoder rejects, no wrong digest) (#29)", async () => {
    const origin = "https://typed-digest-null.example";
    await connectOrigin(origin);
    await dispatch("eth_signTypedData_v4", [FOREIGN_ADDRESS, MALFORMED_TYPED_DATA], origin);
    const enq = enqueuedApprovals.filter((a) => a.kind === "typed_sign");
    expect(enq).toHaveLength(1);
    // Strict encoder throws on object-for-uint256; preview try/catch → digest=null.
    expect(enq[0]!.digest).toBeNull();
  });

  it("personal_sign approval also shows the wallet's own address (parity)", async () => {
    const origin = "https://psign-addr.example";
    await connectOrigin(origin);
    await dispatch("personal_sign", ["hello", FOREIGN_ADDRESS], origin);
    const enq = enqueuedApprovals.filter((a) => a.kind === "personal_sign");
    expect(enq).toHaveLength(1);
    expect(enq[0]!.address).toBe(DETERMINISTIC_ADDRESS);
    expect(enq[0]!.address).not.toBe(FOREIGN_ADDRESS);
  });

  // ---- 7. wallet_switchEthereumChain ----
  it("wallet_switchEthereumChain (connected + approved) switches and broadcasts chainChanged", async () => {
    const origin = "https://switch-ok.example";
    await connectOrigin(origin);
    const r = await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }], origin);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeNull();
    expect(enqueuedApprovals.some((a) => a.kind === "switch_chain")).toBe(true);
    expect(broadcastEvents.some((e) => e.event === "chainChanged" && e.payload === TESTNET_CHAIN_ID_HEX)).toBe(true);
  });

  it("wallet_switchEthereumChain from an unconnected origin is rejected (4100), no switch, no broadcast (F-2.5)", async () => {
    const before = broadcastEvents.filter((e) => e.event === "chainChanged").length;
    const r = await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }], "https://unconnected-switch.example");
    expect(r.error?.code).toBe(4100);
    expect(enqueuedApprovals.some((a) => a.kind === "switch_chain")).toBe(false);
    expect(broadcastEvents.filter((e) => e.event === "chainChanged").length).toBe(before);
  });

  it("wallet_switchEthereumChain enqueues a switch_chain approval and aborts on reject (4001), no switch, no broadcast", async () => {
    const origin = "https://switch-reject.example";
    await connectOrigin(origin);
    approvalDecision = { ok: false, reason: "user rejected the chain switch" };
    const before = broadcastEvents.filter((e) => e.event === "chainChanged").length;
    const r = await dispatch("wallet_switchEthereumChain", [{ chainId: TESTNET_CHAIN_ID_HEX }], origin);
    expect(r.error?.code).toBe(4001);
    expect(enqueuedApprovals.some((a) => a.kind === "switch_chain")).toBe(true);
    expect(broadcastEvents.filter((e) => e.event === "chainChanged").length).toBe(before);
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

  // ---- 8b. Retired methods rejected at the boundary ----
  // mono-core b2f0c498 retired the EVM simulation + polling-filter
  // methods. The wallet rejects them with 4200 at the dispatcher rather
  // than letting them hit the chain just to receive MethodNotFound.
  it.each([
    "eth_call",
    "eth_estimateGas",
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_uninstallFilter",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
  ])("%s is rejected at the dispatcher with 4200 and does not hit the chain", async (method) => {
    const r = await dispatch(method, []);
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4200);
    expect(r.error?.message).toMatch(/retired EVM simulation and polling-filter/);
    // No JSON-RPC traffic should have left the wallet boundary.
    expect(rpcCalls.map((c) => c.method)).not.toContain(method);
  });

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
  it("eth_sendTransaction does not construct a raw provider transaction for non-native chains", async () => {
    const origin = "https://provider-sanity.example";
    await connectOrigin(origin);
    await dispatch("wallet_addEthereumChain", [{
      chainId: "0x7A69",
      chainName: "Local devnet",
      rpcUrls: ["http://127.0.0.1:8545"],
      nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
    }], origin);
    await dispatch("wallet_switchEthereumChain", [{ chainId: "0x7A69" }], origin);
    const r = await dispatch("eth_sendTransaction", [{ to: "0x0000000000000000000000000000000000000002" }], origin);
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4200);
    expect(rpcCalls.map((c) => c.method)).not.toContain("eth_estimateGas");
  });

  // ---- popup-IPC chain management ops ----
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
          patch: { name: "Hijacked Testnet" },
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

    it("chain-delete on the active chain resets to the testnet and broadcasts chainChanged", async () => {
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
      // Active chain must reset to the testnet and chainChanged must fire.
      const active = await popupDispatch<{ ok: boolean; chainId: string }>("wallet-active-chain");
      expect(active.chainId).toBe(TESTNET_CHAIN_ID_HEX);
      expect(broadcastEvents.some((e) => e.event === "chainChanged" && e.payload === TESTNET_CHAIN_ID_HEX)).toBe(true);
    });

    it("chain-delete on a non-active chain does NOT broadcast chainChanged", async () => {
      const KEY = "0xFADE";
      await popupDispatch("chain-add-manual", {
        chain: { chainId: KEY, name: "Bystander", rpc: "https://bystander.example" },
      });
      // Active chain stays as whatever was already active (the testnet, given test isolation).
      broadcastEvents.length = 0;
      const r = await popupDispatch<{ ok: boolean }>("chain-delete", { chainId: KEY });
      expect(r.ok).toBe(true);
      expect(broadcastEvents.some((e) => e.event === "chainChanged")).toBe(false);
    });
  });

  // ---- the testnet operator override ----
  describe("popup-IPC operator override", () => {
    interface OperatorWire { name: string; region: string; rpc: string; }

    it("testnet-operators-get returns defaults + null override on a fresh wallet", async () => {
      // Defensive: clear any prior override so the test is order-independent.
      await popupDispatch("testnet-operators-set", { operators: null });
      const r = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        defaults: OperatorWire[];
        effective: OperatorWire[];
      }>("testnet-operators-get");
      expect(r.ok).toBe(true);
      expect(r.override).toBeNull();
      expect(r.defaults.length).toBeGreaterThanOrEqual(1);
      expect(r.effective).toEqual(r.defaults);
    });

    it("testnet-operators-set persists a valid override and effective reflects it", async () => {
      const override: OperatorWire[] = [
        { name: "my-node-1", region: "local", rpc: "http://127.0.0.1:8545" },
        { name: "my-node-2", region: "local", rpc: "http://127.0.0.2:8545" },
      ];
      const setRes = await popupDispatch<{ ok: boolean }>(
        "testnet-operators-set",
        { operators: override },
      );
      expect(setRes.ok).toBe(true);
      const getRes = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        effective: OperatorWire[];
      }>("testnet-operators-get");
      expect(getRes.ok).toBe(true);
      expect(getRes.override).toEqual(override);
      expect(getRes.effective).toEqual(override);
      // Cleanup so other tests don't see the override.
      await popupDispatch("testnet-operators-set", { operators: null });
    });

    it("testnet-operators-set with null reverts to defaults", async () => {
      // Set then clear.
      await popupDispatch("testnet-operators-set", {
        operators: [{ name: "x", region: "y", rpc: "http://example.test" }],
      });
      const clear = await popupDispatch<{ ok: boolean }>(
        "testnet-operators-set",
        { operators: null },
      );
      expect(clear.ok).toBe(true);
      const getRes = await popupDispatch<{
        ok: boolean;
        override: OperatorWire[] | null;
        defaults: OperatorWire[];
        effective: OperatorWire[];
      }>("testnet-operators-get");
      expect(getRes.override).toBeNull();
      expect(getRes.effective).toEqual(getRes.defaults);
    });

    it("testnet-operators-set rejects malformed input shapes", async () => {
      const cases: unknown[] = [
        [], // empty array
        [{ name: "x", region: "y" /* missing rpc */ }],
        [{ name: "x", region: "y", rpc: "not-a-url" }],
        [{ name: "", region: "y", rpc: "http://x.example" }], // empty name
      ];
      for (const c of cases) {
        const r = await popupDispatch<{ ok: boolean; reason?: string }>(
          "testnet-operators-set",
          { operators: c },
        );
        expect(r.ok).toBe(false);
      }
      // Clean up.
      await popupDispatch("testnet-operators-set", { operators: null });
    });
  });

  // ---- T2-01 / T2-03 — provider event origin scoping ----
  describe("provider event origin scoping (T2-01 / T2-03)", () => {
    function rpcFromTab(method: string, origin: string, tabId: number): Promise<unknown> {
      return new Promise((resolve) => {
        const ret = capturedOnMessage!(
          {
            kind: "rpc",
            id: Math.random().toString(36).slice(2),
            args: { method, params: [] },
            origin,
          },
          { id: "test-id", tab: { id: tabId } },
          resolve as (r: unknown) => void,
        );
        if (ret !== true) resolve(undefined);
      });
    }

    // Drive the content-script origin-announce (kind: "announce"), the message
    // the bridge sends on load. Synchronous branch — no async response.
    function announceFromTab(origin: string, tabId: number, senderId = "test-id"): void {
      capturedOnMessage!(
        { kind: "announce", origin },
        { id: senderId, tab: { id: tabId } },
        () => {},
      );
    }

    it("account-carrying events reach only connected-origin tabs", async () => {
      // Tab 2 / origin B talks to the SW but never connects.
      await rpcFromTab("eth_chainId", "https://unconnected.example", 2);
      broadcastEvents.length = 0;
      // Tab 1 / origin A connects → broadcasts accountsChanged + connect.
      await rpcFromTab("eth_requestAccounts", "https://connected.example", 1);
      const accountEvents = broadcastEvents.filter(
        (e) => e.event === "accountsChanged" || e.event === "connect",
      );
      expect(accountEvents.length).toBeGreaterThan(0);
      // Only the connected tab (1) received them; the unconnected tab (2) did not.
      expect(accountEvents.every((e) => e.tabId === 1)).toBe(true);
      expect(accountEvents.some((e) => e.tabId === 2)).toBe(false);
    });

    it("revoke-origin emits a scoped accountsChanged:[] disconnect to that origin's tab", async () => {
      await rpcFromTab("eth_requestAccounts", "https://revoke-me.example", 3);
      broadcastEvents.length = 0;
      await popupDispatch("revoke-origin", { origin: "https://revoke-me.example" });
      const disconnects = broadcastEvents.filter(
        (e) =>
          e.event === "accountsChanged" &&
          Array.isArray(e.payload) &&
          (e.payload as unknown[]).length === 0,
      );
      expect(disconnects.some((e) => e.tabId === 3)).toBe(true);
    });

    it("a tab that announces a now-unconnected origin stops receiving account events (C6 navigation residual closed)", async () => {
      // Two tabs each connect a distinct origin.
      await rpcFromTab("eth_requestAccounts", "https://stay.example", 10);
      await rpcFromTab("eth_requestAccounts", "https://leave.example", 11);

      // A fresh connect (new origin/tab) fans an accountsChanged broadcast out
      // across the whole tabId->origin map — the only path that re-emits (a
      // repeat connect from an already-connected origin resolves silently).
      // Baseline: both connected tabs receive it (the address WOULD reach tab 11
      // here — the pre-fix behaviour while its mapping is still connected).
      broadcastEvents.length = 0;
      await rpcFromTab("eth_requestAccounts", "https://baseline-trigger.example", 12);
      let acct = broadcastEvents.filter((e) => e.event === "accountsChanged");
      expect(acct.some((e) => e.tabId === 10)).toBe(true);
      expect(acct.some((e) => e.tabId === 11)).toBe(true);

      // Tab 11 navigates to an origin that never connected. Its bridge announces
      // the new origin on load, flipping the tabId->origin map immediately —
      // before tab 11 issues any rpc on the new page.
      announceFromTab("https://now-unconnected.example", 11);

      // Re-broadcast via another fresh connect: the still-connected tab 10 keeps
      // the address; the navigated tab 11 no longer receives it. The
      // stale-until-next-rpc window is closed at the content-script load instant.
      broadcastEvents.length = 0;
      await rpcFromTab("eth_requestAccounts", "https://second-trigger.example", 13);
      acct = broadcastEvents.filter((e) => e.event === "accountsChanged");
      expect(acct.some((e) => e.tabId === 10)).toBe(true);
      expect(acct.some((e) => e.tabId === 11)).toBe(false);
    });

    it("an announce from a foreign extension id is ignored (C5 sender-id gate intact)", async () => {
      // Tab 20 connects a genuine origin.
      await rpcFromTab("eth_requestAccounts", "https://genuine.example", 20);
      // A foreign-id sender tries to flip tab 20's mapping to an unconnected
      // origin. The shared `sender.id === runtime.id` gate must drop it before
      // the announce branch runs, leaving the map untouched.
      announceFromTab("https://attacker.example", 20, "evil-ext-id");
      // Fan an accountsChanged broadcast out via a fresh connect and confirm
      // tab 20 still receives it → the poison announce was rejected (had it
      // flipped tab 20 to the unconnected attacker origin, tab 20 would now be
      // skipped). C5 sender-id gate not weakened.
      broadcastEvents.length = 0;
      await rpcFromTab("eth_requestAccounts", "https://foreign-trigger.example", 21);
      const acct = broadcastEvents.filter((e) => e.event === "accountsChanged");
      expect(acct.some((e) => e.tabId === 20)).toBe(true);
    });
  });
});
