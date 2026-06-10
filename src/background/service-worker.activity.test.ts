// Integration coverage for service-worker handlers:
//   - wallet-activity-get
//   - wallet-resolve-names
//   - wallet-indexer-status
//   - persistPendingRowBackground side-effect of wallet-send-tx
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
// Mock the OS notification + badge layer so existing tests
// don't have to stub chrome.notifications + chrome.action. The Phase-2
// behavior (toast / badge / click) is unit-tested in notifications-os.test.ts;
// this mock just keeps the SW import graph happy and lets the dedupe test
// below count fireOsNotification calls across two snapshot ticks.
const mockFireOsNotification = vi.hoisted(() => vi.fn(async () => {}));
const mockRefreshUnreadBadge = vi.hoisted(() => vi.fn(async () => {}));
const mockInstallNotificationsClickListener = vi.hoisted(() => vi.fn(() => {}));
// Item 7c — incoming-toast toggle. Default ON; the toggle-OFF test overrides.
const mockGetIncomingEnabled = vi.hoisted(() => vi.fn(async () => true));
// Presence probe. Default false (closed) so existing tests
// record read:false (today's behavior); C3 tests override per-case.
const mockIsWalletSurfaceOpen = vi.hoisted(() => vi.fn(async () => false));
vi.mock("./notifications-os.js", () => ({
  fireOsNotification: mockFireOsNotification,
  refreshUnreadBadge: mockRefreshUnreadBadge,
  installNotificationsClickListener: mockInstallNotificationsClickListener,
  isWalletSurfaceOpen: mockIsWalletSurfaceOpen,
  getIncomingEnabled: mockGetIncomingEnabled,
}));

const DETERMINISTIC_ADDRESS = DETERMINISTIC_TEST_ADDRESS;
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

// Capture of testnetJsonRpc calls. Each test seeds responses keyed by
// JSON-RPC method; failures can be seeded with explicit error codes.
interface CapturedRpcCall {
  method: string;
  params: unknown[];
}
const rpcCalls: CapturedRpcCall[] = [];
// Capture of submitMlDsaTx argument objects — used by the
// metadata-only invariant test (assert opKind never reaches the signer).
const submitMlDsaCalls: Record<string, unknown>[] = [];
let rpcResponses: Record<string, unknown> = {};
let rpcErrors: Record<string, { code: number; message: string }> = {};

