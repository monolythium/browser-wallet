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
import {
  addressToTypedBech32,
  type NoEvmReceiptTrustPolicy,
} from "@monolythium/core-sdk";
import { MlDsa65Backend, hexToBytes } from "@monolythium/core-sdk/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

const mockVerifyNoEvmFinalityEvidenceThreshold = vi.hoisted(() => vi.fn());
const mockGetNoEvmReceiptTrustPolicy = vi.hoisted(() => vi.fn());

const DETERMINISTIC_ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const DETERMINISTIC_SMART_ACCOUNT = addressToTypedBech32(
  "smartAccount",
  DETERMINISTIC_ADDRESS,
);
const TESTNET_CHAIN_ID_HEX = "0x10F2C";
const DISCOVERY_ROUTE = {
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
  cooldownSeconds: 86_400,
  adminControl: "consensusOnly",
  circuitBreaker: "armed",
  insuranceAtomic: "50000000000",
  lastIncidentDate: null,
};

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
const RECEIPT_COMMITMENT = "0x" + "c".repeat(64);
const ARCHIVE_PROOF_SIGNATURE =
  "mono.snapshot.sig.v1:0x" + "d".repeat(40) + ":0x1234abcd";
const ARCHIVE_SIGNATURE_DIGEST = "0x" + "e".repeat(64);
const TRUSTED_ARCHIVE_SIGNER = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(7));
const TRUSTED_ARCHIVE_PUBLIC_KEY = mrvTestBytesToHex(
  TRUSTED_ARCHIVE_SIGNER.publicKey(),
);
const TRUSTED_ARCHIVE_SIGNATURE = archiveSignatureForDigest(
  ARCHIVE_SIGNATURE_DIGEST,
  TRUSTED_ARCHIVE_SIGNER,
);
const REGISTRY_ARCHIVE_SIGNER = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(9));
const REGISTRY_ARCHIVE_SIGNATURE = archiveSignatureForDigest(
  ARCHIVE_SIGNATURE_DIGEST,
  REGISTRY_ARCHIVE_SIGNER,
);
const ARCHIVE_COVERING_SNAPSHOT = {
  snapshotHeight: 101,
  manifestHash: "0x" + "a".repeat(64),
  signatureDigest: "0x" + "b".repeat(64),
  contentHash: "0x" + "c".repeat(64),
  checkpointContentHash: "0x" + "9".repeat(64),
  checkpointFrom: 0,
  checkpointTo: 101,
  signatures: [ARCHIVE_PROOF_SIGNATURE],
};
const FINALITY_CLUSTER_PUBLIC_KEY = "0x" + "1".repeat(96);
const REGISTRY_FINALITY_CLUSTER_PUBLIC_KEY = new Uint8Array(48).fill(0x22);
const MISSING_FINALITY_PROOF_MATERIAL =
  "BLS aggregate finality certificate for block round";
const NO_EVM_FINALITY_EVIDENCE = {
  schema: "mono.no_evm_receipt_finality.v1",
  source: "blsRoundCertificate",
  round: 57,
  certificate: {
    round: 57,
    signature: "0x1234",
    signersBitmap: "0xabcd",
    signerIndices: [1, 3],
    signerCount: 2,
  },
} as const;
const NO_EVM_RECEIPT_PROOF = {
  schema: "mono.no_evm_receipt_proof.v1",
  proofKind: "boundedCacheTranscript",
  proofType: "canonicalReceiptsTranscript",
  historySource: "liveBlockCache",
  compactInclusionProof: null,
  archiveProof: null,
  finalityEvidence: null,
  missingProofMaterial: [MISSING_FINALITY_PROOF_MATERIAL],
  rootAlgorithm: "keccak256(monolythium/v2/receipts_root/1)",
  receiptCodec: "rlp-eth-receipt",
  blockHash: "0x" + "1".repeat(64),
  txHash: SUBMITTED_TX_HASH,
  receiptsRoot:
    "0x73d29f250b2f46be15d1ad19c5dc039449e5236e47c9662266ca13b71ed84928",
  targetReceiptHash:
    "0xe4cfff110d648eb1821542b3805ded1e3df86e85b26cc19021f55168ed1a2ede",
  blockHeight: 100,
  txIndex: 1,
  receiptCount: 2,
  receiptTranscript: ["0x01", "0x02ff"],
  targetReceiptBytes: null,
} as const;

const COMPACT_RECEIPT_BYTES = new Uint8Array([0x04, 0x05, 0x06, 0x07]);
const COMPACT_RECEIPT_BYTES_HEX = mrvTestBytesToHex(COMPACT_RECEIPT_BYTES);
const COMPACT_RECEIPT_HASH = mrvTestKeccakHex(COMPACT_RECEIPT_BYTES);
const COMPACT_RECEIPT_LEAF_HASH = mrvTestCompactLeafHashHex(
  COMPACT_RECEIPT_BYTES,
  0,
);
const INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF = {
  schema: "mono.no_evm_receipt_proof.v1",
  proofKind: "compactInclusion",
  proofType: "canonicalReceiptInclusion",
  historySource: "indexerReceiptArchive",
  compactInclusionProof: {
    schema: "mono.no_evm_receipt_compact_inclusion.v1",
    treeAlgorithm: "binary-keccak-receipt-tree",
    root: COMPACT_RECEIPT_LEAF_HASH,
    leafHash: COMPACT_RECEIPT_LEAF_HASH,
    siblingHashes: [],
    pathSides: [],
  },
  archiveProof: {
    schema: "mono.no_evm_receipt_archive_binding.v1",
    source: "indexerReceiptArchiveContentDigest",
    manifestHash: "0x" + "6".repeat(64),
    contentHash: "0x" + "9".repeat(64),
    signatures: [],
  },
  finalityEvidence: NO_EVM_FINALITY_EVIDENCE,
  missingProofMaterial: [],
  rootAlgorithm:
    "keccak256-binary-merkle(monolythium/v4.1/receipt_leaf/1, monolythium/v4.1/receipt_node/1, duplicate-last padding)",
  receiptCodec: "bincode(protocore_execution_types::Receipt)",
  blockHash: "0x" + "2".repeat(64),
  txHash: SUBMITTED_TX_HASH,
  receiptsRoot: COMPACT_RECEIPT_LEAF_HASH,
  targetReceiptHash: COMPACT_RECEIPT_HASH,
  blockHeight: 101,
  txIndex: 0,
  receiptCount: 1,
  receiptTranscript: [],
  targetReceiptBytes: COMPACT_RECEIPT_BYTES_HEX,
} as const;

function archiveSignatureForDigest(
  signatureDigest: string,
  signer: MlDsa65Backend,
): string {
  return [
    "mono.snapshot.sig.v1",
    signer.getAddress(),
    mrvTestBytesToHex(signer.sign(hexToBytes(signatureDigest))),
  ].join(":");
}

function mrvTestCompactLeafHashHex(bytes: Uint8Array, txIndex: number): string {
  const domain = new TextEncoder().encode("monolythium/v4.1/receipt_leaf/1");
  const payload = new Uint8Array(domain.length + 8 + bytes.length);
  let offset = 0;
  payload.set(domain, offset);
  offset += domain.length;
  mrvTestWriteU32Le(payload, offset, txIndex);
  offset += 4;
  mrvTestWriteU32Le(payload, offset, bytes.length);
  offset += 4;
  payload.set(bytes, offset);
  return mrvTestKeccakHex(payload);
}