vi.mock("./tx-mldsa.js", () => ({
  testnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
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
  testnetMaxBalanceConsensus: vi.fn(async (_address: string) => ({
    balanceHex: "0x0",
    spendGuardHex: "0x0",
    contributing: [{ name: "mock-operator", balanceHex: "0x0" }],
    failing: [],
  })),
  // The DEFAULT (and only) submit path: `wallet-send-tx` plus the dApp
  // eth_sendTransaction / MRV / multisig paths all route here. It feeds
  // `submitMlDsaCalls` so the metadata-only invariant (`opKind` / cluster
  // never reach the signer) and the arg-shape assertions hold.
  submitMlDsaTx: vi.fn(async (args: Record<string, unknown>) => {
    submitMlDsaCalls.push(args);
    if (submitFailure !== null) {
      throw submitFailure;
    }
    return {
      txHash: SUBMITTED_TX_HASH,
      via: "mock-operator",
      innerSighashHex: "0x" + "b".repeat(64),
    };
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
  "round certificate for block round";
const NO_EVM_FINALITY_EVIDENCE = {
  schema: "mono.no_evm_receipt_finality.v1",
  source: "roundCertificate",
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
    NO_EVM_RECEIPT_PROOF_RECEIPTS_ROOT,
  targetReceiptHash:
    NO_EVM_RECEIPT_PROOF_TARGET_RECEIPT_HASH,
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

// Networks: only the bits the handlers touch. the testnet chain id is
// "MlDsa" per the SW's gating helper; suggestFee returns a deterministic
// fee structure so wallet-send-tx can complete the broadcast preamble.
vi.mock("./networks.js", () => ({
  chainRequiresMlDsa: vi.fn((chainIdHex: string) =>
    chainIdHex.toUpperCase() === TESTNET_CHAIN_ID_HEX.toUpperCase(),
  ),
  // Real value (0x7530 = 30000, the mempool intrinsic floor). A no-hint
  // native send resolves its unit limit to this floor; the old wallet-send-tx
  // fallback literal (0x5208 = 21000) was below it (F-3.9/#26).
  TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX: "0x7530",
  // T4-04 fee ceiling — real value so the clamp tests are meaningful.
  MAX_EXECUTION_UNIT_PRICE_LYTHOSHI: 1_000_000_000_000_000n,
  // F-3.11/#28 unit-limit ceiling — real value so the limit-clamp test is meaningful.
  MAX_EXECUTION_UNIT_LIMIT: 30_000_000n,
  probeFirstAliveOperator: vi.fn(async () => ({ name: "mock", rpc: "http://mock" })),
  BUILTIN_CHAINS: [
    {
      chainId: TESTNET_CHAIN_ID_HEX,
      name: "Monolythium Testnet",
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
  classifyNoOperatorReason: vi.fn(() => "unreachable"),
}));

// Keystore (v4) — fixed unlocked address, never actually signs. The
// `computeTypedDataDigest` helper now lives in ./typed-data.js (pure, no
// chrome dependency) and runs for real — no mock needed.
let unlocked = true;
// T1-04(a) passkey-cap gate controls. Default INERT (no active passkey
// vault) so every existing send test behaves exactly as before the gate.
let activePasskeyVaultId: string | null = null;
let passkeyStateForTest: unknown = {
  policy: { enabled: false, mode: "per-tx", limitWei: 0n },
  credentials: [],
};
let correctElevatedPassword = "correct-horse-battery-staple";
// Multisig-execute harness: the meta block readMultisigMetaV4 returns. Default
// null (no multisig vault) so it is inert for every non-multisig test.
let multisigMetaForTest: unknown = null;

vi.mock("./keystore-mldsa.js", () => ({
  hasVaultV4: vi.fn(async () => true),
  hasContainerV4: vi.fn(async () => true),
  unlockContainerV4: vi.fn(async () => ({
    address: DETERMINISTIC_ADDRESS,
    vaultId: "v1",
  })),
  getUnlockedAddressV4: vi.fn(() => (unlocked ? DETERMINISTIC_ADDRESS : null)),
  // T1-04(a) passkey-cap gate seams. Default-inert (null active vault).
  getActiveVaultIdV4: vi.fn(() => activePasskeyVaultId),
  readPasskeyStateV4: vi.fn(async () => passkeyStateForTest),
  verifyContainerPasswordV4: vi.fn(
    async (pw: string) => pw === correctElevatedPassword,
  ),
  tryRestoreFromSessionV4: vi.fn(async () => ({ ok: false })),
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
  personalSignV4: vi.fn(() => new Uint8Array(65)),
  signTypedDataV4FromV4: vi.fn(() => new Uint8Array(65)),
  // Multisig-execute seams (used only by the multisig-execute handler test).
  readMultisigMetaV4: vi.fn(async () => multisigMetaForTest),
  writeMultisigMetaV4: vi.fn(async () => undefined),
  listVaultsV4: vi.fn(async () => []),
  selectActiveVaultV4: vi.fn(async () => undefined),
}));

// Multisig approval verification (shared/multisig.js): keep everything real
// except the two checks that need live ML-DSA signatures over a real proposal
// digest. The multisig-execute fee-clamp test only exercises the broadcast
// preamble, so isExecutable + signature verification are stubbed to pass; the
// real approval/signature logic is covered in shared/multisig.test.ts and
// keystore-mldsa.test.ts.
vi.mock("../shared/multisig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/multisig.js")>();
  return {
    ...actual,
    isExecutable: vi.fn(() => true),
    verifyProposalApprovals: vi.fn(() => ({
      validApprovals: new Set(["s1"]),
    })),
  };
});

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

vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  return {
    ...actual,
    RpcClient: class {
      constructor(public readonly endpoint: string) {}
      async call() {
        return null;
      }
    },
    MONOLYTHIUM_TESTNET_CHAIN_ID: 69420n,
    verifyNoEvmFinalityEvidenceThreshold:
      mockVerifyNoEvmFinalityEvidenceThreshold,
    getNoEvmReceiptTrustPolicy: mockGetNoEvmReceiptTrustPolicy,
    getRpcEndpoints: () => [
      { url: "http://test.invalid:8545", provider: "test", region: "test", tier: "official" },
    ],
    // shared/build-info.ts reads TESTNET_69420.genesis_hash at
    // module init; stub just the fields the wallet actually reads.
    TESTNET_69420: {
      chain_id: 69420,
      // genesis_hash stub — mirrors __fixtures__ TESTNET_69420_GENESIS_HASH_STUB (inline: hoisted vi.mock factory).
      genesis_hash:
        "0xcb14e03313ffa63e0315c6619ed26bce82a90d6859de76e013c0759c62b3d4c8",
    },
  };
});

import { buildWalletMrvCallNativePlan } from "../shared/mrv-native-plan.js";
import {
  ALARM_AUTO_LOCK,
  ALARM_NOTIF_POLL,
  SESSION_KEY_AUTO_LOCK_DEADLINE,
  SESSION_KEY_MEK_REHYDRATE_DEADLINE,
  SESSION_KEY_MEK_V4,
} from "../shared/constants.js";
import {
  DETERMINISTIC_TEST_ADDRESS,
  NO_EVM_RECEIPT_PROOF_RECEIPTS_ROOT,
  NO_EVM_RECEIPT_PROOF_TARGET_RECEIPT_HASH,
} from "../shared/__fixtures__/golden.js";
import { submitMlDsaTx } from "./tx-mldsa.js";

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
// Capture chrome.alarms listeners + create/clear calls so the
// notif-poll alarm lifecycle is testable. Listeners are registered once at
// SW import (beforeAll) and persist; the call arrays reset per test.
const capturedAlarmListeners: Array<(alarm: { name: string }) => void> = [];
const alarmCreateCalls: Array<{ name: string; info: unknown }> = [];
const alarmClearCalls: string[] = [];

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
      onAlarm: {
        addListener: (l: (alarm: { name: string }) => void) => {
          capturedAlarmListeners.push(l);
        },
      },
      create: (name: string, info: unknown) => {
        alarmCreateCalls.push({ name, info });
        return Promise.resolve();
      },
      clear: (name: string) => {
        alarmClearCalls.push(name);
        return Promise.resolve(true);
      },
    },
    runtime: {
      onMessage: {
        addListener: (handler: OnMessageHandler) => {
          capturedOnMessage = handler;
        },
      },
      onInstalled: { addListener: vi.fn() },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      // T2-02 — the router authenticates sender.id against this.
      id: "test",
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
    capturedOnMessage!(
      envelope,
      { id: "test", url: "chrome-extension://test/src/popup/index.html" },
      resolve,
    );
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
    const handled = capturedOnMessage!(envelope, { id: "test" }, (response: unknown) => {
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
  submitMlDsaCalls.length = 0;
  mockFireOsNotification.mockClear();
  mockRefreshUnreadBadge.mockClear();
  mockIsWalletSurfaceOpen.mockClear();
  mockIsWalletSurfaceOpen.mockResolvedValue(false);
  mockGetIncomingEnabled.mockClear();
  mockGetIncomingEnabled.mockResolvedValue(true);
  rpcResponses = {};
  rpcErrors = {};
  submitFailure = null;
  approvalDecision = { ok: true };
  enqueuedApprovals.length = 0;
  unlocked = true;
  // Reset the passkey-cap gate to inert unless a test opts in.
  activePasskeyVaultId = null;
  passkeyStateForTest = {
    policy: { enabled: false, mode: "per-tx", limitWei: 0n },
    credentials: [],
  };
  correctElevatedPassword = "correct-horse-battery-staple";
  storageLocal = {};
  storageSession = {};
  alarmCreateCalls.length = 0;
  alarmClearCalls.length = 0;
  mockVerifyNoEvmFinalityEvidenceThreshold.mockReset();
  mockGetNoEvmReceiptTrustPolicy.mockReset();
  mockGetNoEvmReceiptTrustPolicy.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // S6 closeout C5: unwind any vi.spyOn (e.g. the F-B2V-1 session.remove
  // rejection) so a spy can't leak across tests. Only affects vi.spyOn spies,
  // not the vi.fn/vi.mock module mocks.
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// keystore-status — locked address privacy (top-tier)
// ─────────────────────────────────────────────────────────────────────────────

describe("keystore-status address privacy", () => {
  it("returns the active address when unlocked", async () => {
    unlocked = true;
    const r = (await dispatchPopup({ kind: "popup", op: "keystore-status" })) as {
      hasVault: boolean;
      unlocked: boolean;
      address: string | null;
    };
    expect(r.hasVault).toBe(true);
    expect(r.unlocked).toBe(true);
    expect(r.address).toBe(DETERMINISTIC_ADDRESS);
  });

  it("returns a null address when locked (never resolves the address while locked)", async () => {
    unlocked = false;
    const r = (await dispatchPopup({ kind: "popup", op: "keystore-status" })) as {
      hasVault: boolean;
      unlocked: boolean;
      address: string | null;
    };
    expect(r.hasVault).toBe(true);
    expect(r.unlocked).toBe(false);
    expect(r.address).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// keystore wipe-scope — default-deny (S6 #43 B2)
// ─────────────────────────────────────────────────────────────────────────────

describe("keystore wipe-scope — default-deny (S6 #43 B2)", () => {
  // The sensitive families (+ the vault entries) the wipe must remove, per the
  // audit durable-key inventory. All durable wallet keys are mono.*-prefixed.
  const SENSITIVE = [
    "mono.connected-sites",
    "mono.contacts.v1",
    "mono.sent-addrs.0xabc.0x10f2c",
    "mono.activity.0xabc.0x10f2c",
    "mono.notifications.history.0xabc.0x10f2c.v1",
    "mono.names.cache",
    "mono.two-tier-features.v1",
    "mono.vault.v4",
    "mono.vaults.v4",
  ];

  function seedFamilies() {
    for (const k of SENSITIVE) storageLocal[k] = { seeded: true };
    // A non-mono local key must SURVIVE — the scan is mono.* default-deny only.
    storageLocal["nonmono.keep"] = "survives";
  }

  it("keystore-wipe-unauth removes every mono.* local key, keeps non-mono", async () => {
    seedFamilies();
    const r = (await dispatchPopup({ kind: "popup", op: "keystore-wipe-unauth" })) as { ok: boolean };
    expect(r.ok).toBe(true);
    for (const k of SENSITIVE) expect(storageLocal[k]).toBeUndefined();
    expect(storageLocal["nonmono.keep"]).toBe("survives");
  });

  it("keystore-reset (password-confirmed) wipes the IDENTICAL set", async () => {
    seedFamilies();
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-reset",
      payload: { password: "pw" },
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    for (const k of SENSITIVE) expect(storageLocal[k]).toBeUndefined();
    expect(storageLocal["nonmono.keep"]).toBe("survives");
  });

  it("closes the connected-sites carryover: a previously-connected origin no longer leaks the address after wipe + re-unlock", async () => {
    const origin = "https://prior-owner-dapp.example";
    await dispatchRpc("eth_requestAccounts", [], origin); // connects → session.connectedOrigins has origin
    const before = await dispatchRpc("eth_accounts", [], origin);
    expect(before.result).toEqual([DETERMINISTIC_ADDRESS]); // connected → address visible

    await dispatchPopup({ kind: "popup", op: "keystore-wipe-unauth" }); // clears connectedOrigins + locks
    unlocked = true; // simulate the NEW owner importing + unlocking a fresh vault

    const after = await dispatchRpc("eth_accounts", [], origin);
    expect(after.result).toEqual([]); // connectedOrigins cleared → no silent auto-reconnect / address leak
  });

  it("F-B2V-1: still disposes the in-memory backend when the lockout session.remove rejects", async () => {
    unlocked = true; // decrypted backend live (beforeEach default; explicit)
    // Force the lockout-counter session.remove (the await BEFORE triggerAutoLock)
    // to reject — the exact F-B2V-1 trigger. Pre-fix this skipped lockV4 and left
    // the decrypted backend + MEK live in the SW heap after the disk was wiped;
    // the new try/finally must zero it regardless of the rejection.
    // S6 closeout C5: vi.spyOn + mockRejectedValueOnce is self-limiting (it
    // rejects exactly once, then delegates to the original) and is unwound by
    // afterEach's restoreAllMocks — so no rejecting stub can leak into a later
    // test even if this test aborts (chrome is installed once in beforeAll, so
    // the manual swap+finally it replaces could leak on a skipped finally).
    const sessionArea = chrome.storage.session as unknown as {
      remove: (keys: string | string[], cb?: () => void) => Promise<void>;
    };
    vi.spyOn(sessionArea, "remove").mockRejectedValueOnce(
      new Error("forced session.remove failure"),
    );
    // The rejection propagates to the router catch; dispatchPopup resolves with
    // { error }. What matters is that finally { lockV4() } ran first.
    await dispatchPopup({ kind: "popup", op: "keystore-wipe-unauth" });
    expect(unlocked).toBe(false); // lockV4 (mock sets unlocked=false) ran via finally
  });

  it("C2: clears the toolbar badge on wipe-unauth (no stale unread count for the next owner)", async () => {
    mockRefreshUnreadBadge.mockClear();
    await dispatchPopup({ kind: "popup", op: "keystore-wipe-unauth" });
    // The wipe path's only refreshUnreadBadge call is the C2 clear — locked +
    // null scope → after the store is wiped it resolves to an empty badge.
    expect(mockRefreshUnreadBadge).toHaveBeenCalledWith({
      unlocked: false,
      activeAddrLower: null,
    });
  });
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
  it("rejects non-testnet chain ids", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: "0x1" },
    })) as { ok: false; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Monolythium Testnet");
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

  // C4 — deterministic pending confirmation via the canonical hash.
  function seedEmptyIndexer() {
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = []; // no heuristic match available
  }
  function seedPending(txHash: string) {
    const pendingKey =
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    storageLocal[pendingKey] = {
      pending: [
        {
          kind: "pending_tx",
          txHash,
          to: "0xrecipient",
          amountDecimal: "0.01",
          broadcastedAtMs: Date.now(),
          broadcastBlockHeight: 100,
          via: "operator-test",
        },
      ],
    };
  }

  it("BRIDGE: keeps a receipt-confirmed pending row visible when the indexer hasn't surfaced it yet (no vanish)", async () => {
    // The receipt confirms (lyth_txStatus found) but the indexer's success
    // stream hasn't indexed the activity row in this snapshot. Dropping it now
    // would make the tx vanish (pending gone, confirmed not yet indexed) — so
    // it's bridged: kept in pending (still rendered, poll still alive) until
    // the indexer surfaces the canonical confirmed row (next test).
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 200 };
    seedPending("0x" + "ab".repeat(32));
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; pending: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.pending).toHaveLength(1);
  });

  it("BRIDGE: drops the bridged row once the indexer surfaces the canonical tx_send", async () => {
    // Indexer now returns the matching tx_send (out, 0.01 LYTH = 10^16
    // lythoshi at 18-dec, to 0xrecipient, at the broadcast anchor) →
    // reconcilePending drops the pending row and the real confirmed row
    // renders. No duplicate.
    rpcResponses["lyth_getTokenBalances"] = [];
    rpcResponses["lyth_getAddressLabel"] = null;
    rpcResponses["lyth_getDelegationHistory"] = [];
    rpcResponses["lyth_getAddressActivity"] = [
      {
        blockHeight: 100,
        txIndex: 0,
        logIndex: 4294967295,
        kind: "transfer",
        direction: "out",
        counterparty: "0xrecipient",
        tokenId: null,
        amount: "10000000000000000",
        cluster: null,
        weightBps: null,
        subKind: null,
      },
    ];
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 100 };
    seedPending("0x" + "ab".repeat(32));
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as {
      ok: true;
      pending: unknown[];
      cache: { confirmed: Array<{ kind: string }> };
    };
    expect(r.ok).toBe(true);
    expect(r.pending).toHaveLength(0);
    expect(r.cache.confirmed.some((c) => c.kind === "tx_send")).toBe(true);
  });

  it("keeps a pending row when lyth_txStatus is not_found and no receipt (graceful)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = null;
    seedPending("0x" + "cd".repeat(32));
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; pending: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.pending).toHaveLength(1);
  });

  // F-3.10 / #27 — found = INCLUDED, not confirmed. The row must resolve on the
  // receipt's status bit only; a found-but-receiptless tx must NOT be
  // optimistically confirmed. The open-surface bridge stamps confirmedBlockHeight
  // on a confirmed row but leaves a kept (still-pending) row plain — so that
  // field is the discriminator.
  function getActivity() {
    return dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    }) as Promise<{ ok: true; pending: Array<{ confirmedBlockHeight?: number }> }>;
  }

  it("found + UNAVAILABLE receipt keeps the row PENDING, not optimistically confirmed (F-3.10/#27)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 200 };
    rpcResponses["eth_getTransactionReceipt"] = null; // receipt unavailable
    seedPending("0x" + "ef".repeat(32));
    const r = await getActivity();
    expect(r.ok).toBe(true);
    expect(r.pending).toHaveLength(1);
    // Old behavior would optimistically confirm (stamp confirmedBlockHeight from
    // the broadcast anchor); the fix leaves it a plain pending row.
    expect(r.pending[0]?.confirmedBlockHeight).toBeUndefined();
  });

  it("found + receipt status 0x1 confirms the row (bridged with confirmedBlockHeight) (F-3.10/#27)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 200 };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", blockNumber: 200, tx_index: 0 };
    seedPending("0x" + "ef".repeat(32));
    const r = await getActivity();
    expect(r.ok).toBe(true);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]?.confirmedBlockHeight).toBe(200);
  });

  it("found + receipt status 0x0 marks the row FAILED (dropped from pending) (F-3.10/#27)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 200 };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x0", blockNumber: 200, tx_index: 0 };
    seedPending("0x" + "ef".repeat(32));
    const r = await getActivity();
    expect(r.ok).toBe(true);
    // Failed rows are not bridged into the pending list (surfaced via the
    // failed-row notification path instead).
    expect(r.pending).toHaveLength(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bug A F1 — when pending rows exist, wallet-activity-get bypasses the 30s
  // staleness short-circuit and falls through to the authoritative reconcile
  // (dropConfirmedPendingByHash), so a tx that confirms in ~3-5s clears from
  // "pending" promptly instead of after the full 30s cache window. NARROW: a
  // non-pending refresh still serves the fresh cache. Each test primes a FRESH
  // cache first, so a cleared pending row can ONLY come from the F1 bypass
  // (not the stale >30s path).
  // ───────────────────────────────────────────────────────────────────────────

  /** First call populates the cache with lastFetchedAtMs ≈ now (fresh). */
  async function primeFreshCache() {
    seedEmptyIndexer();
    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
  }

  it("F1: with a FRESH cache + pending, bypasses the short-circuit + re-fetches; a receipt-confirmed row is bridged until the indexer surfaces it", async () => {
    await primeFreshCache();
    const callsAfterPrime = rpcCalls.length;
    // Cache is fresh (<30s). Seed a pending row + a 'found' status.
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found", blockNumber: 321 };
    seedPending("0x" + "a1".repeat(32));
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; pending: unknown[] };
    expect(r.ok).toBe(true);
    // It actually re-fetched (did not serve from the fresh cache) → F1 bypass.
    expect(rpcCalls.length).toBeGreaterThan(callsAfterPrime);
    // Confirmed via the receipt but not yet in the (empty) indexer snapshot →
    // bridged (kept visible), not vanished.
    expect(r.pending).toHaveLength(1);
  });

  it("F1: with a FRESH cache + pending, a status:0 receipt records 'failed' — never confirmed (#5117)", async () => {
    await primeFreshCache();
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 0, block_number: 654 };
    const txHash = "0x" + "b2".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0x" + "0b".repeat(20),
      amountDecimal: "0.00",
      broadcastBlockHeight: 50,
    });
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; pending: unknown[] };
    await flushNotificationMicrotasks();
    // Terminal (failed) → dropped from pending, even with a fresh cache.
    expect(r.pending).toHaveLength(0);
    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ txHash: string; status: string }> }
      | undefined;
    expect(hist?.entries.at(-1)?.status).toBe("failed");
  });

  it("F1 is narrow: with a FRESH cache + NO pending, still short-circuits (no reconcile RPC)", async () => {
    await primeFreshCache();
    const callsAfterPrime = rpcCalls.length;
    // No pending rows — a second call must serve from the fresh cache.
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    })) as { ok: true; pending: unknown[] };
    expect(r.ok).toBe(true);
    expect(rpcCalls.length).toBe(callsAfterPrime); // unchanged — cache served
    expect(rpcCalls.some((c) => c.method === "lyth_txStatus")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Notifications — post-write microtask hook fires one
  // NotificationRecord per tracked-tx terminal transition. The §0.2 invariant
  // ("status from the real on-chain receipt, never optimism") is the most
  // load-bearing assertion: a `status:0` receipt MUST be stored as
  // `status:"failed"`, never coerced to confirmed. TTL-evicted rows must
  // never fire.
  // ───────────────────────────────────────────────────────────────────────────

  /** Drain the microtask + storage stub callback queues. The hook is a
   *  post-write microtask + an async IIFE that awaits chrome.storage round-
   *  trips; one setTimeout(0) is sufficient to flush both queues. */
  async function flushNotificationMicrotasks() {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  function seedPendingCustom(args: {
    txHash: string;
    to: string;
    amountDecimal: string;
    broadcastBlockHeight: number | null;
    broadcastedAtMs?: number;
  }) {
    const pendingKey = `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    storageLocal[pendingKey] = {
      pending: [
        {
          kind: "pending_tx",
          txHash: args.txHash,
          to: args.to,
          amountDecimal: args.amountDecimal,
          broadcastedAtMs: args.broadcastedAtMs ?? Date.now(),
          broadcastBlockHeight: args.broadcastBlockHeight,
          via: "operator-test",
        },
      ],
    };
  }

  const NOTIF_HISTORY_KEY = `mono.notifications.history.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}.v1`;
  const NOTIF_NOTIFIED_KEY = `mono.notifications.notified.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}.v1`;

  it("records a 'confirmed' send notification when reconcilePending drops a heuristic-matched row", async () => {
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
        // Indexer emits raw lythoshi as a decimal string. 1.5 * 10^18
        // lythoshi → "1.5" LYTH after lythoshiDecimalToLythDecimal (18-dec),
        // matching the pending row's already-converted amountDecimal.
        amount: "1500000000000000000",
        cluster: null,
        weightBps: null,
        subKind: null,
      },
    ];
    const txHash = "0x" + "ab".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0xdead",
      amountDecimal: "1.5",
      broadcastBlockHeight: 100,
    });

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ txHash: string; status: string; kind: string; blockNumber: number | null }> }
      | undefined;
    expect(hist).toBeDefined();
    expect(hist!.entries).toHaveLength(1);
    expect(hist!.entries[0]?.txHash).toBe(txHash);
    expect(hist!.entries[0]?.status).toBe("confirmed");
    expect(hist!.entries[0]?.kind).toBe("send");
    expect(hist!.entries[0]?.blockNumber).toBe(100);
  });

  it("records a 'confirmed' contract_call when eth_getTransactionReceipt.status === 1 (b4d6101 normalizer reused)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    // The testnet operators emit numeric status + snake_case block_number —
    // the same shape the b4d6101 fix handled. Re-asserts the normalizer.
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 12345 };
    const txHash = "0x" + "11".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0x" + "01".repeat(20),
      amountDecimal: "0.05",
      broadcastBlockHeight: 200,
    });

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ txHash: string; status: string; kind: string; blockNumber: number | null }> }
      | undefined;
    expect(hist).toBeDefined();
    expect(hist!.entries).toHaveLength(1);
    expect(hist!.entries[0]?.txHash).toBe(txHash);
    expect(hist!.entries[0]?.status).toBe("confirmed");
    expect(hist!.entries[0]?.kind).toBe("contract_call");
    expect(hist!.entries[0]?.blockNumber).toBe(12345);
  });

  it("records 'failed' when eth_getTransactionReceipt.status === 0 — NEVER coerced to confirmed (§0.2)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 0, block_number: 12346 };
    const txHash = "0x" + "22".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0x" + "02".repeat(20),
      amountDecimal: "0.00",
      broadcastBlockHeight: 201,
    });

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ txHash: string; status: string; kind: string; blockNumber: number | null }> }
      | undefined;
    expect(hist).toBeDefined();
    expect(hist!.entries).toHaveLength(1);
    // THE invariant: a status:0 receipt is stored as "failed", not coerced
    // to "confirmed". This is the MetaMask #5117 hazard the OS toast
    // would otherwise reproduce.
    expect(hist!.entries[0]?.status).toBe("failed");
    expect(hist!.entries[0]?.kind).toBe("contract_call");
    expect(hist!.entries[0]?.blockNumber).toBe(12346);
  });

  it("does NOT record a notification for a TTL-evicted row (age-only eviction is not a terminal transition)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = null;
    const txHash = "0x" + "33".repeat(32);
    // Past the 5-minute TTL — evictExpiredPending will drop it, but it
    // never reached a terminal state we can attribute to the chain.
    seedPendingCustom({
      txHash,
      to: "0x" + "03".repeat(20),
      amountDecimal: "0.99",
      broadcastBlockHeight: 1,
      broadcastedAtMs: Date.now() - (5 * 60_000) - 5_000,
    });

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    expect(storageLocal[NOTIF_HISTORY_KEY]).toBeUndefined();
    expect(storageLocal[NOTIF_NOTIFIED_KEY]).toBeUndefined();
  });

  it("dedupes across snapshots — the same txHash recorded on two snapshots produces ONE record", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found" };
    // Readable confirmed receipt so the row genuinely terminalizes and a
    // notification is recorded (F-3.10/#27: found alone no longer confirms).
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", blockNumber: 300 };
    const txHash = "0x" + "44".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0x" + "04".repeat(20),
      amountDecimal: "0.10",
      broadcastBlockHeight: 300,
    });

    // First snapshot — records the notification + writes the dedupe-set entry.
    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();
    const after1 = (storageLocal[NOTIF_HISTORY_KEY] as { entries: unknown[] })
      .entries;
    expect(after1).toHaveLength(1);

    // Re-seed the same pending row + force a stale cache so the snapshot
    // path runs again. Re-seeding mimics a second snapshot tick where the
    // pending list still carries the same tx hash.
    seedPendingCustom({
      txHash,
      to: "0x" + "04".repeat(20),
      amountDecimal: "0.10",
      broadcastBlockHeight: 300,
    });
    const cacheKey = `mono.activity.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;
    const stored = storageLocal[cacheKey] as
      | { lastFetchedAtMs: number }
      | undefined;
    if (stored) {
      storageLocal[cacheKey] = { ...stored, lastFetchedAtMs: stored.lastFetchedAtMs - 60_000 };
    }

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    // Still exactly one record — the dedupe-set blocked the second insert.
    const after2 = (storageLocal[NOTIF_HISTORY_KEY] as { entries: unknown[] })
      .entries;
    expect(after2).toHaveLength(1);
    const ids = (storageLocal[NOTIF_NOTIFIED_KEY] as { ids: string[] }).ids;
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(`${TESTNET_CHAIN_ID_HEX}:${txHash}`);
    // The OS toast fires ONLY on added:true, so two snapshots
    // of the same tx produce exactly ONE fireOsNotification call (no
    // double toast). The badge refresh runs once per snapshot batch
    // that added something — only the first snapshot adds, so only one
    // refresh call.
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    expect(mockRefreshUnreadBadge).toHaveBeenCalledTimes(1);
  });

  it("hook prefers row.opKind over the coarse fallback (kind:'delegate' carried through)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 555 };
    const txHash = "0x" + "66".repeat(32);
    // Seed a pending row with the broadcast-time opKind tag attached
    // (mimics what persistPendingRowBackground writes when the popup
    // passes opKind:"delegate" through wallet-send-tx).
    storageLocal[
      `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`
    ] = {
      pending: [
        {
          kind: "pending_tx",
          txHash,
          to: "0x" + "06".repeat(20),
          amountDecimal: "0.01",
          broadcastedAtMs: Date.now(),
          broadcastBlockHeight: 500,
          via: "operator-test",
          opKind: "delegate",
        },
      ],
    };

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ kind: string; status: string }> }
      | undefined;
    expect(hist).toBeDefined();
    expect(hist!.entries).toHaveLength(1);
    // The hook used row.opKind verbatim instead of falling back to the
    // coarse "contract_call".
    expect(hist!.entries[0]?.kind).toBe("delegate");
    expect(hist!.entries[0]?.status).toBe("confirmed");
  });

  it("hook falls back to coarse 'contract_call' when row has no opKind (legacy/untagged path)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 556 };
    const txHash = "0x" + "77".repeat(32);
    // Phase-1-style pending row with NO opKind field.
    seedPendingCustom({
      txHash,
      to: "0x" + "07".repeat(20),
      amountDecimal: "0.02",
      broadcastBlockHeight: 501,
    });

    await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await flushNotificationMicrotasks();

    const hist = storageLocal[NOTIF_HISTORY_KEY] as
      | { entries: Array<{ kind: string }> }
      | undefined;
    expect(hist!.entries[0]?.kind).toBe("contract_call");
  });

  it("snapshot response returns BEFORE notification writes complete (post-write microtask placement)", async () => {
    seedEmptyIndexer();
    rpcResponses["lyth_txStatus"] = { status: "found" };
    // Readable confirmed receipt so the row terminalizes and the notification
    // I/O is queued (F-3.10/#27: found-without-receipt no longer confirms).
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", blockNumber: 400 };
    const txHash = "0x" + "55".repeat(32);
    seedPendingCustom({
      txHash,
      to: "0x" + "05".repeat(20),
      amountDecimal: "0.01",
      broadcastBlockHeight: 400,
    });

    const dispatched = dispatchPopup({
      kind: "popup",
      op: "wallet-activity-get",
      payload: { address: DETERMINISTIC_ADDRESS, chainIdHex: TESTNET_CHAIN_ID_HEX },
    });
    await dispatched;
    // Immediately after the handler resolves, the notification I/O is
    // still pending in the microtask + chrome.storage callback queue —
    // the handler must NOT have awaited it.
    expect(storageLocal[NOTIF_HISTORY_KEY]).toBeUndefined();
    // Drain queues — the notification lands now.
    await flushNotificationMicrotasks();
    expect(storageLocal[NOTIF_HISTORY_KEY]).toBeDefined();
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
  function seedTestnetNonceAndFee(nonce: number | string = "0x0") {
    rpcResponses["lyth_getTransactionCount"] = nonce;
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi: "0x2540be401",
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi: "0x2540be400",
      source: "test",
    };
  }

  it("no-hint native send resolves the unit limit to the 30000 floor, never 21000 (F-3.9/#26)", async () => {
    seedTestnetNonceAndFee();
    rpcResponses["eth_blockNumber"] = "0x64";
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x16345785d8a0000",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        // No gasLimitHex, no signedFee → the unit limit resolves to the
        // mempool intrinsic floor (0x7530 = 30000), not the old 0x5208 (21000).
      },
    })) as { ok: true };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ gas: "0x7530" }),
    );
  });

  it("successful broadcast writes a pending row", async () => {
    seedTestnetNonceAndFee();
    rpcResponses["eth_blockNumber"] = "0x64"; // 100
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0xrecipient",
        valueWeiHex: "0x16345785d8a0000", // 0.1 LYTH in lythoshi (18-dec)
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
    seedTestnetNonceAndFee();
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
    seedTestnetNonceAndFee();
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0x0000000000000000000000000000000000001001",
        valueWeiHex: "0x0",
        data: "0x2468786f" + "00".repeat(192),
        gasLimitHex: "0x30d40",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
      },
    })) as { ok: true; txHash: string };
    expect(r.ok).toBe(true);
    // DEFAULT submit = PLAINTEXT (`submitMlDsaTx`).
    expect(submitMlDsaTx).toHaveBeenCalledWith({
      to: "0x0000000000000000000000000000000000001001",
      value: "0x0",
      data: "0x2468786f" + "00".repeat(192),
      gas: "0x30d40",
      nonce: "0x0",
      maxFeePerGas: "0x2540be401",
      maxPriorityFeePerGas: "0x2540be400",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    });
  });

  it("fire-and-forget timing: send-tx reply resolves BEFORE pending storage write completes", async () => {
    seedTestnetNonceAndFee();
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
    seedTestnetNonceAndFee();
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

  // ───────────────────────────────────────────────────────────────────────
  // opKind tagging. opKind is pending-row metadata only; it
  // must NEVER reach submitMlDsaTx's argument object (the signed
  // tx bytes / ML-DSA-65 signature / encrypted envelope / nonce / fee /
  // gas must be identical with or without opKind).
  // ───────────────────────────────────────────────────────────────────────

  const PENDING_KEY = `mono.activity.pending.${DETERMINISTIC_ADDRESS.toLowerCase()}.${TESTNET_CHAIN_ID_HEX}`;

  async function dispatchSend(payload: Record<string, unknown>) {
    seedTestnetNonceAndFee();
    rpcResponses["eth_blockNumber"] = "0x64";
    const r = await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return r;
  }

  it("per-caller tagging — a known opKind rides through to the pending-row record", async () => {
    const cases: Array<{ opKind: string }> = [
      { opKind: "send" },
      { opKind: "delegate" },
      { opKind: "undelegate" },
      { opKind: "redelegate" },
      { opKind: "claim" },
      { opKind: "emergency-key" },
      { opKind: "agent-policy" },
      { opKind: "contract_call" },
    ];
    for (const { opKind } of cases) {
      storageLocal = {};
      await dispatchSend({
        to: "0xrecipient",
        valueWeiHex: "0x989680",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        opKind,
      });
      const persisted = storageLocal[PENDING_KEY] as {
        pending: Array<{ opKind?: string }>;
      };
      expect(persisted.pending[0]?.opKind).toBe(opKind);
    }
  });

  it("legacy / absent path — no opKind in the payload → no opKind on the row", async () => {
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    });
    const persisted = storageLocal[PENDING_KEY] as {
      pending: Array<Record<string, unknown>>;
    };
    expect(persisted.pending[0]).toBeDefined();
    expect("opKind" in persisted.pending[0]!).toBe(false);
  });

  it("unknown literal coerced to fallback — { opKind: 'garbage' } → row.opKind === 'contract_call'", async () => {
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      opKind: "garbage",
    });
    const persisted = storageLocal[PENDING_KEY] as {
      pending: Array<{ opKind?: string }>;
    };
    expect(persisted.pending[0]?.opKind).toBe("contract_call");
  });

  it("non-string opKind coerced to fallback (defense in depth)", async () => {
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      // Cast to make TypeScript happy in the test; the runtime guard
      // is what we're exercising here.
      opKind: 42 as unknown as string,
    });
    const persisted = storageLocal[PENDING_KEY] as {
      pending: Array<{ opKind?: string }>;
    };
    expect(persisted.pending[0]?.opKind).toBe("contract_call");
  });

  it("METADATA-ONLY INVARIANT — opKind NEVER reaches submitMlDsaTx's argument object", async () => {
    // First dispatch — WITH opKind. Capture the signer arg.
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      opKind: "delegate",
    });
    const withOp = submitMlDsaCalls[0]!;
    expect(withOp).toBeDefined();
    // The signer must NOT see opKind on the argument object — that
    // would mean opKind is reaching the signing path, which would
    // break the metadata-only invariant.
    expect("opKind" in withOp).toBe(false);

    // Reset and dispatch identically WITHOUT opKind. The captured
    // argument object must be byte-equal — proves the signed tx bytes
    // / signature / envelope / fee / nonce do not depend on opKind.
    submitMlDsaCalls.length = 0;
    storageLocal = {};
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    });
    const withoutOp = submitMlDsaCalls[0]!;
    expect(withoutOp).toBeDefined();
    expect(withoutOp).toEqual(withOp);
  });

  it("cluster metadata rides through to the pending row; malformed values dropped", async () => {
    storageLocal = {};
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      opKind: "delegate",
      clusterId: 1,
      clusterName: "halcyon.cluster.mono",
    });
    const persisted = storageLocal[PENDING_KEY] as {
      pending: Array<{ clusterId?: number; clusterName?: string }>;
    };
    expect(persisted.pending[0]?.clusterId).toBe(1);
    expect(persisted.pending[0]?.clusterName).toBe("halcyon.cluster.mono");

    // Malformed cluster fields are dropped (defense in depth).
    storageLocal = {};
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      clusterId: "nope" as unknown as number,
      clusterName: 42 as unknown as string,
    });
    const p2 = storageLocal[PENDING_KEY] as {
      pending: Array<Record<string, unknown>>;
    };
    expect("clusterId" in p2.pending[0]!).toBe(false);
    expect("clusterName" in p2.pending[0]!).toBe(false);
  });

  it("METADATA-ONLY INVARIANT — cluster fields NEVER reach submitMlDsaTx", async () => {
    submitMlDsaCalls.length = 0;
    storageLocal = {};
    await dispatchSend({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      opKind: "delegate",
      clusterId: 3,
      clusterName: "polar.cluster.mono",
    });
    const arg = submitMlDsaCalls[0]!;
    expect(arg).toBeDefined();
    expect("clusterId" in arg).toBe(false);
    expect("clusterName" in arg).toBe(false);
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
    expect(submitMlDsaTx).toHaveBeenCalledWith({
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
    expect(submitMlDsaTx).not.toHaveBeenCalled();
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
    expect(submitMlDsaTx).not.toHaveBeenCalled();
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
      chainLabel: "Monolythium Testnet",
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith({
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
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi: "0x2540be401",
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi: "0x2540be400",
      source: "test",
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
      chainLabel: "Monolythium Testnet",
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith({
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

  it("clamps an absurd operator execution fee on the MRV native call to the sane ceiling (T4-04 a1)", async () => {
    const origin = "https://mrv-clamp-call.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;
    submitMlDsaCalls.length = 0;
    rpcResponses["lyth_getTransactionCount"] = 8;
    // The operator quotes an execution-unit price 1000x above the sane ceiling
    // (and a tip just as absurd); the wallet must NOT sign the inflated value.
    const CEILING = 1_000_000_000_000_000n; // MAX_EXECUTION_UNIT_PRICE_LYTHOSHI
    const CEILING_HEX = "0x" + CEILING.toString(16);
    const ABSURD_HEX = "0x" + (CEILING * 1000n).toString(16);
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi: ABSURD_HEX,
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi: ABSURD_HEX,
      source: "test",
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
    // The SIGNED fee is the ceiling, not the absurd quote; the tip is re-clamped
    // to the (capped) max. Display == signed: the approval shows the same caps.
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: CEILING_HEX,
        maxPriorityFeePerGas: CEILING_HEX,
      }),
    );
    const approval = enqueuedApprovals.find((a) => a.kind === "send_tx");
    expect(approval?.tx).toMatchObject({
      maxFeePerGas: CEILING_HEX,
      maxPriorityFeePerGas: CEILING_HEX,
      gasPrice: CEILING_HEX,
    });
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
    expect(submitMlDsaTx).not.toHaveBeenCalled();
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
    expect(submitMlDsaTx).not.toHaveBeenCalled();
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
    expect(submitMlDsaTx).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dApp eth_sendTransaction fee clamp (T4-04 a1)
// ─────────────────────────────────────────────────────────────────────────────

describe("dApp eth_sendTransaction fee clamp (T4-04 a1)", () => {
  it("clamps an absurd dApp-supplied gasPrice to the sane ceiling before signing", async () => {
    const origin = "https://ethsend-clamp.example";
    await dispatchRpc("eth_requestAccounts", [], origin);
    enqueuedApprovals.length = 0;
    submitMlDsaCalls.length = 0;
    const CEILING = 1_000_000_000_000_000n; // MAX_EXECUTION_UNIT_PRICE_LYTHOSHI
    const CEILING_HEX = "0x" + CEILING.toString(16);
    const ABSURD_HEX = "0x" + (CEILING * 1000n).toString(16);

    const r = await dispatchRpc(
      "eth_sendTransaction",
      [{
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        nonce: "0x8",
        gas: "0x5208",
        gasPrice: ABSURD_HEX, // dApp-supplied absurd execution-unit price
      }],
      origin,
    );

    expect(r.error).toBeUndefined();
    // The 1611-1619 clamp on the MLDSA encrypted submit path caps the signed
    // execution-unit price (gasPrice) at the ceiling, not the absurd dApp quote.
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ gasPrice: CEILING_HEX }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// auto-lock alarm — fail-closed session clear (#17)
// ─────────────────────────────────────────────────────────────────────────────

describe("fired auto-lock clears the session-MEK rehydrate cap (#17)", () => {
  it("a fired auto-lock alarm clears the session MEK + rehydrate deadline (no silent re-unlock)", async () => {
    // Simulate an unlocked session whose auto-lock deadline has just elapsed:
    // the MEK and a LIVE rehydrate cap are mirrored to session storage (as a
    // real unlock would leave them).
    storageSession[SESSION_KEY_MEK_V4] = "seeded-mek-b64";
    storageSession[SESSION_KEY_AUTO_LOCK_DEADLINE] = Date.now() - 1; // elapsed
    storageSession[SESSION_KEY_MEK_REHYDRATE_DEADLINE] = Date.now() + 60_000;

    // Deliver the auto-lock alarm the OS scheduler fires at the deadline. The
    // onAlarm handler re-reads the (elapsed) deadline and runs triggerAutoLock.
    for (const fire of capturedAlarmListeners) fire({ name: ALARM_AUTO_LOCK });
    await new Promise((r) => setTimeout(r, 10));

    // triggerAutoLock cleared the MEK AND the rehydrate cap, so a subsequent SW
    // boot has nothing to rehydrate from — a fired auto-lock can NEVER silently
    // re-unlock. (mekRehydrateExpiredV4 also fails closed on the absent key.)
    expect(storageSession[SESSION_KEY_MEK_V4]).toBeUndefined();
    expect(storageSession[SESSION_KEY_MEK_REHYDRATE_DEADLINE]).toBeUndefined();
    expect(storageSession[SESSION_KEY_AUTO_LOCK_DEADLINE]).toBeUndefined();
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
        reason: "trusted round-finality config not configured",
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
        "registry round-finality trust mode multisig is not supported by browser wallet threshold-cluster verification",
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

  it("verifies round-finality evidence with caller-supplied threshold cluster trust", async () => {
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
      {
        ...NO_EVM_FINALITY_EVIDENCE,
        source: "blsRoundCertificate",
      },
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

// CX1 — get-block-tx-value: resolve a delegate tx's LYTH principal (value)
// at (blockHeight, txIndex) for the activity-detail popup.
describe("get-block-tx-value", () => {
  it("returns the tx value + canonical hash at the given block + index", async () => {
    rpcResponses["eth_getBlockByNumber"] = {
      transactions: [
        { value: "0x5f5e100", hash: "0x9af6" },
        { value: "0x1", hash: "0xbeef" },
      ],
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "get-block-tx-value",
      payload: { blockHeight: 61160, txIndex: 0 },
    })) as { ok: true; valueHex: string | null; txHash: string | null };
    expect(r.ok).toBe(true);
    expect(r.valueHex).toBe("0x5f5e100");
    expect(r.txHash).toBe("0x9af6");
  });

  it("returns null value/hash when the tx index is absent (honest-absence)", async () => {
    rpcResponses["eth_getBlockByNumber"] = { transactions: [] };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "get-block-tx-value",
      payload: { blockHeight: 61160, txIndex: 3 },
    })) as { ok: true; valueHex: string | null; txHash: string | null };
    expect(r.ok).toBe(true);
    expect(r.valueHex).toBeNull();
    expect(r.txHash).toBeNull();
  });
});

// C3 — wallet-tx-fee: on-demand lyth_decodeTx LYTH fee for the activity-detail
// popup (indexer rows have no persisted fee). The chain computes the fee for
// every tx kind; lyth_nativeReceipt was MRV-only → blank for native txs.
describe("wallet-tx-fee", () => {
  it("returns the lyth_decodeTx fee (lythoshi) for a native tx", async () => {
    // Live-verified shape: (base 1e9 + tip 1e9) × 21000 = 42000000000000.
    rpcResponses["lyth_decodeTx"] = {
      fee: { total_lythoshi: "42000000000000" },
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "1".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.ok).toBe(true);
    expect(r.feeLythoshi).toBe("42000000000000");
  });

  it("returns null when lyth_decodeTx is unavailable (honest-absence)", async () => {
    // No seeded lyth_decodeTx → the mock throws -32601 → best-effort null.
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "2".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.ok).toBe(true);
    expect(r.feeLythoshi).toBeNull();
  });

  // No-mock OFF paths — the wallet shows the chain's value or NOTHING; it never
  // fabricates a fee. Each → null (no fee row).
  it("returns null when the lyth_decodeTx result is null", async () => {
    rpcResponses["lyth_decodeTx"] = null;
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "3".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.feeLythoshi).toBeNull();
  });

  it("returns null when the fee object is absent", async () => {
    rpcResponses["lyth_decodeTx"] = { fee: null };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "4".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.feeLythoshi).toBeNull();
  });

  it("returns null on a zero total_lythoshi (no fabricated 0)", async () => {
    rpcResponses["lyth_decodeTx"] = { fee: { total_lythoshi: "0" } };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "5".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.feeLythoshi).toBeNull();
  });

  it("returns null when the operator does not implement lyth_decodeTx (-32046)", async () => {
    rpcErrors["lyth_decodeTx"] = {
      code: -32046,
      message: "transaction-by-hash capability not implemented",
    };
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-tx-fee",
      payload: { txHash: "0x" + "6".repeat(64) },
    })) as { ok: true; feeLythoshi: string | null };
    expect(r.feeLythoshi).toBeNull();
  });
});

// The headless poll-core. Drives `pollPendingAndNotify`
// directly against the in-memory chrome stub: seeds a pending row, seeds
// the receipt RPC, and asserts detect→record→toast→badge + write-back.
// `recordNotification` is the REAL store (notifications-store.js is NOT
// mocked); `fireOsNotification`/`refreshUnreadBadge` are the hoisted mocks.
describe("pollPendingAndNotify — headless poll-core", () => {
  const ADDR = DETERMINISTIC_ADDRESS.toLowerCase();
  const CHAIN = TESTNET_CHAIN_ID_HEX;
  const pendingKey = (addr: string, chain: string) =>
    `mono.activity.pending.${addr}.${chain}`;
  const historyKey = (addr: string, chain: string) =>
    `mono.notifications.history.${addr}.${chain}.v1`;
  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      kind: "pending_tx",
      txHash: "0x" + "1".repeat(64),
      to: "0x" + "2".repeat(40),
      amountDecimal: "1.5",
      broadcastedAtMs: Date.now(),
      broadcastBlockHeight: 100,
      via: "mock-operator",
      opKind: "send",
      ...overrides,
    };
  }

  it("confirmed pending → records + writes back kept (terminal dropped)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };

    const { remaining } = await pollPendingAndNotify();

    expect(remaining).toBe(0);
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    expect(mockRefreshUnreadBadge).toHaveBeenCalled();
    expect(
      (storageLocal[pendingKey(ADDR, CHAIN)] as { pending: unknown[] }).pending,
    ).toEqual([]);
    const hist = storageLocal[historyKey(ADDR, CHAIN)] as {
      entries: Array<{ status: string; txHash: string; blockNumber: number | null }>;
    };
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]!.status).toBe("confirmed");
    expect(hist.entries[0]!.txHash).toBe("0x" + "1".repeat(64));
    expect(hist.entries[0]!.blockNumber).toBe(123);
  });

  it("failed pending → recorded as FAILED, never confirmed (#5117)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    // not_found → falls through to the receipt, whose status bit is the
    // authoritative verdict (0 ⇒ failed).
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 0, block_number: 123 };

    await pollPendingAndNotify();

    const hist = storageLocal[historyKey(ADDR, CHAIN)] as {
      entries: Array<{ status: string }>;
    };
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]!.status).toBe("failed");
    expect(hist.entries[0]!.status).not.toBe("confirmed");
  });

  it("found-but-reverted tx → recorded as FAILED via the receipt status bit (found != confirmed)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    // The chain reports a reverted tx as "found" — it WAS included in a block;
    // inclusion is not success. The receipt status bit (0x0) is authoritative,
    // so the row must be recorded FAILED, not "confirmed" (the bug that toasted
    // "Staked" for a reverted stake).
    rpcResponses["lyth_txStatus"] = { status: "found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x0", block_number: 456 };

    await pollPendingAndNotify();

    const hist = storageLocal[historyKey(ADDR, CHAIN)] as {
      entries: Array<{ status: string; blockNumber: number | null }>;
    };
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]!.status).toBe("failed");
    expect(hist.entries[0]!.blockNumber).toBe(456);
  });

  it("found tx with no available receipt stays PENDING — no optimistic confirm (F-3.10/#27)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    // found + receipt unavailable (null) → no readable status bit. Per #27 the
    // wallet no longer optimistically confirms (a not-yet-available receipt
    // can't reveal a revert): the row stays pending and NO terminal
    // notification is recorded. It resolves on a later poll once the receipt
    // lands; PENDING_TTL_MS + the heuristic reconciler remain the backstops.
    rpcResponses["lyth_txStatus"] = { status: "found" };
    rpcResponses["eth_getTransactionReceipt"] = null;

    await pollPendingAndNotify();

    // No terminal transition → no notification-history entry for this tx.
    expect(storageLocal[historyKey(ADDR, CHAIN)]).toBeUndefined();
    // The row is written back as still-pending (kept), not dropped/confirmed.
    const pend = storageLocal[pendingKey(ADDR, CHAIN)] as { pending: unknown[] };
    expect(pend.pending).toHaveLength(1);
  });

  it("captures the lyth_decodeTx LYTH fee on a confirmed tx (feeLythoshi)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    rpcResponses["lyth_txStatus"] = { status: "found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", block_number: 77 };
    // The eth receipt carries no fee — the LYTH fee comes from lyth_decodeTx.
    rpcResponses["lyth_decodeTx"] = {
      fee: { total_lythoshi: "600000" },
    };

    await pollPendingAndNotify();

    const hist = storageLocal[historyKey(ADDR, CHAIN)] as {
      entries: Array<{ status: string; feeLythoshi?: string }>;
    };
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]!.status).toBe("confirmed");
    expect(hist.entries[0]!.feeLythoshi).toBe("600000");
  });

  it("omits the fee on a failed tx and on a zero-fee confirmed tx (no-mock)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    // Failed tx — the fee fetch is skipped (status !== confirmed) even though a
    // lyth_decodeTx fee is seeded, so feeLythoshi stays absent.
    const FAILED = "0x" + "c".repeat(64);
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow({ txHash: FAILED })] };
    rpcResponses["lyth_txStatus"] = { status: "found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x0", block_number: 88 };
    rpcResponses["lyth_decodeTx"] = { fee: { total_lythoshi: "600000" } };
    await pollPendingAndNotify();
    // Confirmed but ZERO fee → omitted (no fake "0 LYTH").
    const ZEROFEE = "0x" + "d".repeat(64);
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow({ txHash: ZEROFEE })] };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", block_number: 89 };
    rpcResponses["lyth_decodeTx"] = { fee: { total_lythoshi: "0" } };
    await pollPendingAndNotify();

    const hist = storageLocal[historyKey(ADDR, CHAIN)] as {
      entries: Array<{ status: string; txHash: string; feeLythoshi?: string }>;
    };
    const failed = hist.entries.find((e) => e.txHash === FAILED);
    const zeroFee = hist.entries.find((e) => e.txHash === ZEROFEE);
    expect(failed?.status).toBe("failed");
    expect(failed && "feeLythoshi" in failed).toBe(false);
    expect(zeroFee?.status).toBe("confirmed");
    expect(zeroFee && "feeLythoshi" in zeroFee).toBe(false);
  });

  it("wallet-activity-failed returns only the failed records for the scope (Activity-list source)", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    // Record one CONFIRMED tx...
    storageLocal[pendingKey(ADDR, CHAIN)] = {
      pending: [pendingRow({ txHash: "0x" + "a".repeat(64) })],
    };
    rpcResponses["lyth_txStatus"] = { status: "found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x1", block_number: 50 };
    await pollPendingAndNotify();
    // ...and one FAILED tx (reverted receipt).
    storageLocal[pendingKey(ADDR, CHAIN)] = {
      pending: [pendingRow({ txHash: "0x" + "b".repeat(64) })],
    };
    rpcResponses["eth_getTransactionReceipt"] = { status: "0x0", block_number: 99 };
    await pollPendingAndNotify();

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-activity-failed",
      payload: { address: ADDR, chainIdHex: CHAIN },
    })) as {
      ok: true;
      failed: Array<{ status: string; txHash: string; blockNumber: number | null }>;
    };
    expect(r.ok).toBe(true);
    // Only the failed tx — the confirmed one is excluded.
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.status).toBe("failed");
    expect(r.failed[0]!.txHash).toBe("0x" + "b".repeat(64));
    expect(r.failed[0]!.blockNumber).toBe(99);
  });

  it("null receipt → kept (still pending), no record, no toast", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = null;

    const { remaining } = await pollPendingAndNotify();

    expect(remaining).toBe(1);
    expect(mockFireOsNotification).not.toHaveBeenCalled();
    expect(storageLocal[historyKey(ADDR, CHAIN)]).toBeUndefined();
    expect(
      (storageLocal[pendingKey(ADDR, CHAIN)] as { pending: unknown[] }).pending,
    ).toHaveLength(1);
  });

  it("notified-set dedupe → no double toast when the same tx is re-polled", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };

    await pollPendingAndNotify();
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);

    // Re-add the same pending row (a race / re-add). The persisted
    // notified-set must block a second toast + second history entry.
    storageLocal[pendingKey(ADDR, CHAIN)] = { pending: [pendingRow()] };
    await pollPendingAndNotify();

    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    const hist = storageLocal[historyKey(ADDR, CHAIN)] as { entries: unknown[] };
    expect(hist.entries).toHaveLength(1);
  });

  it("TTL-evicted row → excluded from notify + never polled + written back []", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    // Ancient broadcast time (well past PENDING_TTL_MS = 5 min).
    storageLocal[pendingKey(ADDR, CHAIN)] = {
      pending: [pendingRow({ broadcastedAtMs: 1_000_000 })],
    };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };

    const { remaining } = await pollPendingAndNotify();

    expect(remaining).toBe(0);
    expect(mockFireOsNotification).not.toHaveBeenCalled();
    expect(storageLocal[historyKey(ADDR, CHAIN)]).toBeUndefined();
    expect(
      (storageLocal[pendingKey(ADDR, CHAIN)] as { pending: unknown[] }).pending,
    ).toEqual([]);
    // The expired row was dropped before any RPC.
    expect(
      rpcCalls.filter((c) => c.method === "eth_getTransactionReceipt"),
    ).toHaveLength(0);
  });

  it("multi-scope fan-out → both pending keys processed", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    const ADDR2 = "0x" + "3".repeat(40);
    storageLocal[pendingKey(ADDR, CHAIN)] = {
      pending: [pendingRow({ txHash: "0x" + "a".repeat(64) })],
    };
    storageLocal[pendingKey(ADDR2, CHAIN)] = {
      pending: [pendingRow({ txHash: "0x" + "b".repeat(64) })],
    };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };

    const { remaining } = await pollPendingAndNotify();

    expect(remaining).toBe(0);
    expect(mockFireOsNotification).toHaveBeenCalledTimes(2);
    expect(
      (storageLocal[pendingKey(ADDR, CHAIN)] as { pending: unknown[] }).pending,
    ).toEqual([]);
    expect(
      (storageLocal[pendingKey(ADDR2, CHAIN)] as { pending: unknown[] }).pending,
    ).toEqual([]);
  });
});

// Item 7b — incoming-transfer detection (open-surface / unlocked-only).
describe("detectAndNotifyIncoming — incoming-transfer detection", () => {
  const ADDR = DETERMINISTIC_ADDRESS.toLowerCase();
  const CHAIN = TESTNET_CHAIN_ID_HEX;
  const wmKey = `mono.notifications.incoming-watermark.${ADDR}.${CHAIN}.v1`;
  const histKey = `mono.notifications.history.${ADDR}.${CHAIN}.v1`;
  const rx = (block: number, over: Record<string, unknown> = {}) => ({
    kind: "tx_receive" as const,
    blockHeight: block,
    txIndex: 0,
    logIndex: 0,
    counterparty: "0x" + "5".repeat(40),
    amountDecimal: "1",
    ...over,
  });

  it("first run only establishes a baseline — no toast, no history toast-storm", async () => {
    const { detectAndNotifyIncoming } = await import("./service-worker.js");
    const added = await detectAndNotifyIncoming(
      ADDR,
      CHAIN,
      [rx(100), rx(90)] as never,
      true,
      true,
    );
    expect(added).toBe(0);
    expect(mockFireOsNotification).not.toHaveBeenCalled();
    expect(storageLocal[histKey]).toBeUndefined();
    // Watermark pinned to the newest anchor in view.
    expect(storageLocal[wmKey]).toMatchObject({ blockHeight: 100 });
  });

  it("a new incoming above the watermark → one record + one toast; advances the watermark", async () => {
    const { detectAndNotifyIncoming } = await import("./service-worker.js");
    storageLocal[wmKey] = { blockHeight: 100, txIndex: 0, logIndex: 0 };
    const added = await detectAndNotifyIncoming(ADDR, CHAIN, [rx(105)] as never, true, true);
    expect(added).toBe(1);
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    const hist = storageLocal[histKey] as {
      entries: Array<{ kind: string; status: string; amountDecimal: string }>;
    };
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]!.kind).toBe("receive");
    expect(hist.entries[0]!.status).toBe("confirmed");
    expect(storageLocal[wmKey]).toMatchObject({ blockHeight: 105 });
  });

  it("re-running with the same incoming does NOT re-notify (watermark + dedupe)", async () => {
    const { detectAndNotifyIncoming } = await import("./service-worker.js");
    storageLocal[wmKey] = { blockHeight: 100, txIndex: 0, logIndex: 0 };
    await detectAndNotifyIncoming(ADDR, CHAIN, [rx(105)] as never, true, true);
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    // Same snapshot again — watermark is now 105, so nothing is new.
    await detectAndNotifyIncoming(ADDR, CHAIN, [rx(105)] as never, true, true);
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    const hist = storageLocal[histKey] as { entries: unknown[] };
    expect(hist.entries).toHaveLength(1);
  });

  it("ignores outgoing rows — only tx_receive entries notify", async () => {
    const { detectAndNotifyIncoming } = await import("./service-worker.js");
    storageLocal[wmKey] = { blockHeight: 100, txIndex: 0, logIndex: 0 };
    const txSend = {
      kind: "tx_send" as const,
      blockHeight: 110,
      txIndex: 0,
      logIndex: 0,
      counterparty: "0x" + "6".repeat(40),
      amountDecimal: "2",
    };
    const added = await detectAndNotifyIncoming(ADDR, CHAIN, [txSend] as never, true, true);
    expect(added).toBe(0);
    expect(mockFireOsNotification).not.toHaveBeenCalled();
  });

  it("incoming toggle OFF → record still written, but NO toast (Item 7c)", async () => {
    const { detectAndNotifyIncoming } = await import("./service-worker.js");
    mockGetIncomingEnabled.mockResolvedValue(false);
    storageLocal[wmKey] = { blockHeight: 100, txIndex: 0, logIndex: 0 };
    const added = await detectAndNotifyIncoming(ADDR, CHAIN, [rx(105)] as never, true, true);
    // The in-app record is always written (added counts it)…
    expect(added).toBe(1);
    const hist = storageLocal[histKey] as { entries: unknown[] };
    expect(hist.entries).toHaveLength(1);
    // …but the toast is suppressed by the toggle.
    expect(mockFireOsNotification).not.toHaveBeenCalled();
  });
});