function mrvTestWriteU32Le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function mrvTestKeccakHex(bytes: Uint8Array): string {
  return mrvTestBytesToHex(keccak_256(bytes));
}

function mrvTestBytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function registryReceiptTrustPolicy(): NoEvmReceiptTrustPolicy {
  return {
    chainId: 69420,
    archive: {
      threshold: 1,
      trustedSigners: [
        {
          publicKey: REGISTRY_ARCHIVE_SIGNER.publicKey(),
          signerId: REGISTRY_ARCHIVE_SIGNER.getAddress(),
        },
      ],
    },
    finality: {
      mode: "cluster",
      chainId: 69420,
      clusterPublicKey: REGISTRY_FINALITY_CLUSTER_PUBLIC_KEY,
      committeeSize: 7,
      threshold: 2,
    },
  };
}
let submitFailure: (Error & { code?: number }) | null = null;

// Networks: only the bits the handlers touch. Sprintnet chain id is
// "MlDsa" per the SW's gating helper; suggestFee returns a deterministic
// fee structure so wallet-send-tx can complete the broadcast preamble.
vi.mock("./networks.js", () => ({
  chainRequiresMlDsa: vi.fn((chainIdHex: string) =>
    chainIdHex.toUpperCase() === TESTNET_CHAIN_ID_HEX.toUpperCase(),
  ),
  SPRINTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX: "0x5208",
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

let approvalDecision: { ok: true } | { ok: false; reason?: string } = { ok: true };
const enqueuedApprovals: Array<{ kind: string; [k: string]: unknown }> = [];

vi.mock("./approvals.js", () => ({
  enqueue: vi.fn(async (req: { kind: string; [k: string]: unknown }) => {
    enqueuedApprovals.push(req);
    return approvalDecision;
  }),
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

vi.mock("@monolythium/core-sdk/ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk/ethers")>();
  return {
    ...actual,
    MonolythiumProvider: class {
      async _send() {
        return [];
      }
    },
  };
});

vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  return {
    ...actual,
    MONOLYTHIUM_TESTNET_CHAIN_ID: 69420n,
    verifyNoEvmFinalityEvidenceThreshold:
      mockVerifyNoEvmFinalityEvidenceThreshold,
    getNoEvmReceiptTrustPolicy: mockGetNoEvmReceiptTrustPolicy,
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
  };
});

import { buildWalletMrvCallNativePlan } from "../shared/mrv-native-plan.js";
import { submitEncryptedMlDsaTx } from "./tx-mldsa.js";

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

interface RpcEnvelope {
  kind: "rpc";
  id: string;
  args: {
    method: string;
    params?: unknown[];
  };
  origin: string;
}

async function dispatchPopup(envelope: PopupEnvelope): Promise<unknown> {
  if (!capturedOnMessage) throw new Error("SW did not register onMessage handler");
  return new Promise((resolve) => {
    capturedOnMessage!(envelope, {}, resolve);
  });
}

async function dispatchRpc(
  method: string,
  params: unknown[] = [],
  origin = "https://dapp.example",
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  if (!capturedOnMessage) throw new Error("SW did not register onMessage handler");
  return new Promise((resolve) => {
    const envelope: RpcEnvelope = {
      kind: "rpc",
      id: Math.random().toString(36).slice(2),
      args: { method, params },
      origin,
    };
    const handled = capturedOnMessage!(envelope, {}, (response: unknown) => {
      resolve(response as { result?: unknown; error?: { code: number; message: string } });
    });
    if (handled !== true) {
      resolve({ error: { code: -32603, message: "handler did not signal async response" } });
    }
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
  vi.unstubAllEnvs();
  rpcCalls.length = 0;
  rpcResponses = {};
  rpcErrors = {};
  submitFailure = null;
  approvalDecision = { ok: true };
  enqueuedApprovals.length = 0;
  unlocked = true;
  storageLocal = {};
  storageSession = {};
  mockVerifyNoEvmFinalityEvidenceThreshold.mockReset();
  mockGetNoEvmReceiptTrustPolicy.mockReset();
  mockGetNoEvmReceiptTrustPolicy.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-indexer-snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-indexer-snapshot", () => {
  it("validates token balances while preserving optional MRC identity", async () => {
    rpcResponses["lyth_getTokenBalances"] = [
      {
        tokenId: "0xopaque",
        balance: "7",
        updatedAtBlock: 123,
        mrc: {
          standard: "mrc721",
          assetId: "0xcollection",
          tokenId: "0xreal",
        },
      },
      {
        tokenId: "0xlegacy",
        balance: "2",
        updatedAtBlock: 124,
        mrc: null,
      },
    ];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        tokenBalances: Array<{
          tokenId: string;
          balance: string;
          updatedAtBlock: number;
          mrc?: { standard: string; assetId: string; tokenId?: string };
        }>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.tokenBalances[0]).toEqual({
      tokenId: "0xopaque",
      balance: "7",
      updatedAtBlock: 123,
      mrc: {
        standard: "mrc721",
        assetId: "0xcollection",
        tokenId: "0xreal",
      },
    });
    expect(r.snapshot.tokenBalances[1]).toEqual({
      tokenId: "0xlegacy",
      balance: "2",
      updatedAtBlock: 124,
    });
  });

  it("enriches native MRC NFT token balances with bounded holder rows", async () => {
    const assetId = `0x${"bb".repeat(32)}`;
    const tokenId = `0x${"cc".repeat(32)}`;
    const holderAddress = "0x1111111111111111111111111111111111111111";
    rpcResponses["lyth_getTokenBalances"] = [
      {
        tokenId: "balance-key",
        balance: "1",
        updatedAtBlock: 123,
        mrc: {
          standard: "mrc721",
          assetId,
          tokenId,
        },
      },
      {
        tokenId: "mrc20-key",
        balance: "10",
        updatedAtBlock: 124,
        mrc: {
          standard: "mrc20",
          assetId: `0x${"dd".repeat(32)}`,
        },
      },
    ];
    rpcResponses["lyth_mrcHolders"] = {
      schemaVersion: 1,
      standard: "mrc721",
      assetId,
      tokenId,
      limit: 3,
      holders: [
        {
          rank: 1,
          address: holderAddress,
          balance: "1",
          updatedAtBlock: 125,
        },
      ],
    };
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        tokenBalances: Array<{
          tokenId: string;
          mrcHolders?: {
            standard: string;
            assetId: string;
            tokenId: string;
            limit: number;
            holders: Array<{ address: string; balance: string }>;
          };
        }>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.tokenBalances[0]?.mrcHolders).toMatchObject({
      standard: "mrc721",
      assetId,
      tokenId,
      limit: 3,
      holders: [{ address: holderAddress, balance: "1" }],
    });
    expect(r.snapshot.tokenBalances[1]?.mrcHolders).toBeUndefined();
    expect(rpcCalls).toContainEqual({
      method: "lyth_mrcHolders",
      params: ["mrc721", assetId, tokenId, 3],
    });
  });

  it("enriches MRC-4626 vault share balances with null-token holder rows", async () => {
    const vaultId = `0x${"46".repeat(32)}`;
    const holderAddress = "0x2222222222222222222222222222222222222222";
    rpcResponses["lyth_getTokenBalances"] = [
      {
        tokenId: vaultId,
        balance: "55",
        updatedAtBlock: 130,
        mrc: {
          standard: "mrc4626",
          assetId: vaultId,
        },
      },
    ];
    rpcResponses["lyth_mrcHolders"] = {
      schemaVersion: 1,
      standard: "mrc4626",
      assetId: vaultId,
      tokenId: null,
      limit: 3,
      holders: [
        {
          rank: 1,
          address: holderAddress,
          balance: "55",
          updatedAtBlock: 131,
        },
      ],
    };
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        tokenBalances: Array<{
          tokenId: string;
          mrcHolders?: {
            standard: string;
            assetId: string;
            tokenId: string | null;
            limit: number;
            holders: Array<{ address: string; balance: string }>;
          };
        }>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.tokenBalances[0]?.mrcHolders).toMatchObject({
      standard: "mrc4626",
      assetId: vaultId,
      tokenId: null,
      limit: 3,
      holders: [{ address: holderAddress, balance: "55" }],
    });
    expect(rpcCalls).toContainEqual({
      method: "lyth_mrcHolders",
      params: ["mrc4626", vaultId, null, 3],
    });
  });

  it("includes best-effort MRC account lookup in popup snapshots", async () => {
    const controller = addressToTypedBech32(
      "user",
      "0x2222222222222222222222222222222222222222",
    );
    const recovery = addressToTypedBech32(
      "user",
      "0x3333333333333333333333333333333333333333",
    );
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];
    rpcResponses["lyth_mrcAccount"] = {
      schemaVersion: 1,
      account: DETERMINISTIC_SMART_ACCOUNT,
      spendLimit: 4,
      smartAccount: {
        kind: "smart_account",
        account: DETERMINISTIC_SMART_ACCOUNT,
        controller,
        recovery,
        policyHash: null,
        policy: null,
        nonce: "7",
        updatedAtBlock: 140,
      },
      policyAccount: {
        kind: "policy_account",
        account: DETERMINISTIC_SMART_ACCOUNT,
        controller,
        recovery: null,
        policyHash: "0x" + "55".repeat(32),
        policy: {
          enabled: true,
          perActionLimit: "20",
          windowLimit: "100",
          allowedAssets: ["0x" + "44".repeat(32)],
        },
        nonce: null,
        updatedAtBlock: 141,
      },
      policySpends: [
        {
          account: DETERMINISTIC_SMART_ACCOUNT,
          assetId: "0x" + "44".repeat(32),
          window: "9",
          amount: "20",
          spent: "45",
          updatedAtBlock: 142,
        },
      ],
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        mrcAccount: {
          account: string;
          smartAccount: { nonce: string | null } | null;
          policyAccount: {
            policyHash: string | null;
            policy: { enabled: boolean; perActionLimit: string } | null;
          } | null;
          policySpends: Array<{ window: string; spent: string }>;
        } | null;
        errors: Record<string, string>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.mrcAccount).toMatchObject({
      account: DETERMINISTIC_SMART_ACCOUNT,
      smartAccount: { nonce: "7" },
      policyAccount: {
        policyHash: "0x" + "55".repeat(32),
        policy: { enabled: true, perActionLimit: "20" },
      },
      policySpends: [{ window: "9", spent: "45" }],
    });
    expect(r.snapshot.errors.mrcAccount).toBeUndefined();
    expect(rpcCalls).toContainEqual({
      method: "lyth_mrcAccount",
      params: [DETERMINISTIC_SMART_ACCOUNT, 4],
    });
  });

  it("returns a null MRC account summary when lookup is unavailable", async () => {
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];
    rpcErrors["lyth_mrcAccount"] = { code: -32601, message: "Method not found" };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        mrcAccount: null;
        errors: Record<string, string>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.mrcAccount).toBeNull();
    expect(r.snapshot.errors.mrcAccount).toBe("Method not found");
  });

  it("preserves native agent state rows in popup snapshots", async () => {
    const issuerId = `0x${"11".repeat(32)}`;
    const attestationId = `0x${"12".repeat(32)}`;
    const consentId = `0x${"13".repeat(32)}`;
    const serviceId = `0x${"14".repeat(32)}`;
    const arbiterId = `0x${"15".repeat(32)}`;
    const reviewId = `0x${"16".repeat(32)}`;
    const policyId = `0x${"aa".repeat(32)}`;
    const escrowId = `0x${"bb".repeat(32)}`;
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];
    rpcErrors["lyth_mrcAccount"] = { code: -32601, message: "Method not found" };
    rpcResponses["lyth_nativeAgentState"] = {
      schemaVersion: 1,
      limit: 10,
      filters: {
        account: DETERMINISTIC_ADDRESS,
        includePolicySpends: true,
      },
      issuers: [
        {
          issuerId,
          issuer: DETERMINISTIC_ADDRESS,
          metadataHash: `0x${"1b".repeat(32)}`,
          updatedAtBlock: 45,
        },
      ],
      attestations: [
        {
          attestationId,
          issuerId,
          issuer: DETERMINISTIC_ADDRESS,
          subject: "mono1agentcontroller",
          schemaHash: `0x${"17".repeat(32)}`,
          payloadHash: `0x${"ee".repeat(32)}`,
          active: false,
          updatedAtBlock: 46,
        },
      ],
      consents: [
        {
          consentId,
          subject: DETERMINISTIC_ADDRESS,
          grantee: "mono1agentarbiter",
          scopeHash: `0x${"19".repeat(32)}`,
          expiresAt: 10_000,
          active: true,
          updatedAtBlock: 47,
        },
      ],
      services: [
        {
          serviceId,
          provider: "mono1agentprovider",
          categoryHash: `0x${"1a".repeat(32)}`,
          metadataHash: `0x${"1b".repeat(32)}`,
          active: true,
          updatedAtBlock: 48,
        },
      ],
      availability: [
        {
          provider: "mono1agentprovider",
          maxConcurrent: 8,
          openRequests: 2,
          paused: false,
          updatedAtBlock: 49,
        },
      ],
      arbiters: [
        {
          arbiterId,
          arbiter: "mono1agentarbiter",
          tier: 2,
          metadataHash: `0x${"1b".repeat(32)}`,
          updatedAtBlock: 50,
        },
      ],
      spendingPolicies: [
        {
          policyId,
          owner: DETERMINISTIC_ADDRESS,
          controller: "mono1agentcontroller",
          assetId: `0x${"cc".repeat(32)}`,
          enabled: true,
          perActionLimit: "100",
          windowLimit: "500",
          windowSecs: 60,
          updatedAtBlock: 42,
        },
      ],
      policySpends: [],
      escrows: [
        {
          escrowId,
          buyer: DETERMINISTIC_ADDRESS,
          provider: "mono1agentprovider",
          arbiter: "mono1agentarbiter",
          assetId: `0x${"cc".repeat(32)}`,
          amount: "1000",
          termsHash: `0x${"dd".repeat(32)}`,
          round: 2,
          buyerAccepted: true,
          providerAccepted: false,
          submittedPayloadHash: null,
          status: "accepted",
          resolution: null,
          lastActor: DETERMINISTIC_ADDRESS,
          createdAtBlock: 40,
          updatedAtBlock: 44,
        },
      ],
      reputationReviews: [
        {
          reviewId,
          reviewer: DETERMINISTIC_ADDRESS,
          subject: "mono1agentprovider",
          categoryId: 7,
          speedScore: 9,
          qualityScore: 8,
          communicationScore: 10,
          accuracyScore: 9,
          payloadHash: `0x${"ee".repeat(32)}`,
          updatedAtBlock: 51,
        },
      ],
      source: {
        indexerProvider: "native_agent_state",
        projection: "native_agent_state",
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        nativeAgentState: {
          issuers: Array<{ issuerId: string; issuer: string }>;
          attestations: Array<{ attestationId: string; active: boolean }>;
          consents: Array<{ consentId: string; active: boolean }>;
          services: Array<{ serviceId: string; provider: string }>;
          availability: Array<{ provider: string; maxConcurrent: number; openRequests: number }>;
          arbiters: Array<{ arbiterId: string; tier: number }>;
          spendingPolicies: Array<{ policyId: string }>;
          escrows: Array<{ escrowId: string; status: string }>;
          reputationReviews: Array<{ reviewId: string; qualityScore: number }>;
        } | null;
        errors: Record<string, string>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.nativeAgentState?.issuers[0]).toMatchObject({
      issuerId,
      issuer: DETERMINISTIC_ADDRESS,
    });
    expect(r.snapshot.nativeAgentState?.attestations[0]).toMatchObject({
      attestationId,
      active: false,
    });
    expect(r.snapshot.nativeAgentState?.consents[0]).toMatchObject({
      consentId,
      active: true,
    });
    expect(r.snapshot.nativeAgentState?.services[0]).toMatchObject({
      serviceId,
      provider: "mono1agentprovider",
    });
    expect(r.snapshot.nativeAgentState?.availability[0]).toMatchObject({
      provider: "mono1agentprovider",
      maxConcurrent: 8,
      openRequests: 2,
    });
    expect(r.snapshot.nativeAgentState?.arbiters[0]).toMatchObject({
      arbiterId,
      tier: 2,
    });
    expect(r.snapshot.nativeAgentState?.spendingPolicies[0]?.policyId).toBe(policyId);
    expect(r.snapshot.nativeAgentState?.escrows[0]).toMatchObject({
      escrowId,
      status: "accepted",
    });
    expect(r.snapshot.nativeAgentState?.reputationReviews[0]).toMatchObject({
      reviewId,
      qualityScore: 8,
    });
    expect(r.snapshot.errors.nativeAgentState).toBeUndefined();
    expect(rpcCalls).toContainEqual({
      method: "lyth_nativeAgentState",
      params: [
        {
          account: DETERMINISTIC_ADDRESS,
          includePolicySpends: true,
          limit: 10,
        },
      ],
    });
  });

  it("passes through bridge route disclosures from token-balance envelopes", async () => {
    rpcResponses["lyth_getTokenBalances"] = {
      tokenBalances: [
        {
          tokenId: "0xbridged",
          balance: "9",
          updatedAtBlock: 125,
          bridgeRouteDisclosure: {
            trustModel: "committee",
            liquidityFloor: "1000",
          },
        },
      ],
      bridgeRouteDisclosures: [
        {
          trust: { threshold: "5/7" },
          liquidity: { available: "900" },
        },
      ],
    };
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        tokenBalances: Array<{
          tokenId: string;
          bridgeRouteDisclosure?: Record<string, unknown>;
        }>;
        bridgeRouteDisclosures: Array<Record<string, unknown>>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.tokenBalances[0]?.bridgeRouteDisclosure).toEqual({
      trustModel: "committee",
      liquidityFloor: "1000",
    });
    expect(r.snapshot.bridgeRouteDisclosures).toEqual([
      {
        trust: { threshold: "5/7" },
        liquidity: { available: "900" },
      },
    ]);
  });

  it("merges discovery-only bridge route catalogue responses into the snapshot", async () => {
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_bridgeRoutes"] = {
      selection: {
        selected: null,
        candidates: [],
        blockedReasons: ["bridge route selection requires transfer intent"],
      },
      routeSelectionReady: false,
      quoteReady: false,
      submitReady: false,
      blockedReasons: ["bridge route selection requires transfer intent"],
      warnings: [],
      routes: [DISCOVERY_ROUTE],
      bridgeRouteDisclosures: [DISCOVERY_ROUTE],
      source: {
        address: null,
        routeCount: 1,
        globalRouteIndexAvailable: true,
        routeDisclosureSource: "indexer.bridgeRouteDisclosures",
      },
    };
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [];

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-indexer-snapshot",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      snapshot: {
        bridgeRouteDisclosures: Array<Record<string, unknown>>;
        bridgeRouteReadiness: {
          routeSelectionReady: boolean;
          quoteReady: boolean;
          submitReady: boolean;
          blockedReasons: string[];
          warnings: string[];
        } | null;
        errors: Record<string, string>;
      };
    };

    expect(r.ok).toBe(true);
    expect(r.snapshot.bridgeRouteDisclosures).toEqual([DISCOVERY_ROUTE]);
    expect(r.snapshot.bridgeRouteReadiness).toEqual({
      routeSelectionReady: false,
      quoteReady: false,
      submitReady: false,
      blockedReasons: ["bridge route selection requires transfer intent"],
      warnings: [],
    });
    expect(r.snapshot.errors.bridgeRoutes).toBeUndefined();
    expect(rpcCalls).toContainEqual({
      method: "lyth_bridgeRoutes",
      params: [],
    });
  });
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
    expect(firstFetchCount).toBe(6); // tokenBalances + bridgeRoutes + nativeAgentState + addressLabel + delegationHistory + addressActivity
    expect(rpcCalls.some((c) => c.method === "lyth_mrcAccount")).toBe(false);
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

  it("passes SDK market plans through with the CLOB mempool class", async () => {
    rpcResponses["eth_getTransactionCount"] = "0x0";
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0x0000000000000000000000000000000000001001",
        valueWeiHex: "0x0",
        data: "0x2468786f" + "00".repeat(192),
        gasLimitHex: "0x30d40",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        mempoolClass: 3,
      },
    })) as { ok: true; txHash: string };
    expect(r.ok).toBe(true);
    expect(submitEncryptedMlDsaTx).toHaveBeenCalledWith({
      to: "0x0000000000000000000000000000000000001001",
      value: "0x0",
      data: "0x2468786f" + "00".repeat(192),
      mempoolClass: 3,
      gas: "0x30d40",
      nonce: "0x0",
      maxFeePerGas: "0x2540be401",
      maxPriorityFeePerGas: "0x2540be400",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// wallet-mrv-submit-plan
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-mrv-submit-plan", () => {
  const CONTRACT = "0x2222222222222222222222222222222222222222";
  const CONTRACT_TYPED = addressToTypedBech32("contract", CONTRACT);

  function buildSubmitPlan() {
    return buildWalletMrvCallNativePlan({
      fromAddress: DETERMINISTIC_ADDRESS,
      contractAddress: CONTRACT_TYPED,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      nonceHex: "0x8",
      executionUnitLimitHex: "0x200000",
      maxExecutionFeeLythoshiHex: "0x989680",
      priorityTipLythoshiHex: "0x5",
      input: "0xaabbccdd",
      valueWeiHex: "0x2a",
    });
  }

  it("submits a previewed MRV plan with its native transaction extension", async () => {
    const plan = buildSubmitPlan();
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-submit-plan",
      payload: { plan, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; txHash: string; via: string };

    expect(r).toEqual({
      ok: true,
      txHash: SUBMITTED_TX_HASH,
      via: "mock-operator",
    });
    expect(submitEncryptedMlDsaTx).toHaveBeenCalledWith({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      nonce: "0x8",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0x5",
      chainIdHex: "0x10f2c",
      extensions: [{ kind: 48, bodyHex: "0x01" }],
    });
  });

  it("returns the locked-wallet error before signing", async () => {
    unlocked = false;
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-submit-plan",
      payload: { plan: buildSubmitPlan(), chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: false; reason?: string };

    expect(r).toEqual({ ok: false, reason: "wallet locked" });
    expect(submitEncryptedMlDsaTx).not.toHaveBeenCalled();
  });

  it("blocks tampered preview plans before encrypted submission", async () => {
    const plan = buildSubmitPlan();
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-submit-plan",
      payload: {
        plan: { ...plan, tx: { ...plan.tx, extensions: [] } },
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    })) as { ok: false; reason?: string };

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exactly one transaction extension/);
    expect(submitEncryptedMlDsaTx).not.toHaveBeenCalled();
  });

  it("submits a previewed MRV plan through the dapp provider boundary", async () => {
    const origin = "https://mrv-provider.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;

    const plan = buildSubmitPlan();
    const r = await dispatchRpc(
      "monolythium_submitMrvNativePlan",
      [{ plan, chainIdHex: TESTNET_CHAIN_ID_HEX }],
      origin,
    );

    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      txHash: SUBMITTED_TX_HASH,
      via: "mock-operator",
    });
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(true);
    const approval = enqueuedApprovals.find((a) => a.kind === "send_tx");
    expect(approval?.tx).toMatchObject({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0x5",
      nonce: "0x8",
      chainId: "0x10f2c",
    });
    expect(approval?.view).toMatchObject({
      executionUnitLimitHex: "0x200000",
      pricePerExecutionUnitLythoshiHex: "0x989680",
      nonce: "0x8",
      chainId: TESTNET_CHAIN_ID_HEX,
      chainLabel: "Sprintnet",
    });
    expect(submitEncryptedMlDsaTx).toHaveBeenCalledWith({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      nonce: "0x8",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0x5",
      chainIdHex: "0x10f2c",
      extensions: [{ kind: 48, bodyHex: "0x01" }],
    });
  });

  it("builds and submits an MRV native call through the dapp provider boundary", async () => {
    const origin = "https://mrv-provider-call.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;
    rpcResponses["lyth_getTransactionCount"] = 8;
    rpcResponses["eth_feeHistory"] = {
      baseFeePerGas: ["0x1"],
      reward: [["0x1"]],
    };

    const r = await dispatchRpc(
      "monolythium_submitMrvNativeCall",
      [{
        contractAddress: CONTRACT_TYPED,
        input: "0xaabbccdd",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        executionUnitLimitHex: "0x200000",
        valueWeiHex: "0x2a",
      }],
      origin,
    );

    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({
      txHash: SUBMITTED_TX_HASH,
      via: "mock-operator",
      plan: {
        kind: "mrv_call",
        request: {
          input: "0xaabbccdd",
          valueLythoshi: "42",
        },
      },
    });
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(true);
    const approval = enqueuedApprovals.find((a) => a.kind === "send_tx");
    expect(approval?.tx).toMatchObject({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      gasPrice: "0x2540be401",
      maxFeePerGas: "0x2540be401",
      maxPriorityFeePerGas: "0x2540be400",
      nonce: "0x8",
      chainId: "0x10f2c",
    });
    expect(approval?.view).toMatchObject({
      executionUnitLimitHex: "0x200000",
      pricePerExecutionUnitLythoshiHex: "0x2540be401",
      nonce: "0x8",
      chainId: TESTNET_CHAIN_ID_HEX,
      chainLabel: "Sprintnet",
    });
    expect(submitEncryptedMlDsaTx).toHaveBeenCalledWith({
      to: CONTRACT,
      value: "0x2a",
      data: "0xaabbccdd",
      gas: "0x200000",
      nonce: "0x8",
      maxFeePerGas: "0x2540be401",
      maxPriorityFeePerGas: "0x2540be400",
      chainIdHex: "0x10f2c",
      extensions: [{ kind: 48, bodyHex: "0x01" }],
    });
    expect(rpcCalls.some((c) => c.method === "eth_getTransactionCount")).toBe(false);
  });

  it("rejects raw MRV native call contract addresses at the dapp boundary", async () => {
    const origin = "https://mrv-provider-call.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;

    const r = await dispatchRpc(
      "monolythium_submitMrvNativeCall",
      [{
        contractAddress: CONTRACT,
        input: "0xaabbccdd",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        executionUnitLimitHex: "0x200000",
        valueWeiHex: "0x2a",
      }],
      origin,
    );

    expect(r.result).toBeUndefined();
    expect(r.error).toMatchObject({
      code: -32602,
      message:
        "MRV native contractAddress raw 0x addresses are retired; use a typed monoc1 address",
    });
    expect(rpcCalls.some((c) => c.method === "eth_getTransactionCount")).toBe(false);
    expect(enqueuedApprovals).toHaveLength(0);
    expect(submitEncryptedMlDsaTx).not.toHaveBeenCalled();
  });

  it("rejects provider MRV submissions from unconnected origins", async () => {
    const r = await dispatchRpc(
      "monolythium_submitMrvNativePlan",
      [{ plan: buildSubmitPlan(), chainIdHex: TESTNET_CHAIN_ID_HEX }],
      "https://mrv-provider-unconnected.example",
    );

    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4100);
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(false);
    expect(submitEncryptedMlDsaTx).not.toHaveBeenCalled();
  });

  it("blocks tampered provider MRV plans before approval", async () => {
    const origin = "https://mrv-provider-tampered.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;
    const plan = buildSubmitPlan();

    const r = await dispatchRpc(
      "monolythium_submitMrvNativePlan",
      [{
        plan: { ...plan, tx: { ...plan.tx, extensions: [] } },
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      }],
      origin,
    );

    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toMatch(/exactly one transaction extension/);
    expect(enqueuedApprovals.some((a) => a.kind === "send_tx")).toBe(false);
    expect(submitEncryptedMlDsaTx).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-mrv-receipt-status
// ─────────────────────────────────────────────────────────────────────────────

describe("wallet-mrv-receipt-status", () => {
  it("returns null while the MRV submission receipt is still pending", async () => {
    rpcResponses["eth_getTransactionReceipt"] = null;

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; receipt: null; via?: string };

    expect(r).toEqual({ ok: true, receipt: null, via: "mock-operator" });
    expect(rpcCalls).toContainEqual({
      method: "eth_getTransactionReceipt",
      params: [SUBMITTED_TX_HASH],
    });
  });

  it("returns MRV transaction inclusion status without proof fields", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: "0x2222222222222222222222222222222222222222",
      logs: [{ fabricatedProof: true }],
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: null,
      proofLikeField: { ignored: true },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        txHash: string;
        status: string | null;
        blockNumber: string | null;
        contractAddress: string | null;
        nativeReceipt: {
          schema: string | null;
          txType: number | null;
          artifactHash: string | null;
          receiptCommitment: string | null;
          eventCount: number | null;
          noEvmProof: unknown;
          noEvmProofStatus: string;
          noEvmProofVerification: unknown;
          noEvmArchiveVerification: unknown;
          noEvmFinalityVerification: unknown;
          proofLikeField?: unknown;
        } | null;
        logs?: unknown[];
      };
      via?: string;
    };

    expect(r).toEqual({
      ok: true,
      receipt: {
        txHash: SUBMITTED_TX_HASH,
        status: "0x1",
        blockNumber: "0x64",
        contractAddress: "0x2222222222222222222222222222222222222222",
        nativeReceipt: {
          schema: "riscv.receipt.v1",
          txType: 0x41,
          artifactHash: "0x" + "b".repeat(64),
          receiptCommitment: RECEIPT_COMMITMENT,
          eventCount: 1,
          noEvmProof: null,
          noEvmProofStatus: "missing",
          noEvmProofVerification: null,
          noEvmArchiveVerification: null,
          noEvmFinalityVerification: null,
        },
      },
      via: "mock-operator",
    });
    expect(r.receipt.logs).toBeUndefined();
    expect(r.receipt.nativeReceipt?.proofLikeField).toBeUndefined();
    expect(rpcCalls).toContainEqual({
      method: "lyth_nativeReceipt",
      params: [SUBMITTED_TX_HASH],
    });
  });

  it("verifies a self-consistent no-EVM receipt-proof transcript", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...NO_EVM_RECEIPT_PROOF,
        extraIgnoredField: true,
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: unknown;
          noEvmProofStatus: string;
          noEvmProofVerification: unknown;
          noEvmArchiveVerification: unknown;
          noEvmFinalityVerification: unknown;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt).toMatchObject({
      noEvmProof: NO_EVM_RECEIPT_PROOF,
      noEvmProofStatus: "transcript-verified",
      noEvmArchiveVerification: null,
      noEvmFinalityVerification: null,
      noEvmProofVerification: {
        status: "verified",
        receiptCountMatches: true,
        receiptsRootMatches: true,
        targetReceiptHashMatches: true,
        receiptCount: 2,
        transcriptCount: 2,
        computedReceiptsRoot: NO_EVM_RECEIPT_PROOF.receiptsRoot,
        computedTargetReceiptHash: NO_EVM_RECEIPT_PROOF.targetReceiptHash,
      },
    });
  });

  it("accepts compact no-EVM receipt proofs from the indexer receipt archive", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: unknown;
          noEvmProofStatus: string;
          noEvmProofVerification: unknown;
          noEvmArchiveVerification: unknown;
          noEvmFinalityVerification: unknown;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt).toMatchObject({
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
      noEvmProofStatus: "proof-verified",
      noEvmArchiveVerification: {
        status: "unconfigured",
        reason: "trusted archive signer config not configured",
        details: null,
      },
      noEvmFinalityVerification: {
        status: "unverified",
        reason: "trusted BLS finality config not configured",
        details: null,
      },
      noEvmProofVerification: {
        status: "verified",
        proofKind: "compactInclusion",
        receiptCountMatches: true,
        receiptsRootMatches: true,
        targetReceiptHashMatches: true,
        compactLeafHashMatches: true,
        compactPathMatches: true,
        receiptCount: 1,
        transcriptCount: 0,
        computedReceiptsRoot: COMPACT_RECEIPT_LEAF_HASH,
        computedTargetReceiptHash: COMPACT_RECEIPT_HASH,
        computedCompactLeafHash: COMPACT_RECEIPT_LEAF_HASH,
      },
    });
    expect(mockGetNoEvmReceiptTrustPolicy).toHaveBeenCalledWith("testnet-69420");
  });

  it("uses bundled registry archive and finality trust when caller and env trust are absent", async () => {
    const blsResult = {
      finalityEvidencePresent: true,
      signerCountMatches: true,
      signerBitmapMatchesIndices: true,
      signerIndicesInRange: true,
      allSignersTrusted: true,
      thresholdMet: true,
      signatureValid: true,
      acceptedSignatureCount: 2,
      requiredSignatureCount: 2,
      verified: true,
    };
    mockGetNoEvmReceiptTrustPolicy.mockReturnValue(registryReceiptTrustPolicy());
    mockVerifyNoEvmFinalityEvidenceThreshold.mockReturnValue(blsResult);
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
          signatures: [REGISTRY_ARCHIVE_SIGNATURE],
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: unknown;
          noEvmFinalityVerification: unknown;
        } | null;
      };
    };

    expect(mockGetNoEvmReceiptTrustPolicy).toHaveBeenCalledTimes(1);
    expect(mockGetNoEvmReceiptTrustPolicy).toHaveBeenCalledWith("testnet-69420");
    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification).toEqual({
      status: "verified",
      reason: null,
      details: {
        verified: true,
        threshold: 1,
        validSigners: [REGISTRY_ARCHIVE_SIGNER.getAddress()],
        checkedSignatures: 1,
        issues: [],
      },
    });
    expect(mockVerifyNoEvmFinalityEvidenceThreshold).toHaveBeenCalledTimes(1);
    const options = mockVerifyNoEvmFinalityEvidenceThreshold.mock.calls[0]?.[1] as {
      chainId: bigint;
      clusterPublicKey: Uint8Array;
      committeeSize: number;
      threshold: number;
    };
    expect(options.chainId).toBe(69420n);
    expect(Array.from(options.clusterPublicKey)).toEqual(
      Array.from(REGISTRY_FINALITY_CLUSTER_PUBLIC_KEY),
    );
    expect(options.committeeSize).toBe(7);
    expect(options.threshold).toBe(2);
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification).toEqual({
      status: "verified",
      reason: null,
      details: blsResult,
    });
  });

  it("fails closed when registry finality trust uses unsupported multisig mode", async () => {
    mockGetNoEvmReceiptTrustPolicy.mockReturnValue({
      chainId: 69420,
      finality: {
        mode: "multisig",
        chainId: 69420,
        threshold: 1,
        trustedSigners: [],
      },
    } satisfies NoEvmReceiptTrustPolicy);
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmFinalityVerification: {
            status: string;
            reason: string | null;
            details: unknown;
          };
        } | null;
      };
    };

    expect(mockVerifyNoEvmFinalityEvidenceThreshold).not.toHaveBeenCalled();
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification).toEqual({
      status: "mismatch",
      reason:
        "registry BLS finality trust mode multisig is not supported by browser wallet threshold-cluster verification",
      details: null,
    });
  });

  it("uses caller finality and env archive trust ahead of bundled registry trust", async () => {
    const blsResult = {
      finalityEvidencePresent: true,
      signerCountMatches: true,
      signerBitmapMatchesIndices: true,
      signerIndicesInRange: true,
      allSignersTrusted: true,
      thresholdMet: true,
      signatureValid: true,
      acceptedSignatureCount: 2,
      requiredSignatureCount: 2,
      verified: true,
    };
    vi.stubEnv(
      "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
      TRUSTED_ARCHIVE_PUBLIC_KEY,
    );
    vi.stubEnv("VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD", "1");
    mockGetNoEvmReceiptTrustPolicy.mockReturnValue(registryReceiptTrustPolicy());
    mockVerifyNoEvmFinalityEvidenceThreshold.mockReturnValue(blsResult);
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
          signatures: [TRUSTED_ARCHIVE_SIGNATURE],
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: {
        txHash: SUBMITTED_TX_HASH,
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        finalityTrust: {
          chainIdHex: TESTNET_CHAIN_ID_HEX,
          clusterPublicKey: FINALITY_CLUSTER_PUBLIC_KEY,
          committeeSize: 7,
          threshold: 2,
        },
      },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: unknown;
          noEvmFinalityVerification: unknown;
        } | null;
      };
    };

    expect(mockGetNoEvmReceiptTrustPolicy).not.toHaveBeenCalled();
    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification).toEqual({
      status: "verified",
      reason: null,
      details: {
        verified: true,
        threshold: 1,
        validSigners: [TRUSTED_ARCHIVE_SIGNER.getAddress()],
        checkedSignatures: 1,
        issues: [],
      },
    });
    const options = mockVerifyNoEvmFinalityEvidenceThreshold.mock.calls[0]?.[1] as {
      chainId: bigint;
      clusterPublicKey: Uint8Array;
      committeeSize: number;
      threshold: number;
    };
    expect(options.chainId).toBe(69420n);
    expect(mrvTestBytesToHex(options.clusterPublicKey)).toBe(FINALITY_CLUSTER_PUBLIC_KEY);
    expect(options.committeeSize).toBe(7);
    expect(options.threshold).toBe(2);
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification).toEqual({
      status: "verified",
      reason: null,
      details: blsResult,
    });
  });

  it("verifies archive proof signatures with configured trusted ML-DSA signers", async () => {
    vi.stubEnv(
      "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
      TRUSTED_ARCHIVE_PUBLIC_KEY,
    );
    vi.stubEnv("VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD", "1");
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
          signatures: [TRUSTED_ARCHIVE_SIGNATURE],
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: unknown;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification).toEqual({
      status: "verified",
      reason: null,
      details: {
        verified: true,
        threshold: 1,
        validSigners: [TRUSTED_ARCHIVE_SIGNER.getAddress()],
        checkedSignatures: 1,
        issues: [],
      },
    });
  });

  it("falls back to covering snapshot signatures when exact-height signatures are absent", async () => {
    vi.stubEnv(
      "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
      TRUSTED_ARCHIVE_PUBLIC_KEY,
    );
    vi.stubEnv("VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD", "1");
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    const coveringSnapshotSignature = archiveSignatureForDigest(
      ARCHIVE_COVERING_SNAPSHOT.signatureDigest,
      TRUSTED_ARCHIVE_SIGNER,
    );
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatures: [],
          coveringSnapshot: {
            ...ARCHIVE_COVERING_SNAPSHOT,
            signatures: [coveringSnapshotSignature],
          },
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: {
            status: string;
            details: { checkedSignatures: number; validSigners: string[] } | null;
          };
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification.status).toBe(
      "verified",
    );
    expect(
      r.receipt.nativeReceipt?.noEvmArchiveVerification.details?.checkedSignatures,
    ).toBe(1);
    expect(
      r.receipt.nativeReceipt?.noEvmArchiveVerification.details?.validSigners,
    ).toEqual([TRUSTED_ARCHIVE_SIGNER.getAddress()]);
  });

  it("reports archive signature mismatches against configured trusted signers", async () => {
    vi.stubEnv(
      "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
      TRUSTED_ARCHIVE_PUBLIC_KEY,
    );
    vi.stubEnv("VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD", "1");
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
          signatures: [ARCHIVE_PROOF_SIGNATURE],
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: {
            status: string;
            reason: string | null;
            details: { issues: Array<{ code: string }> } | null;
          };
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification.status).toBe(
      "mismatch",
    );
    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification.reason).toBe(
      "archive proof signatures did not verify against configured trusted signers",
    );
    expect(
      r.receipt.nativeReceipt?.noEvmArchiveVerification.details?.issues.map(
        (issue) => issue.code,
      ),
    ).toContain("untrusted_signer");
  });

  it("reports invalid archive trust config without verifying signatures", async () => {
    vi.stubEnv(
      "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
      TRUSTED_ARCHIVE_PUBLIC_KEY,
    );
    vi.stubEnv("VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD", "2");
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmArchiveVerification: {
            status: string;
            reason: string | null;
            details: unknown;
          };
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmArchiveVerification).toEqual({
      status: "config-invalid",
      reason:
        "environment archive signature threshold exceeds trusted signer count",
      details: null,
    });
  });

  it("verifies BLS finality evidence with caller-supplied threshold cluster trust", async () => {
    const blsResult = {
      finalityEvidencePresent: true,
      signerCountMatches: true,
      signerBitmapMatchesIndices: true,
      signerIndicesInRange: true,
      allSignersTrusted: true,
      thresholdMet: true,
      signatureValid: true,
      acceptedSignatureCount: 2,
      requiredSignatureCount: 2,
      verified: true,
    };
    mockVerifyNoEvmFinalityEvidenceThreshold.mockReturnValue(blsResult);
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: {
        txHash: SUBMITTED_TX_HASH,
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        finalityTrust: {
          chainIdHex: TESTNET_CHAIN_ID_HEX,
          clusterPublicKey: FINALITY_CLUSTER_PUBLIC_KEY,
          committeeSize: 7,
          threshold: 2,
        },
      },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmFinalityVerification: unknown;
        } | null;
      };
    };

    expect(mockVerifyNoEvmFinalityEvidenceThreshold).toHaveBeenCalledTimes(1);
    expect(mockVerifyNoEvmFinalityEvidenceThreshold.mock.calls[0]?.[0]).toEqual(
      NO_EVM_FINALITY_EVIDENCE,
    );
    const options = mockVerifyNoEvmFinalityEvidenceThreshold.mock.calls[0]?.[1] as {
      chainId: bigint;
      clusterPublicKey: Uint8Array;
      committeeSize: number;
      threshold: number;
    };
    expect(options.chainId).toBe(69420n);
    expect(options.clusterPublicKey).toBeInstanceOf(Uint8Array);
    expect(options.clusterPublicKey).toHaveLength(48);
    expect(options.committeeSize).toBe(7);
    expect(options.threshold).toBe(2);
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification).toEqual({
      status: "verified",
      reason: null,
      details: blsResult,
    });
  });

  it.each([
    [
      "malformed cluster key",
      {
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        clusterPublicKey: "0x1234",
        committeeSize: 7,
        threshold: 2,
      },
      "clusterPublicKey must be 48 bytes",
    ],
    [
      "mismatched chain id",
      {
        chainIdHex: "0x1",
        clusterPublicKey: FINALITY_CLUSTER_PUBLIC_KEY,
        committeeSize: 7,
        threshold: 2,
      },
      "does not match the receipt request chain id",
    ],
  ])("fails closed on %s in caller finality trust config", async (_case, finalityTrust, reason) => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: {
        txHash: SUBMITTED_TX_HASH,
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        finalityTrust,
      },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmFinalityVerification: { status: string; reason: string | null };
        } | null;
      };
    };

    expect(mockVerifyNoEvmFinalityEvidenceThreshold).not.toHaveBeenCalled();
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification.status).toBe(
      "mismatch",
    );
    expect(r.receipt.nativeReceipt?.noEvmFinalityVerification.reason).toContain(
      reason,
    );
  });

  it("accepts non-empty archive proof signatures with the snapshot signature envelope", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    const noEvmProof = {
      ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
      archiveProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
        signatures: [ARCHIVE_PROOF_SIGNATURE],
      },
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof,
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: {
            archiveProof: { signatures: string[] } | null;
          };
          noEvmProofStatus: string;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmProof.archiveProof?.signatures).toEqual([
      ARCHIVE_PROOF_SIGNATURE,
    ]);
    expect(r.receipt.nativeReceipt?.noEvmProofStatus).toBe("proof-verified");
  });

  it("preserves a valid archive proof snapshot signature digest", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: {
            archiveProof: { signatureDigest?: string } | null;
          };
          noEvmProofStatus: string;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmProof.archiveProof?.signatureDigest).toBe(
      ARCHIVE_SIGNATURE_DIGEST,
    );
    expect(r.receipt.nativeReceipt?.noEvmProofStatus).toBe("proof-verified");
  });

  it("preserves a valid archive proof covering snapshot without claiming archive signature verification", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          coveringSnapshot: ARCHIVE_COVERING_SNAPSHOT,
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: {
            archiveProof: {
              coveringSnapshot?: typeof ARCHIVE_COVERING_SNAPSHOT;
            } | null;
          };
          noEvmProofStatus: string;
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt?.noEvmProof.archiveProof?.coveringSnapshot).toEqual(
      ARCHIVE_COVERING_SNAPSHOT,
    );
    expect(r.receipt.nativeReceipt?.noEvmProofStatus).toBe("proof-verified");
  });

  it.each([
    ["absent", undefined],
    ["null", null],
  ])("accepts archive proof signatureDigest when %s", async (_case, signatureDigest) => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    const archiveProof =
      signatureDigest === undefined
        ? INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof
        : {
            ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
            signatureDigest,
          };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof,
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProof: {
            archiveProof: { signatureDigest?: string } | null;
          };
          noEvmProofStatus: string;
        } | null;
      };
    };

    expect(
      r.receipt.nativeReceipt?.noEvmProof.archiveProof?.signatureDigest,
    ).toBeUndefined();
    expect(r.receipt.nativeReceipt?.noEvmProofStatus).toBe("proof-verified");
  });

  it.each([
    ["not a string", 12],
    ["short hash", "0x" + "e".repeat(62)],
    ["long hash", "0x" + "e".repeat(66)],
    ["missing prefix", "e".repeat(64)],
    ["non-hex", "0x" + "e".repeat(63) + "z"],
  ])("rejects archive proof signatureDigest with malformed %s", async (_case, signatureDigest) => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatureDigest,
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "lyth_nativeReceipt returned malformed native receipt",
      method: "lyth_nativeReceipt",
      via: "mock-operator",
    });
  });

  it.each([
    [
      "prefix",
      "mono.snapshot.sig.v2:0x" + "d".repeat(40) + ":0x1234abcd",
    ],
    [
      "field count",
      "mono.snapshot.sig.v1:0x" + "d".repeat(40) + ":0x1234abcd:extra",
    ],
    [
      "signer id length",
      "mono.snapshot.sig.v1:0x" + "d".repeat(38) + ":0x1234abcd",
    ],
    [
      "signer id hex",
      "mono.snapshot.sig.v1:0x" + "d".repeat(39) + "z:0x1234abcd",
    ],
    ["payload", "mono.snapshot.sig.v1:0x" + "d".repeat(40) + ":0x"],
    ["payload hex", "mono.snapshot.sig.v1:0x" + "d".repeat(40) + ":0x1234zz"],
  ])("rejects archive proof signatures with malformed %s", async (_case, signature) => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          signatures: [signature],
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "lyth_nativeReceipt returned malformed native receipt",
      method: "lyth_nativeReceipt",
      via: "mock-operator",
    });
  });

  it.each([
    ["snapshotHeight", { snapshotHeight: "101" }],
    ["manifestHash", { manifestHash: "0x" + "a".repeat(62) }],
    ["signatureDigest", { signatureDigest: null }],
    ["contentHash", { contentHash: "0x" + "c".repeat(63) + "z" }],
    ["checkpointContentHash", { checkpointContentHash: "0x" + "8".repeat(64) }],
    ["checkpointFrom", { checkpointFrom: 1 }],
    ["checkpointTo beyond snapshotHeight", { checkpointTo: 102 }],
    ["checkpointTo blockHeight mismatch", { checkpointTo: 100 }],
    ["signatures", { signatures: [ "mono.snapshot.sig.v1:0x" + "d".repeat(40) + ":0x" ] }],
    ["empty signatures", { signatures: [] }],
  ])("rejects archive covering snapshot with malformed %s", async (_case, patch) => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x65",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
        archiveProof: {
          ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof,
          coveringSnapshot: {
            ...ARCHIVE_COVERING_SNAPSHOT,
            ...patch,
          },
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "lyth_nativeReceipt returned malformed native receipt",
      method: "lyth_nativeReceipt",
      via: "mock-operator",
    });
  });

  it("keeps well-formed no-EVM transcript mismatches visible with computed evidence", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...NO_EVM_RECEIPT_PROOF,
        receiptsRoot: "0x" + "4".repeat(64),
        targetReceiptHash: "0x" + "5".repeat(64),
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: {
          noEvmProofStatus: string;
          noEvmProofVerification: {
            status: string;
            receiptCountMatches: boolean;
            receiptsRootMatches: boolean;
            targetReceiptHashMatches: boolean;
            computedReceiptsRoot: string;
            computedTargetReceiptHash: string;
          };
        } | null;
      };
    };

    expect(r.receipt.nativeReceipt).toMatchObject({
      noEvmProofStatus: "transcript-mismatch",
      noEvmProofVerification: {
        status: "mismatch",
        receiptCountMatches: true,
        receiptsRootMatches: false,
        targetReceiptHashMatches: false,
        computedReceiptsRoot: NO_EVM_RECEIPT_PROOF.receiptsRoot,
        computedTargetReceiptHash: NO_EVM_RECEIPT_PROOF.targetReceiptHash,
      },
    });
  });

  it("rejects malformed no-EVM receipt-proof transcripts", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...NO_EVM_RECEIPT_PROOF,
        receiptCount: 3,
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "lyth_nativeReceipt returned malformed native receipt",
      method: "lyth_nativeReceipt",
      via: "mock-operator",
    });
  });

  it("rejects malformed no-EVM finality evidence", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: null,
    };
    rpcResponses["lyth_nativeReceipt"] = {
      schema: "riscv.receipt.v1",
      txType: 0x41,
      artifactHash: "0x" + "b".repeat(64),
      receiptCommitment: RECEIPT_COMMITMENT,
      eventCount: 1,
      noEvmProof: {
        ...NO_EVM_RECEIPT_PROOF,
        finalityEvidence: {
          ...NO_EVM_FINALITY_EVIDENCE,
          certificate: {
            ...NO_EVM_FINALITY_EVIDENCE.certificate,
            signerCount: 1,
          },
        },
      },
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "lyth_nativeReceipt returned malformed native receipt",
      method: "lyth_nativeReceipt",
      via: "mock-operator",
    });
  });

  it("keeps inclusion visible when native receipt evidence is unavailable", async () => {
    rpcResponses["eth_getTransactionReceipt"] = {
      transactionHash: SUBMITTED_TX_HASH,
      status: "0x1",
      blockNumber: "0x64",
      contractAddress: null,
    };
    rpcErrors["lyth_nativeReceipt"] = {
      code: -32090,
      message: "transaction native receipt missing",
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      receipt: {
        nativeReceipt: null;
        nativeReceiptError?: { reason: string; code?: number; method?: string };
      };
    };

    expect(r.receipt.nativeReceipt).toBeNull();
    expect(r.receipt.nativeReceiptError).toEqual({
      reason: "transaction native receipt missing",
      method: "lyth_nativeReceipt",
      code: -32090,
    });
  });

  it("surfaces exact receipt RPC blockers instead of fabricating status", async () => {
    rpcErrors["eth_getTransactionReceipt"] = {
      code: -32601,
      message: "method not found",
    };

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-mrv-receipt-status",
      payload: { txHash: SUBMITTED_TX_HASH, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: false;
      reason?: string;
      code?: number;
      method?: string;
    };

    expect(r).toEqual({
      ok: false,
      reason: "method not found",
      method: "eth_getTransactionReceipt",
      code: -32601,
    });
  });
});