// The notif-poll alarm lifecycle + back-off. Drives the captured
// onAlarm listener + the send-flow persist; the per-call RPC timeout is
// covered in tx-mldsa.test.ts.
describe("notif-poll alarm lifecycle + back-off", () => {
  const ADDR = DETERMINISTIC_ADDRESS.toLowerCase();
  const CHAIN = TESTNET_CHAIN_ID_HEX;
  const pk = (addr: string, chain: string) =>
    `mono.activity.pending.${addr}.${chain}`;
  function row(overrides: Record<string, unknown> = {}) {
    return {
      kind: "pending_tx",
      txHash: "0x" + "1".repeat(64),
      to: "0x" + "2".repeat(40),
      amountDecimal: "1.5",
      broadcastedAtMs: Date.now(),
      broadcastBlockHeight: 100,
      via: "mock-operator",
      opKind: "send",
      ...overrides,
    };
  }
  const flushAsync = async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  };
  const fireNotifPoll = () => {
    for (const l of capturedAlarmListeners) l({ name: ALARM_NOTIF_POLL });
  };

  it("persisting a pending row (via wallet-send-tx) arms the poll alarm", async () => {
    rpcResponses["lyth_getTransactionCount"] = "0x0";
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi: "0x2540be401",
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi: "0x2540be400",
      source: "test",
    };
    rpcResponses["eth_blockNumber"] = "0x64";
    await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: { to: "0xrecipient", valueWeiHex: "0x989680", chainIdHex: CHAIN },
    });
    // Fire-and-forget persist → queueMicrotask + a macrotask to settle.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(alarmCreateCalls.map((c) => c.name)).toContain(ALARM_NOTIF_POLL);
  });

  it("onAlarm runs the poll-core and clears the alarm when the set empties", async () => {
    storageLocal[pk(ADDR, CHAIN)] = { pending: [row()] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };
    fireNotifPoll();
    await flushAsync();
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    // remaining 0 + the race re-check still empty → cleared.
    expect(alarmClearCalls).toContain(ALARM_NOTIF_POLL);
  });

  it("onAlarm does NOT clear while a tx is still pending", async () => {
    storageLocal[pk(ADDR, CHAIN)] = { pending: [row()] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = null; // still pending
    fireNotifPoll();
    await flushAsync();
    expect(alarmClearCalls).not.toContain(ALARM_NOTIF_POLL);
  });

  it("backs off (lengthens the period) on consecutive all-operator failures", async () => {
    // A clean empty tick first resets any back-off carried from a prior test.
    fireNotifPoll();
    await flushAsync();
    // Now an all-fail tick with a pending row: lyth_txStatus throws → the row
    // is kept (never mislabeled) and the tick counts as all-failed.
    storageLocal[pk(ADDR, CHAIN)] = { pending: [row()] };
    rpcErrors["lyth_txStatus"] = { code: -32000, message: "operator down" };
    alarmCreateCalls.length = 0;
    fireNotifPoll();
    await flushAsync();
    const created = alarmCreateCalls.filter((c) => c.name === ALARM_NOTIF_POLL);
    expect(created.length).toBeGreaterThan(0);
    // Base period is now 0.5 min (30 s MV3 floor); one back-off doubles it to
    // 1 min (0.5 * 2**1). Still < the 5-min PENDING_TTL_MS.
    expect(
      (created.at(-1)!.info as { periodInMinutes: number }).periodInMinutes,
    ).toBe(1);
  });
});

// Presence-aware read on the poll path (isWalletSurfaceOpen is
// the hoisted mock here; its real getContexts probe is unit-tested in
// notifications-os.test.ts). Confirms: closed → read:false → unread; open →
// read:true → no unread; the toast fires in BOTH (presence never gates it).
describe("presence-aware read (poll path)", () => {
  const ADDR = DETERMINISTIC_ADDRESS.toLowerCase();
  const CHAIN = TESTNET_CHAIN_ID_HEX;
  const pk = `mono.activity.pending.${ADDR}.${CHAIN}`;
  const hk = `mono.notifications.history.${ADDR}.${CHAIN}.v1`;
  const row = {
    kind: "pending_tx",
    txHash: "0x" + "1".repeat(64),
    to: "0x" + "2".repeat(40),
    amountDecimal: "1.5",
    broadcastedAtMs: Date.now(),
    broadcastBlockHeight: 100,
    via: "mock-operator",
    opKind: "send",
  };
  function seedConfirmed() {
    storageLocal[pk] = { pending: [row] };
    rpcResponses["lyth_txStatus"] = { status: "not_found" };
    rpcResponses["eth_getTransactionReceipt"] = { status: 1, block_number: 123 };
  }

  it("no surface open → read:false → unread accumulates; toast still fires", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    const { getUnread } = await import("./notifications-store.js");
    mockIsWalletSurfaceOpen.mockResolvedValue(false);
    seedConfirmed();
    await pollPendingAndNotify();
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    const hist = storageLocal[hk] as { entries: Array<{ read: boolean }> };
    expect(hist.entries[0]!.read).toBe(false);
    expect(await getUnread()).toBe(1);
  });

  it("a surface open → read:true → no unread; toast still fires", async () => {
    const { pollPendingAndNotify } = await import("./service-worker.js");
    const { getUnread } = await import("./notifications-store.js");
    mockIsWalletSurfaceOpen.mockResolvedValue(true);
    seedConfirmed();
    await pollPendingAndNotify();
    // Presence does NOT gate the toast — it fires in both cases.
    expect(mockFireOsNotification).toHaveBeenCalledTimes(1);
    const hist = storageLocal[hk] as { entries: Array<{ read: boolean }> };
    expect(hist.entries[0]!.read).toBe(true);
    expect(await getUnread()).toBe(0);
  });
});

// Notification settings IPC — the three new setters validate a boolean at the
// boundary BEFORE touching storage (the reject path returns early, so it's
// exercised even though notifications-os.js is mocked here). The get/set
// round-trip + default + fail-open are covered against the real helpers in
// notifications-os.test.ts.
describe("notification settings IPC — boolean validation at the boundary", () => {
  const NEW_SET_OPS = [
    "notifications-set-show-details",
    "notifications-set-notify-when-locked",
    "notifications-set-badge-when-locked",
  ] as const;

  for (const op of NEW_SET_OPS) {
    it(`${op} rejects a non-boolean payload`, async () => {
      const r = (await dispatchPopup({
        kind: "popup",
        op,
        payload: { enabled: "nope" },
      })) as { ok: boolean; reason?: string };
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("boolean");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T1-04(a) — passkey spending cap enforced at the SW signing boundary.
// The gate is INERT unless a test opts in via activePasskeyVaultId +
// passkeyStateForTest (default null/disabled — see the keystore mock).
// ─────────────────────────────────────────────────────────────────────────────
describe("wallet-send-tx passkey spending cap (T1-04a)", () => {
  const LIMIT_LYTHOSHI = 100_000_000_000_000_000_000n; // 100 LYTH
  const OVER = "0x" + (LIMIT_LYTHOSHI * 2n).toString(16); // 200 LYTH
  const UNDER = "0x" + (LIMIT_LYTHOSHI / 2n).toString(16); // 50 LYTH

  function enablePerTxCap() {
    activePasskeyVaultId = "v1";
    passkeyStateForTest = {
      policy: { enabled: true, mode: "per-tx", limitWei: LIMIT_LYTHOSHI },
      credentials: [{ credentialId: "c1" }],
    };
  }

  function seedNonceAndFee() {
    rpcResponses["lyth_getTransactionCount"] = "0x0";
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi: "0x2540be401",
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi: "0x2540be400",
      source: "test",
    };
    rpcResponses["eth_blockNumber"] = "0x64";
  }

  function send(payload: Record<string, unknown>) {
    return dispatchPopup({ kind: "popup", op: "wallet-send-tx", payload });
  }

  it("over-limit value send with NO password → passkeyElevation:required, no broadcast", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: OVER,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    })) as { ok: false; passkeyElevation?: string };
    expect(r.ok).toBe(false);
    expect(r.passkeyElevation).toBe("required");
    expect(submitMlDsaTx).not.toHaveBeenCalled();
  });

  it("over-limit value send with the CORRECT password is SW-verified and broadcasts", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: OVER,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      elevatedPassword: "correct-horse-battery-staple",
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledTimes(1);
  });

  it("over-limit value send with a WRONG password → passkeyElevation:wrong_password, no broadcast", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: OVER,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      elevatedPassword: "nope",
    })) as { ok: false; passkeyElevation?: string };
    expect(r.ok).toBe(false);
    expect(r.passkeyElevation).toBe("wrong_password");
    expect(submitMlDsaTx).not.toHaveBeenCalled();
  });

  it("under-limit value send broadcasts with no elevation required", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: UNDER,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    })) as { ok: boolean; passkeyElevation?: string };
    expect(r.ok).toBe(true);
    expect(r.passkeyElevation).toBeUndefined();
    expect(submitMlDsaTx).toHaveBeenCalledTimes(1);
  });

  it("policy disabled → gate inert, over-limit value send broadcasts", async () => {
    activePasskeyVaultId = "v1";
    passkeyStateForTest = {
      policy: { enabled: false, mode: "per-tx", limitWei: LIMIT_LYTHOSHI },
      credentials: [{ credentialId: "c1" }],
    };
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: OVER,
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledTimes(1);
  });

  it("data (contract-call) send bypasses the value-only cap even when over-limit", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0x0000000000000000000000000000000000001001",
      valueWeiHex: OVER,
      data: "0xdeadbeef",
      gasLimitHex: "0x30d40",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledTimes(1);
  });

  it("empty-data (0x) over-limit send is treated as a bare value transfer and is capped (#36)", async () => {
    enablePerTxCap();
    seedNonceAndFee();
    const r = (await send({
      to: "0xrecipient",
      valueWeiHex: OVER,
      // "0x" is byte-identical to a native transfer (input normalizes to
      // "0x"), so it must NOT slip past the value-only cap.
      data: "0x",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    })) as { ok: false; passkeyElevation?: string };
    expect(r.ok).toBe(false);
    expect(r.passkeyElevation).toBe("required");
    expect(submitMlDsaTx).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #36 — passkey daily-usage ledger persisted to chrome.storage.session so it
// survives MV3 SW hibernation instead of resetting the rolling window.
// ─────────────────────────────────────────────────────────────────────────────
describe("passkey daily-usage ledger persistence (#36)", () => {
  const LYTH = 1_000_000_000_000_000_000n; // 1e18 lythoshi
  const DAILY_CAP = 100n * LYTH;
  const SESSION_KEY = "mono.session.passkey-usage.v1";
  const hex = (v: bigint) => "0x" + v.toString(16);

  function enableDailyCap() {
    activePasskeyVaultId = "v1";
    passkeyStateForTest = {
      policy: { enabled: true, mode: "daily", dailyCapWei: DAILY_CAP },
      credentials: [{ credentialId: "c1" }],
    };
  }

  function record(vaultId: string, valueWei: bigint) {
    return dispatchPopup({
      kind: "popup",
      op: "passkey-record-usage",
      payload: { vaultId, valueWeiHex: hex(valueWei) },
    });
  }
  function evaluate(vaultId: string, valueWei: bigint) {
    return dispatchPopup({
      kind: "popup",
      op: "passkey-evaluate",
      payload: { vaultId, valueWeiHex: hex(valueWei) },
    }) as Promise<{ ok: boolean; decision?: { kind: string; mode?: string } }>;
  }

  it("passkey-record-usage persists to chrome.storage.session as a decimal string", async () => {
    enableDailyCap();
    await record("v1", 60n * LYTH);
    const stored = storageSession[SESSION_KEY] as
      | Record<string, { at: number; valueWei: string }[]>
      | undefined;
    const entries = stored?.v1;
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    // bigint is serialized as a decimal string (survives structured-clone).
    expect(entries?.[0]?.valueWei).toBe((60n * LYTH).toString());
    expect(typeof entries?.[0]?.at).toBe("number");
  });

  it("recorded usage persists in session and counts toward the daily cap (survives SW restart)", async () => {
    enableDailyCap();
    await record("v1", 60n * LYTH);
    // The ledger now lives ONLY in chrome.storage.session, so a fresh read
    // (as a restarted SW would do) still sees the prior usage.
    const over = await evaluate("v1", 50n * LYTH); // 60 + 50 = 110 > 100
    expect(over.ok).toBe(true);
    expect(over.decision?.kind).toBe("over-limit");
    expect(over.decision?.mode).toBe("daily");

    const ok = await evaluate("v1", 30n * LYTH); // 60 + 30 = 90 <= 100
    expect(ok.decision?.kind).toBe("passkey-ok");
  });

  it("prunes >24h usage entries on read", async () => {
    enableDailyCap();
    const DAY_MS = 24 * 60 * 60 * 1000;
    storageSession[SESSION_KEY] = {
      v1: [
        // stale (>24h) — must be pruned and not counted.
        { at: Date.now() - DAY_MS - 60_000, valueWei: (90n * LYTH).toString() },
        // fresh.
        { at: Date.now(), valueWei: (30n * LYTH).toString() },
      ],
    };
    // If the stale 90 were counted: 90 + 30 + 50 = 170 > 100 → over-limit.
    // With pruning: 30 + 50 = 80 <= 100 → passkey-ok.
    const r = await evaluate("v1", 50n * LYTH);
    expect(r.decision?.kind).toBe("passkey-ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #41 — SW-side password-floor re-validation at the create/import IPC boundary
// (defense-in-depth: the popup UI gate is not trusted).
// ─────────────────────────────────────────────────────────────────────────────
describe("keystore create/import password floor (#41 SW-side gate)", () => {
  const VALID = "ValidPassw0rd!"; // >=12, upper, lower, digit, special
  const WEAK = "weak";

  it("keystore-create-new rejects a weak password with reason:weak_password", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-create-new",
      payload: { password: WEAK },
    })) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("weak_password");
  });

  it("keystore-create-new accepts a valid password", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-create-new",
      payload: { password: VALID },
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it("keystore-create-from-mnemonic rejects a weak password", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-create-from-mnemonic",
      payload: { password: WEAK, mnemonic: "abandon abandon" },
    })) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("weak_password");
  });

  it("keystore-create-from-mnemonic accepts a valid password", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-create-from-mnemonic",
      payload: { password: VALID, mnemonic: "abandon abandon" },
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4-04 (Item D) — fee binding + sane ceiling on wallet-send-tx.
// ─────────────────────────────────────────────────────────────────────────────
describe("wallet-send-tx fee binding + ceiling (T4-04)", () => {
  const CEILING = 1_000_000_000_000_000n; // matches the networks mock
  const CEILING_HEX = "0x" + CEILING.toString(16);

  function seedOperatorFee(executionUnitPriceLythoshi: string, priorityTipLythoshi: string) {
    rpcResponses["lyth_getTransactionCount"] = "0x0";
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi,
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi,
      source: "test",
    };
    rpcResponses["eth_blockNumber"] = "0x64";
  }

  function send(payload: Record<string, unknown>) {
    return dispatchPopup({ kind: "popup", op: "wallet-send-tx", payload });
  }

  it("signs the popup-supplied signedFee verbatim instead of re-reading the operator (b1)", async () => {
    // The operator re-read would yield 0x9999; the popup bound 0x2710. The
    // SW must sign the BOUND value, never the re-read.
    seedOperatorFee("0x9999", "0x9998");
    await send({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      signedFee: {
        maxFeePerGasHex: "0x2710",
        maxPriorityFeePerGasHex: "0x270f",
        executionUnitLimitHex: "0x5208",
      },
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: "0x2710",
        maxPriorityFeePerGas: "0x270f",
        gas: "0x5208",
      }),
    );
  });

  it("clamps an absurd signedFee maxFeePerGas (and tip) to the sane ceiling (a1)", async () => {
    seedOperatorFee("0x9999", "0x9998");
    const absurd = "0x" + (CEILING * 1000n).toString(16);
    await send({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      signedFee: {
        maxFeePerGasHex: absurd,
        maxPriorityFeePerGasHex: absurd,
        executionUnitLimitHex: "0x5208",
      },
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: CEILING_HEX,
        // tip clamped to <= maxFeePerGas (== ceiling).
        maxPriorityFeePerGas: CEILING_HEX,
      }),
    );
  });

  it("clamps an absurd signedFee execution-unit LIMIT to the sane ceiling (F-3.11/#28)", async () => {
    seedOperatorFee("0x1", "0x1");
    const absurdLimit = "0x" + (10n ** 18n).toString(16);
    await send({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      signedFee: {
        maxFeePerGasHex: "0x2710",
        maxPriorityFeePerGasHex: "0x270f",
        executionUnitLimitHex: absurdLimit,
      },
    });
    // 30,000,000 = MAX_EXECUTION_UNIT_LIMIT (0x1c9c380).
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ gas: "0x1c9c380" }),
    );
  });

  it("passes legitimate budgets (precompile 500000 + native floor 30000) through the limit clamp unchanged (F-3.11/#28)", async () => {
    seedOperatorFee("0x1", "0x1");
    // Largest legitimate wallet budget (spending-policy claim, 0x7A120 = 500000).
    await send({
      to: "0x000000000000000000000000000000000000110c",
      valueWeiHex: "0x0",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      signedFee: {
        maxFeePerGasHex: "0x2710",
        maxPriorityFeePerGasHex: "0x270f",
        executionUnitLimitHex: "0x7a120",
      },
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ gas: "0x7a120" }),
    );
    // Native-transfer floor (0x7530 = 30000) passes through.
    await send({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
      signedFee: {
        maxFeePerGasHex: "0x2710",
        maxPriorityFeePerGasHex: "0x270f",
        executionUnitLimitHex: "0x7530",
      },
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ gas: "0x7530" }),
    );
  });

  it("clamps an absurd operator fee to the ceiling even without signedFee (a1 fallback)", async () => {
    const absurd = "0x" + (CEILING * 1000n).toString(16);
    seedOperatorFee(absurd, absurd);
    await send({
      to: "0xrecipient",
      valueWeiHex: "0x989680",
      chainIdHex: TESTNET_CHAIN_ID_HEX,
    });
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: CEILING_HEX }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee de-trust parity — clamp the multisig-execute signed price to the sane
// ceiling, mirroring the wallet-send-tx clamp (:8806). The multisig-execute fee
// is operator-sourced at execute time with no human-in-the-loop review.
// ─────────────────────────────────────────────────────────────────────────────
describe("multisig-execute fee ceiling (de-trust parity)", () => {
  const CEILING = 1_000_000_000_000_000n; // matches the networks mock (1e15)
  const CEILING_HEX = "0x" + CEILING.toString(16);

  beforeEach(() => {
    multisigMetaForTest = null;
  });

  function seedOperatorFee(
    executionUnitPriceLythoshi: string,
    priorityTipLythoshi: string,
  ) {
    rpcResponses["lyth_getTransactionCount"] = "0x0";
    rpcResponses["lyth_executionUnitPrice"] = {
      executionUnitPriceLythoshi,
      basePricePerExecutionUnitLythoshi: "0x1",
      priorityTipLythoshi,
      source: "test",
    };
    rpcResponses["eth_blockNumber"] = "0x64";
  }

  function seedExecutableProposal() {
    multisigMetaForTest = {
      threshold: 1,
      signers: [{ id: "s1", address: DETERMINISTIC_ADDRESS, pubkey: "0x00" }],
      proposals: [
        {
          id: "prop-1",
          status: "pending",
          approvals: [{ signerId: "s1" }],
          rejections: [],
          expiresAt: Date.now() + 3_600_000,
          action: {
            kind: "send",
            to: "0xrecipient",
            valueWeiHex: "0x989680",
            chainIdHex: TESTNET_CHAIN_ID_HEX,
          },
        },
      ],
    };
  }

  function execute() {
    return dispatchPopup({
      kind: "popup",
      op: "multisig-execute",
      payload: { vaultId: "ms1", proposalId: "prop-1" },
    });
  }

  // S6 #45 B1 — the send-bypass guard. With a multisig active vault, the
  // sanctioned multisig-EXECUTE broadcast (the two fee tests below) still
  // succeeds, but the normal single-signer wallet-send-tx path is REFUSED.
  // Same active-multisig state, disjoint outcomes — proves the guard is
  // entry-layer-only and does NOT block the ceremony.
  it("B1: refuses wallet-send-tx from a multisig active vault (ceremony unaffected)", async () => {
    seedExecutableProposal(); // readMultisigMetaV4 now returns a multisig meta
    activePasskeyVaultId = "ms1"; // getActiveVaultIdV4 returns the active id → guard predicate sees a multisig vault
    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-send-tx",
      payload: {
        to: "0x0000000000000000000000000000000000000001",
        valueWeiHex: "0x0",
        chainIdHex: TESTNET_CHAIN_ID_HEX,
        opKind: "send",
      },
    })) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multisig wallet/i);
  });

  it("clamps an absurd operator execution fee (and tip) to the sane ceiling on the multisig-execute path", async () => {
    const absurd = "0x" + (CEILING * 1000n).toString(16);
    seedOperatorFee(absurd, absurd);
    seedExecutableProposal();
    const r = (await execute()) as { ok: boolean; txHash?: string };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: CEILING_HEX,
        // tip re-clamped to <= maxFeePerGas (== ceiling), mirroring :8806.
        maxPriorityFeePerGas: CEILING_HEX,
      }),
    );
  });

  it("passes a legitimate operator fee through the multisig clamp unchanged (no-op)", async () => {
    // 1e10 price, 5e9 tip — both far below the 1e15 ceiling.
    seedOperatorFee("0x2540be400", "0x12a05f200");
    seedExecutableProposal();
    const r = (await execute()) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(submitMlDsaTx).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFeePerGas: "0x2540be400",
        maxPriorityFeePerGas: "0x12a05f200",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2-02 — SW router sender authentication (fail-closed).
// ─────────────────────────────────────────────────────────────────────────────
describe("SW router sender authentication (T2-02)", () => {
  it("rejects any message from a foreign extension id", () => {
    let responded = false;
    const ret = capturedOnMessage!(
      { kind: "rpc", id: "x", args: { method: "eth_chainId", params: [] }, origin: "https://dapp.example" },
      { id: "someone-else" },
      () => {
        responded = true;
      },
    );
    expect(ret).toBe(false);
    expect(responded).toBe(false);
  });

  it("rejects a popup op from a non-popup sender (e.g. a content script)", () => {
    let responded = false;
    const ret = capturedOnMessage!(
      { kind: "popup", op: "keystore-status" },
      // correct extension id, but a web-page url, not a popup document
      { id: "test", url: "https://evil.example/page" },
      () => {
        responded = true;
      },
    );
    expect(ret).toBe(false);
    expect(responded).toBe(false);
  });

  it("accepts a popup op from a genuine popup sender", async () => {
    const r = (await dispatchPopup({
      kind: "popup",
      op: "keystore-status",
    })) as { hasVault?: boolean };
    // A real response object came back (the request was not rejected).
    expect(r).toBeDefined();
    expect(typeof r).toBe("object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wallet-chain-block-number — #42 typed `cause` on the no-operator path
// ─────────────────────────────────────────────────────────────────────────────
describe("wallet-chain-block-number — untrusted/unreachable cause (#42)", () => {
  it("threads classifyNoOperatorReason into the no-operator ok:false reply", async () => {
    // No operator is serviceable this tick; the classifier reports untrusted.
    // (cachedOperator starts null — no prior test populates it.) Resolve the
    // mocked module dynamically so we don't trigger the vi.mock factory early
    // at top-level-import time.
    const networks = await import("./networks.js");
    vi.mocked(networks.probeFirstAliveOperator).mockResolvedValueOnce(null);
    vi.mocked(networks.classifyNoOperatorReason).mockReturnValueOnce(
      "untrusted",
    );

    const r = (await dispatchPopup({
      kind: "popup",
      op: "wallet-chain-block-number",
    })) as { ok: boolean; reason?: string; cause?: string };

    expect(r.ok).toBe(false);
    expect(r.cause).toBe("untrusted");
  });
});
