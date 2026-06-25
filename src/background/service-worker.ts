// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts        (real popup approval)
//   - eth_chainId / net_version
//   - eth_sendTransaction        (native ML-DSA encrypted submission)
//   - eth_sign / personal_sign   (native wallet signing)
//   - eth_signTypedData_v4       (EIP-712 typed-data signing)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain    (real approval UI; persists to chrome.storage)
//   - monolythium_submitMrvNativePlan (custom MRV native tx submission)
//   - monolythium_submitMrvNativeCall (custom MRV native call build+submit)
//
// Plus internal channels used by the popup:
//   - get-pending-approval
//   - resolve-approval
//   - keystore.{status, unlock, lock, create-from-new, create-from-mnemonic}
//
// Chain reads use `RpcClient` from `@monolythium/core-sdk` (root export).
// The testnet flows route through `testnetJsonRpc()` against the native
// `lyth_*` namespace directly. User-added chains use the same `RpcClient`
// transport keyed on their declared RPC URL. The wallet does NOT proxy
// arbitrary EVM reads through its dApp surface by design (native / non-EVM
// chain → dApps use their own RPC); the dispatcher rejects `eth_call`,
// `eth_estimateGas`, `eth_sendRawTransaction`, and the six polling-filter
// methods at the boundary with EIP-1193 code 4200. `eth_call` /
// `eth_estimateGas` ARE served by the chain as read-only native-executor
// views (not retired — just not proxied here); the six filters ARE retired.

import { RpcClient } from "@monolythium/core-sdk";
import {
  addressToTypedBech32,
  getNoEvmReceiptTrustPolicy,
  MONOLYTHIUM_TESTNET_CHAIN_ID,
  ML_DSA_65_PUBLIC_KEY_LEN,
  typedBech32ToAddress,
  verifyNoEvmArchiveProofSignatures,
  verifyNoEvmFinalityEvidenceThreshold,
  type NoEvmArchiveSignatureVerification,
  type NoEvmArchiveTrustedSigner,
  type NoEvmBlsFinalityVerification,
  type NoEvmReceiptTrustPolicy,
} from "@monolythium/core-sdk";
import {
  buildWalletMrvCallNativePlan,
  buildWalletMrvDeployNativePlan,
  requireTypedMrvContractAddress,
  walletMrvNativePlanToSubmitTx,
  type WalletMrvNativeSubmissionPlan,
  type WalletMrvCallNativePlanInput,
  type WalletMrvDeployNativePlanInput,
} from "../shared/mrv-native-plan.js";
import {
  enqueue as enqueueApproval,
  resolve as resolveApproval,
  rejectByWindow,
  listPending,
  clearPending,
  rejectAllPending,
  reapExpired,
  focusApproval,
  type ApprovalDecision,
  type SendTxView,
  type AddChainSpec,
  type TypedDataEnvelope,
} from "./approvals.js";
import { computeTypedDataDigest } from "./typed-data.js";
import {
  isUnlockedV4,
  getUnlockedAddressV4,
  getActiveVaultIdV4,
  verifyContainerPasswordV4,
  lockV4,
  createVaultFromMnemonic,
  exportMnemonicV4,
  personalSignV4,
  signTypedDataV4FromV4,
  getUnlockedPublicKeyV4,
  // Multi-vault surface.
  hasContainerV4,
  unlockContainerV4,
  selectActiveVaultV4,
  listVaultsV4,
  renameVaultV4,
  addVaultFreshV4,
  addVaultImportV4,
  generateFreshMnemonicV4,
  // Multisig surface.
  addVaultMultisigV4,
  readMultisigMetaV4,
  writeMultisigMetaV4,
  getVaultPubkeyV4,
  signWithVaultV4,
  // Passkey surface.
  readPasskeyStateV4,
  addPasskeyCredentialV4,
  removePasskeyCredentialV4,
  setPasskeyPolicyV4,
  // SLH-DSA emergency-backup surface.
  // `writeSlhDsaBackupV4` is not used directly by any IPC — the
  // SW writes through the higher-level helpers (`generateSlhDsaBackupV4`,
  // `confirmSlhDsaColdStorageV4`, `setSlhDsaRegistrationStatusV4`)
  // instead. Test seam only.
  readSlhDsaBackupV4,
  clearSlhDsaBackupV4,
  generateSlhDsaBackupV4,
  recoverSlhDsaMnemonicV4,
  confirmSlhDsaColdStorageV4,
  setSlhDsaRegistrationStatusV4,
  // Session-rehydrate across MV3 SW hibernation.
  tryRestoreFromSessionV4,
} from "./keystore-mldsa.js";
// Notifications — the chokepoint hook in wallet-indexer-snapshot
// calls this to record one notification per tracked-tx terminal transition.
// recordNotification is intentionally NOT exposed via any IPC handler — §0.4
// (only the wallet's own tracked-tx registry can emit notifications).
import {
  getIncomingWatermark,
  getUnread,
  listAllNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  recordNotification,
  setIncomingWatermark,
} from "./notifications-store.js";
// Notifications — the OS toast + unread badge amplifier on top of
// the Phase-1 records. Fired ONLY when recordNotification returns
// added:true (i.e. a new terminal transition for one of the wallet's own
// tracked txs); best-effort, so OS-deny / quota / unsupported environment
// never escape into the snapshot path.
import {
  fireOsNotification,
  getBadgeWhenLocked,
  getIncomingEnabled,
  getNotifyWhenLocked,
  getOsNotificationsEnabled,
  getShowDetails,
  installNotificationsClickListener,
  isWalletSurfaceOpen,
  refreshUnreadBadge,
  setBadgeWhenLocked,
  setIncomingEnabled,
  setNotifyWhenLocked,
  setOsNotificationsEnabled,
  setShowDetails,
} from "./notifications-os.js";
// Notifications — broadcast-time operation tag. The wallet-send-tx
// handler reads p.opKind into a handler-local var (sanitized via isTxOpKind)
// and threads it ONLY to persistPendingRowBackground — never to the signer.
import {
  anchorAfter,
  isTxOpKind,
  type IncomingWatermark,
  type TxOpKind,
} from "../shared/notifications.js";
import type { PasskeyCredential, PasskeyPolicy } from "../shared/passkey.js";
import {
  DAILY_CAP_WINDOW_MS,
  DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
  DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
  evaluatePolicy as evaluatePasskeyPolicy,
  validateCredentialName,
  validatePasskeyPolicy,
} from "../shared/passkey.js";
import { loadTwoTierState } from "./two-tier-features-store.js";
import { isPasswordValid } from "../lib/password-validation.js";
import {
  DEFAULT_GOV_PROPOSAL_TTL_MS,
  DEFAULT_TX_PROPOSAL_TTL_MS,
  applyGovernance,
  deserializeSharedProposal,
  hashGovernanceProposal,
  hashTxProposal,
  isExecutable,
  isGovernanceExecutable,
  mergeGovernanceSignatures,
  mergeProposalSignatures,
  pickFirstSelfSigner,
  pickNextLocalVoter,
  reconcileGovernanceStatus,
  reconcileProposalStatus,
  serializeProposalForShare,
  verifyGovernanceApprovals,
  verifyProposalApprovals,
  type GovernanceAction,
  type GovernanceProposal,
  type PendingProposal,
  type ProposalAction,
  type ProposalSignature,
} from "../shared/multisig.js";
import { keccak_256, shake256 } from "@noble/hashes/sha3.js";
import {
  chainRequiresMlDsa,
  TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX,
  MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
  MAX_EXECUTION_UNIT_LIMIT,
  probeFirstAliveOperator,
  BUILTIN_CHAINS as BUILTIN_CHAINS_LIST,
  loadOperatorOverride,
  setOperatorOverride,
  readOperatorOverride,
  getDefaultOperators,
  getActiveOperators,
  verifyOperatorGenesis,
  snapshotGenesisCache,
  classifyNoOperatorReason,
  clearGenesisCache,
  rehydrateGenesisCache,
} from "./networks.js";
import { clampToSaneBound } from "../shared/operator-bounds.js";
import {
  STORAGE_KEY_OPERATOR_OVERRIDE,
  validateOperatorList,
} from "../shared/operators.js";
import {
  activityCacheKey,
  activityPendingKey,
  activityLocalClaimsKey,
  mergeIndexerSnapshot,
  evictExpiredPending,
  applyLocalClaims,
  reconcilePending,
  validateActivityCache,
  validatePendingActivityCache,
  validateLocalClaimsCache,
  LOCAL_CLAIMS_CAP,
  type ActivityCache,
  type ConfirmedRow,
  type PendingTxRow,
  type RawAddressActivity,
  type RawDelegationHistory,
} from "../shared/activity.js";
import { isCurrencyCode, type CurrencyCode } from "../shared/iso4217.js";
import {
  sentAddressesKey,
  parseSentAddresses,
  addToSentList,
} from "../shared/sent-addresses.js";
import {
  DEMO_ADDR_SENTINELS_LOWER,
  isDemoAddrSentinel,
} from "../shared/demo-addr-sentinel.js";
import {
  STORAGE_KEY_NAME_CACHE,
  mergeNameCache,
  evictExpiredNames,
  validateNameCache,
  type NameLabelRecord,
  type NameLabel,
  type NameCache,
} from "../shared/name-resolution.js";
import { legacyChainBalanceHexToLythoshiHex } from "../shared/chain-units.js";
import { lythoshiDecimalToLythDecimal } from "../shared/lyth-units.js";
import { decodeClaimedAmountLythoshi } from "../shared/claimed-log.js";
import { userAddressForNativeRpc } from "../shared/address-format.js";
import { reconcileWalletUpdateOnInstalled } from "../shared/wallet-update.js";
import {
  submitMlDsaTx,
  testnetJsonRpc,
  testnetMaxBalanceConsensus,
  testnetResolveNameConsensus,
  type EthSendTxFields,
} from "./tx-mldsa.js";
import {
  deriveWsUrl,
  getWsClient,
  isWellFormedBlockNumberHex,
  markWsDown,
  type WsStatus,
} from "./ws-client.js";
import {
  DEFAULT_ACTIVITY_KIND_ENVELOPE,
  normaliseActivityKind,
} from "../shared/activity-kind.js";
import {
  WALLET_KNOWN_INDEXER_SCHEMA_VERSION,
  validateIndexerStatusWire,
} from "../shared/indexer-status.js";
import {
  validateMrcAccountLookupResponse,
  type MrcAccountLookupResponse,
} from "../shared/mrc-account.js";
import type { NativeAgentStateResponse } from "../shared/native-agent-state.js";
import {
  collectWalletBridgeRouteDisclosures,
  validateWalletMrcHoldersResponse,
  validateWalletTokenBalanceList,
  type WalletBridgeRouteDisclosure,
  type WalletBridgeRouteReadiness,
  type WalletMrcHolderStandard,
  type WalletMrcHoldersResponse,
  type WalletTokenBalance,
} from "../shared/token-balances.js";
import {
  readClusterDelegators,
  readClusterDirectory,
  readClusterDiversity,
  readClusterServiceTiers,
  readClusterStatus,
  readOperatorInfo,
  readDelegationHistory,
  readDelegations,
  readDelegationCap,
  readPendingRewards,
  readRedemptionQueue,
} from "./staking-client.js";
import { readBridgeRoutes } from "./bridge-routes-client.js";
import {
  readBridgeDrainStatus,
  readBridgeHealth,
} from "./bridge-health-client.js";
import {
  buildSpendingPolicyClaim,
  readSpendingPolicy,
  type BuildClaimRequest,
} from "./spending-policy-client.js";
import { readNativeAgentState } from "./native-agent-state-client.js";
import { readNativeMarketOrderBookDeltas } from "./native-market-orderbook-client.js";
import { readNativeMarketState } from "./native-market-state-client.js";

type EthSendTransactionRequest = {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  chainId?: string;
};

interface WalletMrvNativeReceiptEvidence {
  schema: string | null;
  txType: number | null;
  artifactHash: string | null;
  receiptCommitment: string | null;
  eventCount: number | null;
  noEvmProof: WalletMrvNoEvmReceiptProofTranscript | null;
  noEvmProofStatus: WalletMrvNoEvmReceiptProofStatus;
  noEvmProofVerification: WalletMrvNoEvmReceiptProofVerification | null;
  noEvmArchiveVerification: WalletMrvNoEvmArchiveVerification | null;
  noEvmFinalityVerification: WalletMrvNoEvmFinalityVerification | null;
}

type WalletMrvNoEvmReceiptProofKind =
  | "boundedCacheTranscript"
  | "compactInclusion";

type WalletMrvNoEvmReceiptProofHistorySource =
  | "legacyUnspecified"
  | "liveBlockCache"
  | "indexerReceiptArchive";

interface WalletMrvNoEvmCompactInclusionProof {
  schema: "mono.no_evm_receipt_compact_inclusion.v1";
  treeAlgorithm: "binary-keccak-receipt-tree";
  root: string;
  leafHash: string;
  siblingHashes: string[];
  pathSides: boolean[];
}

interface WalletMrvNoEvmArchiveProof {
  schema: "mono.no_evm_receipt_archive_binding.v1";
  source: "indexerReceiptArchiveContentDigest";
  manifestHash: string;
  contentHash: string;
  signatureDigest?: string;
  signatures: string[];
  coveringSnapshot?: WalletMrvNoEvmArchiveCoveringSnapshot;
}

interface WalletMrvNoEvmArchiveCoveringSnapshot {
  snapshotHeight: number;
  manifestHash: string;
  signatureDigest: string;
  contentHash: string;
  checkpointContentHash: string;
  checkpointFrom: number;
  checkpointTo: number;
  signatures: string[];
}

interface WalletMrvNoEvmFinalityCertificate {
  round: number;
  signature: string;
  signersBitmap: string;
  signerIndices: number[];
  signerCount: number;
}

interface WalletMrvNoEvmFinalityEvidence {
  schema: "mono.no_evm_receipt_finality.v1";
  source: typeof MRV_ROUND_CERTIFICATE_SOURCE;
  round: number;
  certificate: WalletMrvNoEvmFinalityCertificate;
}

interface WalletMrvNoEvmReceiptProofBase {
  schema: "mono.no_evm_receipt_proof.v1";
  proofKind: WalletMrvNoEvmReceiptProofKind;
  proofType: "canonicalReceiptsTranscript" | "canonicalReceiptInclusion";
  historySource: WalletMrvNoEvmReceiptProofHistorySource;
  compactInclusionProof: WalletMrvNoEvmCompactInclusionProof | null;
  archiveProof: WalletMrvNoEvmArchiveProof | null;
  finalityEvidence: WalletMrvNoEvmFinalityEvidence | null;
  missingProofMaterial: string[];
  rootAlgorithm: string;
  receiptCodec: string;
  blockHash: string;
  txHash: string;
  receiptsRoot: string;
  targetReceiptHash: string;
  blockHeight: number;
  txIndex: number;
  receiptCount: number;
  receiptTranscript: string[];
  targetReceiptBytes: string | null;
}

interface WalletMrvNoEvmBoundedReceiptProofTranscript
  extends WalletMrvNoEvmReceiptProofBase {
  proofKind: "boundedCacheTranscript";
  proofType: "canonicalReceiptsTranscript";
  historySource: "legacyUnspecified" | "liveBlockCache";
  compactInclusionProof: null;
  archiveProof: null;
  targetReceiptBytes: null;
}

interface WalletMrvNoEvmCompactReceiptProofTranscript
  extends WalletMrvNoEvmReceiptProofBase {
  proofKind: "compactInclusion";
  proofType: "canonicalReceiptInclusion";
  historySource: "liveBlockCache" | "indexerReceiptArchive";
  compactInclusionProof: WalletMrvNoEvmCompactInclusionProof;
  archiveProof: WalletMrvNoEvmArchiveProof | null;
  targetReceiptBytes: string;
}

type WalletMrvNoEvmReceiptProofTranscript =
  | WalletMrvNoEvmBoundedReceiptProofTranscript
  | WalletMrvNoEvmCompactReceiptProofTranscript;

type WalletMrvNoEvmReceiptProofStatus =
  | "missing"
  | "transcript-verified"
  | "transcript-mismatch"
  | "proof-verified"
  | "proof-mismatch";

interface WalletMrvNoEvmReceiptProofVerification {
  status: "verified" | "mismatch";
  proofKind: WalletMrvNoEvmReceiptProofKind;
  receiptCountMatches: boolean;
  receiptsRootMatches: boolean;
  targetReceiptHashMatches: boolean;
  compactLeafHashMatches?: boolean;
  compactPathMatches?: boolean;
  receiptCount: number;
  transcriptCount: number;
  computedReceiptsRoot: string;
  computedTargetReceiptHash: string;
  computedCompactLeafHash?: string;
}

interface WalletMrvNoEvmFinalityTrustConfig {
  chainIdHex: string;
  clusterPublicKey: string;
  committeeSize: number;
  threshold: number;
}

interface WalletMrvNoEvmArchiveTrustConfig {
  trustedPublicKeys: string[];
  threshold: number;
}

type WalletMrvNoEvmArchiveVerificationStatus =
  | "verified"
  | "unconfigured"
  | "mismatch"
  | "malformed"
  | "config-invalid";

interface WalletMrvNoEvmArchiveVerification {
  status: WalletMrvNoEvmArchiveVerificationStatus;
  reason: string | null;
  details: NoEvmArchiveSignatureVerification | null;
}

type WalletMrvNoEvmFinalityVerificationStatus =
  | "verified"
  | "unverified"
  | "mismatch";

interface WalletMrvNoEvmFinalityVerification {
  status: WalletMrvNoEvmFinalityVerificationStatus;
  reason: string | null;
  details: NoEvmBlsFinalityVerification | null;
}

interface ResolvedMrvNoEvmFinalityTrustConfig {
  chainId: bigint;
  clusterPublicKey: Uint8Array;
  committeeSize: number;
  threshold: number;
  validFromRound?: bigint;
  validToRound?: bigint;
}

interface ResolvedMrvNoEvmArchiveTrustConfig {
  trustedSigners: NoEvmArchiveTrustedSigner[];
  threshold: number;
  validFromHeight?: bigint;
  validToHeight?: bigint;
}

type WalletMrvNoEvmFinalityTrustResolution =
  | { kind: "none" }
  | { kind: "configured"; config: ResolvedMrvNoEvmFinalityTrustConfig }
  | { kind: "invalid"; reason: string };

type WalletMrvNoEvmArchiveTrustResolution =
  | { kind: "none" }
  | { kind: "configured"; config: ResolvedMrvNoEvmArchiveTrustConfig }
  | { kind: "invalid"; reason: string };

type WalletMrvNoEvmRegistryTrustPolicyResolution =
  | { kind: "none" }
  | { kind: "policy"; policy: NoEvmReceiptTrustPolicy }
  | { kind: "invalid"; reason: string };

interface WalletMrvNativeReceiptEvidenceError {
  reason: string;
  code?: number;
  method?: string;
  via?: string;
}
import { previewTransactionHooks } from "./preview-hooks-client.js";
import { readSigningActivity } from "./signing-activity-client.js";
import { readOperatorRisk } from "./operator-risk-client.js";
import { readUpcomingDuties } from "./upcoming-duties-client.js";
import { lythoshiHexToLythDecimal } from "./wei-decimal.js";
import {
  loadConnectedSites,
  saveConnectedSite,
  removeConnectedSite,
  clearAllConnectedSites,
} from "./connected-sites.js";
import {
  addContact,
  removeContact,
  renameContact,
} from "./contacts.js";
import { addressToBech32m } from "../shared/bech32m.js";
import {
  ALARM_AUTO_LOCK,
  ALARM_NOTIF_POLL,
  ALARM_APPROVAL_REAP,
  APPROVAL_TTL_MS,
  AUTO_LOCK_EXEMPT_OPS,
  AUTO_LOCK_MINUTES_DEFAULT,
  AUTO_LOCK_OPTIONS,
  LOCKOUT_THRESHOLDS,
  SESSION_KEY_AUTO_LOCK_DEADLINE,
  SESSION_KEY_MEK_V4,
  SESSION_KEY_MEK_REHYDRATE_DEADLINE,
  MEK_REHYDRATE_MAX_MINUTES,
  SESSION_KEY_UNLOCK_FAIL_COUNT,
  SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
  SESSION_KEY_WALLET_LOCKED,
  STORAGE_KEY_AUTO_LOCK_MINUTES,
  STORAGE_KEY_UI_OPEN_MODE,
  UI_OPEN_MODE_DEFAULT,
  UI_OPEN_MODE_VALUES,
  type UiOpenMode,
} from "../shared/constants.js";

/** Internal session key — last keystore-wipe-unauth timestamp (ms epoch).
 *  Used to throttle the no-re-auth wipe path so an accidental rapid-fire
 *  click can't churn chrome.storage.local repeatedly. */
const SESSION_KEY_LAST_WIPE_UNAUTH_AT = "mono.session.lastWipeUnauthAt";
const WIPE_UNAUTH_RATE_LIMIT_MS = 5_000;

interface RpcArgs {
  method: string;
  params?: unknown[] | object;
}

interface RpcMessage {
  kind: "rpc";
  id: string;
  args: RpcArgs;
  origin: string;
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

// ---- Known networks ----
interface NetInfo {
  name: string;
  rpc: string;
  chainIdNum: number;
  /** True when this chain is in the built-in Monolythium registry. */
  builtin?: boolean;
  /** True for Foundation-attested official chains (the testnet). */
  official?: boolean;
  /** Optional explorer URL surfaced by `wallet_addEthereumChain`. */
  blockExplorer?: string;
  /** Native currency descriptor (default: LYTH 18). */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

// Canonical chain id for the LythiumDAG-BFT testnet (Whitepaper §13,
// mirrored by the SDK's `MONOLYTHIUM_TESTNET_CHAIN_ID`). Stored as the
// upper-cased hex quantity so chain-registry lookups don't drift on
// casing.
const TESTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // 0x10F2C

// Built-in chains derived from networks.ts. v4.1 ships the testnet only;
// user-added chains via `wallet_addEthereumChain` live in `userChains`
// (loaded from chrome.storage at boot) and are merged at lookup time.
const BUILTIN_CHAINS: Record<string, NetInfo> = Object.fromEntries(
  BUILTIN_CHAINS_LIST.map((c) => [
    c.chainId,
    {
      name: c.name,
      rpc: c.rpc,
      chainIdNum: c.chainIdNum,
      builtin: true,
      official: c.official,
      ...(c.blockExplorer ? { blockExplorer: c.blockExplorer } : {}),
      ...(c.nativeCurrency ? { nativeCurrency: c.nativeCurrency } : {}),
    } satisfies NetInfo,
  ]),
);

const USER_CHAINS_STORAGE_KEY = "mono.chains.user";
const ACTIVE_CHAIN_STORAGE_KEY = "mono.chain.active";
let userChains: Record<string, NetInfo> = {};

function chainRegistry(): Record<string, NetInfo> {
  return { ...BUILTIN_CHAINS, ...userChains };
}

function lookupChain(id: string): NetInfo | null {
  const reg = chainRegistry();
  // Allow lower-case input.
  const norm = id.toLowerCase();
  for (const [k, v] of Object.entries(reg)) {
    if (k.toLowerCase() === norm) return v;
  }
  return null;
}

async function loadUserChains(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([USER_CHAINS_STORAGE_KEY], (res) => {
      const v = res?.[USER_CHAINS_STORAGE_KEY];
      if (v && typeof v === "object") {
        userChains = v as Record<string, NetInfo>;
      }
      resolve();
    });
  });
}

/**
 * One-shot SW-boot cleanup.
 *
 * Removes any `mono.activity.<sentinel>.*` and
 * `mono.activity.pending.<sentinel>.*` storage keys that landed under
 * a popup demo-data sentinel address during the boot race that
 * existed before the activity hook guarded sentinel addrs at the
 * write source.
 *
 * Once-guarded behind a persisted versioned flag: because the write
 * source (useActivity's `isDemoAddrSentinel` early-return) no longer
 * emits sentinel keys, this is a pure legacy cleanup — running the full
 * `chrome.storage.local.get(null)` scan on every SW boot is wasted work
 * (and the scan cost grows with the stored key count). It runs ONCE,
 * sets the flag, and skips thereafter. Bump the version (`v1` → `v2`)
 * if the match logic ever changes, to force a single re-run. Perf only:
 * no wipe / keystore / boot-security behavior is touched. (The B2 reset
 * wipe clears all `mono.*`, including this flag, so a post-reset boot
 * re-runs the scan once — harmless, it finds nothing.)
 */
export const DEMO_ADDR_PURGE_FLAG = "mono.migration.demoAddrPurge.v1";
export async function purgeDemoAddrCacheKeys(): Promise<void> {
  const flagRes = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(DEMO_ADDR_PURGE_FLAG, (res) => resolve(res ?? {}));
  });
  if (flagRes[DEMO_ADDR_PURGE_FLAG] === true) return;
  const all = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(null, (res) => resolve(res ?? {}));
  });
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith("mono.activity.")) continue;
    // Cache key shape: mono.activity.<addrLower>.<chainIdHex>
    // Pending key shape: mono.activity.pending.<addrLower>.<chainIdHex>
    // Both carry a 0x-shaped 20-byte addr in the second-to-last segment
    // (cache) or last-before-chain segment (pending). Match either.
    for (const sentinel of DEMO_ADDR_SENTINELS_LOWER) {
      if (key.includes(`.${sentinel}.`)) {
        toRemove.push(key);
        break;
      }
    }
  }
  if (toRemove.length > 0) {
    await new Promise<void>((resolve) => {
      chrome.storage.local.remove(toRemove, () => resolve());
    });
  }
  // Mark done so the get(null) scan doesn't repeat on every subsequent boot.
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [DEMO_ADDR_PURGE_FLAG]: true }, () => resolve());
  });
}

/** S6 #43 B2 — default-deny wipe of ALL persisted wallet state. Removes every
 *  `chrome.storage.local` key with the `mono.` prefix (vault + container + every
 *  PII family + settings) in one pass, so a reset / forgot-password leaves no
 *  residue — address book, dApp connection graph, tx-history caches — for the
 *  next profile user. Future-proof: any new `mono.*` family is wiped
 *  automatically (no key list to maintain), the same enumeration idiom as
 *  `purgeDemoAddrCacheKeys`. Does NOT touch `window.localStorage` (theme is a
 *  non-secret UI preference there, a different storage area) or
 *  `chrome.storage.session` (the MEK + lock state, cleared by `triggerAutoLock`
 *  and the caller's `session.connectedOrigins.clear()`). Every removed key is
 *  read-with-a-default at boot, so a clean Welcome + fresh import still work. */
async function wipeAllLocalWalletState(): Promise<void> {
  const all = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(null, (res) => resolve(res ?? {}));
  });
  const toRemove = Object.keys(all).filter((k) => k.startsWith("mono."));
  if (toRemove.length === 0) return;
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove(toRemove, () => resolve());
  });
}

async function persistUserChains(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [USER_CHAINS_STORAGE_KEY]: userChains }, () =>
      resolve(),
    );
  });
}

/**
 * Load the persisted active chain id from chrome.storage. Returns the
 * The testnet default when nothing is stored yet (first launch) or when
 * the stored id no longer maps to a known chain (e.g. user removed the
 * user-added chain that was active).
 */
async function loadActiveChainId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([ACTIVE_CHAIN_STORAGE_KEY], (res) => {
      const v = res?.[ACTIVE_CHAIN_STORAGE_KEY];
      if (typeof v === "string" && lookupChain(v)) {
        resolve(canonicalChainKey(v));
        return;
      }
      resolve(TESTNET_CHAIN_ID_HEX);
    });
  });
}

async function persistActiveChainId(chainId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [ACTIVE_CHAIN_STORAGE_KEY]: chainId },
      () => resolve(),
    );
  });
}

interface SessionState {
  chainId: string;
  // Origins the user has approved for eth_accounts visibility. {origin -> true}
  connectedOrigins: Set<string>;
  autoLockMinutes: number;
}

const session: SessionState = {
  chainId: TESTNET_CHAIN_ID_HEX,
  connectedOrigins: new Set<string>(),
  autoLockMinutes: AUTO_LOCK_MINUTES_DEFAULT,
};

// Hydrate user-added chains and the persisted active chain id as soon as
// the worker spins up. Service-worker hibernation → we re-read on every
// boot. The active-chain hydration runs after user-chains so a stored id
// pointing at a user-added chain resolves cleanly via lookupChain.
//
// The promise is captured (not fire-and-forget) so paths that must answer
// with POST-hydration state — the announce state reply, which seeds a
// dApp's provider cache for the page's whole lifetime — can await it
// instead of racing it on a cold SW start.
const bootHydrated: Promise<void> = (async () => {
  // Try session-rehydrate first. MV3 SW hibernates
  // after ~30 s idle and drops the in-memory ML-DSA backend held by
  // keystore-mldsa.ts. Pre-rehydrate, every SW restart force-locked
  // the user; post-rehydrate, we read the MEK from chrome.storage.session
  // (which survives SW restart but not browser restart), re-unwrap the
  // active vault's VEK, and rebuild the backend.
  //
  // The auto-lock deadline persists alongside the MEK. On boot we
  // honour it: if the alarm should have fired during hibernation
  // (deadline < now), clear the MEK + force-lock. Otherwise restore
  // unlocked + leave SESSION_KEY_WALLET_LOCKED = false. A fresh
  // chrome.alarms.create then re-arms the alarm for the remainder of
  // the deadline so the auto-lock contract still bites.
  let restored = false;
  try {
    const ses = await chrome.storage.session.get(SESSION_KEY_AUTO_LOCK_DEADLINE);
    const deadline = ses[SESSION_KEY_AUTO_LOCK_DEADLINE];
    if (typeof deadline === "number" && Date.now() < deadline) {
      const r = await tryRestoreFromSessionV4();
      if (r.ok) {
        restored = true;
        // Re-arm the alarm for the remaining slice. delayInMinutes
        // has a 0.5 floor in MV3; below that we just trip the alarm
        // immediately, which collapses to triggerAutoLock via the
        // existing onAlarm guard.
        const remainingMs = Math.max(0, deadline - Date.now());
        await chrome.alarms.clear(ALARM_AUTO_LOCK);
        await chrome.alarms.create(ALARM_AUTO_LOCK, {
          delayInMinutes: Math.max(remainingMs / 60_000, 1 / 60),
        });
        await chrome.storage.session.set({
          [SESSION_KEY_WALLET_LOCKED]: false,
        });
      }
    }
  } catch {
    // Defensive — any rehydrate failure falls through to the force-lock
    // below. We deliberately never throw at boot.
  }
  if (!restored) {
    // No valid session-cached MEK (or rehydrate failed) — fall back to
    // the pre-Round-4 behaviour: clear the deadline, force-lock so the
    // popup routes to UnlockScreen. Hoisted ahead of remaining hydration
    // awaits so a throw in loadConnectedSites / loadUserChains / etc.
    // (cf. 5316b25) can't leave the flag stale at false.
    await chrome.storage.session.remove(SESSION_KEY_AUTO_LOCK_DEADLINE);
    await chrome.storage.session.set({ [SESSION_KEY_WALLET_LOCKED]: true });
  }

  await loadUserChains();
  await loadOperatorOverride();
  // One-shot cleanup for any per-address cache rows that
  // leaked under a demo-data sentinel address during the popup-boot
  // race between `acc = ACCOUNTS[0]` initial state and the real
  // `wallet-active-account` IPC resolving. The popup hook now guards
  // sentinel addrs at the write source; this clears anything that
  // already landed before the guard shipped. See
  // `shared/demo-addr-sentinel.ts` for the sentinel list.
  await purgeDemoAddrCacheKeys();
  session.chainId = await loadActiveChainId();

  // Re-arm the poll if a tx was left pending across an SW restart /
  // extension reload (periodic alarms survive hibernation but a reload clears
  // them), so away-confirmations are still observed.
  if (await hasAnyPendingTx()) {
    void ensureNotifPollAlarm();
  }

  // Pre-mark WS down for operators with no explicit `ws_url`. See
  // `prefillUnknownWsEndpointsDown` for the V4-LIVE-0008 rationale.
  prefillUnknownWsEndpointsDown();

  // Seed the last-good operator (persisted in session) so the popup's first
  // chain-block poll after this boot can skip the operator-probe RTT and go
  // LIVE faster instead of lingering on CONNECTING….
  await rehydrateCachedOperator();

  // Seed the genesis-verdict cache from the prior SW lifetime so the first
  // operator probe after this wake skips the genesis round-trips (immutable
  // per chain) instead of re-probing from empty — the per-reopen cost the
  // audit's orphan-fork pinning added on top of the old net_version probe.
  await rehydrateGenesisCache();

  // Restore origins the user has previously approved. Without this, every
  // SW hibernation (~30 s idle) drops connectedOrigins back to empty and
  // dapps see eth_accounts → [] until the user re-approves.
  const sites = await loadConnectedSites();
  for (const origin of Object.keys(sites)) {
    session.connectedOrigins.add(origin);
  }

  const local = await chrome.storage.local.get(STORAGE_KEY_AUTO_LOCK_MINUTES);
  const m = local[STORAGE_KEY_AUTO_LOCK_MINUTES];
  if (typeof m === "number" && (AUTO_LOCK_OPTIONS as readonly number[]).includes(m)) {
    session.autoLockMinutes = m;
  }

  // Bind the action-icon click to side-panel or popup
  // per the user's stored preference. Re-applies on every SW boot
  // because chrome.sidePanel.setPanelBehavior + chrome.action.setPopup
  // are session-scoped: SW hibernation drops them and a fresh boot
  // needs to re-arm. Storage listener below re-applies when the user
  // toggles the setting at runtime.
  await applyUiOpenMode(await readStoredUiOpenMode());
})();

/** Read the persisted UI open mode, falling back to
 *  the default when no preference is stored or the stored value is
 *  malformed (defensive against forward-incompatible writes). */
async function readStoredUiOpenMode(): Promise<UiOpenMode> {
  const r = await chrome.storage.local.get(STORAGE_KEY_UI_OPEN_MODE);
  const v = r[STORAGE_KEY_UI_OPEN_MODE];
  if (
    typeof v === "string" &&
    (UI_OPEN_MODE_VALUES as readonly string[]).includes(v)
  ) {
    return v as UiOpenMode;
  }
  return UI_OPEN_MODE_DEFAULT;
}

/** Set Chrome to open either the side-panel or the
 *  popup when the user clicks the extension icon. Side-panel mode
 *  sets `openPanelOnActionClick: true` AND clears the action popup so
 *  the side-panel actually wins the click (Chrome falls back to the
 *  popup if it's still set). Popup mode reverses both. Calls are
 *  idempotent — safe to invoke on every boot. */
async function applyUiOpenMode(mode: UiOpenMode): Promise<void> {
  try {
    if (mode === "sidepanel") {
      if (chrome.sidePanel?.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({
          openPanelOnActionClick: true,
        });
      }
      if (chrome.action?.setPopup) {
        await chrome.action.setPopup({ popup: "" });
      }
    } else {
      if (chrome.sidePanel?.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({
          openPanelOnActionClick: false,
        });
      }
      if (chrome.action?.setPopup) {
        await chrome.action.setPopup({ popup: "src/popup/index.html" });
      }
    }
  } catch {
    // applyUiOpenMode is best-effort — if chrome.sidePanel / chrome.action
    // are unavailable (older Chromium, test env), fall back to whatever
    // the manifest declared. Don't propagate so the boot IIFE doesn't
    // bail out and skip the remaining hydration steps.
  }
}

// Storage listener re-applies UI open mode when the user toggles it
// from Settings on any extension surface. Without this, the toggle
// would only bind on next SW restart.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const change = changes[STORAGE_KEY_UI_OPEN_MODE];
  if (!change) return;
  const next = typeof change.newValue === "string" ? change.newValue : null;
  if (next && (UI_OPEN_MODE_VALUES as readonly string[]).includes(next)) {
    void applyUiOpenMode(next as UiOpenMode);
  }
});

/**
 * Pre-populate the WS down-cache for any operator whose WS URL is
 * derived via the legacy `:8545 → :8546` fallback (i.e. the SDK chain
 * registry did not pin an explicit `ws_url`). the testnet operators on
 * binary commit 5aead0f0 (V4-LIVE-0008) do not expose port
 * 8546 — a PowerShell TCP probe confirmed timeout on all six.
 *
 * Marking these URLs down before any `new WebSocket()` call suppresses
 * the browser-level `WebSocket connection to '...' failed:
 * ERR_CONNECTION_TIMED_OUT` line that would otherwise surface in the
 * service-worker console once per page load. Polling fallback already
 * covers the affected `ws-subscribe-new-heads` IPC, so the WS skip is
 * functionally transparent.
 *
 * The 10-minute `WS_FAILURE_TTL_MS` means we re-attempt periodically:
 * once operators expose 8546 the next ensureConnection() succeeds, the
 * failure-cache entry is cleared on `onopen`, and the feature lights up
 * with no code change.
 *
 * Operators whose SDK registry record carries an explicit `ws_url` are
 * skipped — those endpoints are presumed to support WS.
 */
function prefillUnknownWsEndpointsDown(): void {
  for (const op of getActiveOperators()) {
    if (op.wsRpc !== undefined) continue;
    try {
      markWsDown(deriveWsUrl(op));
    } catch {
      // Malformed operator rpc — let the normal connection path surface
      // the error rather than silently masking it.
    }
  }
}

// Hot-reload the operator override when storage changes. The popup's
// testnet-operators-set IPC writes here and the in-memory activeOperators
// list re-syncs; the `cachedOperator` answer used by the chain-status
// banner + chain-health poll is also invalidated so the next probe picks
// up the new list immediately rather than waiting for the 10s TTL.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!(STORAGE_KEY_OPERATOR_OVERRIDE in changes)) return;
  void loadOperatorOverride().then(prefillUnknownWsEndpointsDown);
  cachedOperator = null;
  // Drop the persisted liveness hint too — a since-removed operator must not be
  // rehydrated + polled (it would falsely show LIVE). The next poll re-probes
  // against the new list.
  void chrome.storage.session.remove(SESSION_KEY_LAST_OPERATOR).catch(() => {});
  // Genesis-pin trust: a fresh override list may add an operator that was never
  // probed for genesis; drop the cache so the next dispatch re-probes
  // and the About-page health view reflects fresh trust state.
  clearGenesisCache();
});

// ---- Auto-lock ----
//
// MV3 service workers hibernate on idle (~30 s) and lose the in-memory
// ML-DSA backend held by `keystore-mldsa.ts`. The actual lock therefore
// happens implicitly on hibernation; the alarm is a backstop that fires
// *while the SW is awake* (e.g. popup open + user idle) so the popup can
// re-render the Unlock screen at the user-set duration.

/** Read the user's persisted auto-lock timeout (minutes) from
 *  chrome.storage.local at call time. Arming + the Settings display read this
 *  rather than the in-memory `session.autoLockMinutes`, which on a fresh-unlock
 *  boot can still be AUTO_LOCK_MINUTES_DEFAULT — the persisted value is hydrated
 *  only late in bootHydrated, and an earlier boot await throwing skips it.
 *  Falls back to the default on an absent/invalid value or any read failure —
 *  fail-safe: a shorter timeout locks sooner, and the lock always arms. */
export async function readAutoLockMinutes(): Promise<number> {
  try {
    const local = await chrome.storage.local.get(STORAGE_KEY_AUTO_LOCK_MINUTES);
    const m = local[STORAGE_KEY_AUTO_LOCK_MINUTES];
    if (
      typeof m === "number" &&
      (AUTO_LOCK_OPTIONS as readonly number[]).includes(m)
    ) {
      return m;
    }
  } catch {
    // Storage read failed — fall back to the default (fail-safe).
  }
  return AUTO_LOCK_MINUTES_DEFAULT;
}

async function resetAutoLock(): Promise<void> {
  await chrome.alarms.clear(ALARM_AUTO_LOCK);
  if (isUnlockedV4()) {
    const minutes = await readAutoLockMinutes();
    await chrome.alarms.create(ALARM_AUTO_LOCK, {
      delayInMinutes: minutes,
    });
    const deadline = Date.now() + minutes * 60_000;
    await chrome.storage.session.set({
      [SESSION_KEY_AUTO_LOCK_DEADLINE]: deadline,
      [SESSION_KEY_WALLET_LOCKED]: false,
      // T1-03 (Item B): slide the session-MEK rehydrate cap forward on every
      // genuine user action so the password-less window is "5 min since last
      // activity", not 5 min since unlock.
      [SESSION_KEY_MEK_REHYDRATE_DEADLINE]:
        Date.now() + MEK_REHYDRATE_MAX_MINUTES * 60_000,
    });
  } else {
    await chrome.storage.session.remove([
      SESSION_KEY_AUTO_LOCK_DEADLINE,
      SESSION_KEY_MEK_REHYDRATE_DEADLINE,
    ]);
  }
}

async function triggerAutoLock(): Promise<void> {
  // Clear the session-cached MEK + deadline FIRST,
  // before lockV4()'s fire-and-forget clearMekFromSessionV4 runs, so a
  // crash mid-sequence can't leave a usable MEK + valid deadline in
  // chrome.storage.session that the next SW boot would rehydrate from.
  // The boot rehydrate gates on the deadline existing, so clearing
  // that first is sufficient — the explicit MEK_V4 remove is
  // belt-and-braces.
  await chrome.storage.session.remove([
    SESSION_KEY_AUTO_LOCK_DEADLINE,
    SESSION_KEY_MEK_V4,
    // T1-03 (Item B): also clear the rehydrate cap so a fired auto-lock leaves
    // no stale deadline that a later boot could mistake for a live window.
    SESSION_KEY_MEK_REHYDRATE_DEADLINE,
  ]);
  await chrome.storage.session.set({ [SESSION_KEY_WALLET_LOCKED]: true });
  await chrome.alarms.clear(ALARM_AUTO_LOCK);
  lockV4();
  // P4-001 D1a — a locked wallet can't sign: reject every pending dApp approval
  // so each call resolves rejected rather than hanging, and no window is stranded.
  rejectAllPending("wallet locked");
  // The bus is now empty — drop the reaper alarm (the next enqueue re-arms it).
  await chrome.alarms.clear(ALARM_APPROVAL_REAP);
}

/** Restore the unlocked session on-demand when the SW has just woken from
 *  hibernation and the boot-time `tryRestoreFromSessionV4` hasn't run yet.
 *  Without this, a `keystore-status` query that races SW boot reports a
 *  false "locked" — and because the boot path then re-writes
 *  SESSION_KEY_WALLET_LOCKED=false (a no-op when it was already false), the
 *  popup gets no onChanged event to correct itself and stays stuck on the
 *  Unlock screen even though the wallet is still within its auto-lock window.
 *  Gated by the SAME deadline the boot path uses, so it never extends the
 *  auto-lock contract: a passed deadline means the alarm already fired
 *  triggerAutoLock (which clears the session MEK), so the restore no-ops. */
async function ensureUnlockRestored(): Promise<void> {
  if (isUnlockedV4()) return;
  try {
    const ses = await chrome.storage.session.get(SESSION_KEY_AUTO_LOCK_DEADLINE);
    const deadline = ses[SESSION_KEY_AUTO_LOCK_DEADLINE];
    if (typeof deadline === "number" && Date.now() < deadline) {
      await tryRestoreFromSessionV4();
    }
  } catch {
    // Best-effort — a restore failure leaves the wallet locked (fail-closed).
  }
}

// WS infrastructure module state.
//
// `wsNewHeadsListenerInstalled` is set on first `ws-subscribe-new-heads`
// IPC so subsequent calls don't install a second listener (which would
// double-write to chrome.storage). The flag resets on SW restart, which
// is correct: the WsClient singleton also resets, so the listener
// re-installs on the next subscribe call.
let wsNewHeadsListenerInstalled = false;
/** Session-storage key the SW writes when a `newHeads` event lands.
 *  ChainStatusBanner subscribes to this key via chrome.storage.onChanged
 *  for live-block updates without polling. */
const STORAGE_KEY_WS_LAST_BLOCK_HEX = "mono.ws.lastBlockHex";
/** B2: when the head height last ADVANCED, keyed by hex ({ hex, advancedAtMs }).
 *  Separate from the hex key above (whose string shape the banner depends on).
 *  Written here only when the hex CHANGES so the popup's stall window survives a
 *  reopen — the ChainStatusBanner seeds its baseline from this on mount. */
const STORAGE_KEY_WS_BLOCK_ADVANCE = "mono.ws.lastBlockAdvancedAt";

/** Enqueue a dApp approval. The auto-lock alarm is deliberately NOT paused for
 *  the approval's lifetime (P4-001 D1a): the alarm armed at the last genuine user
 *  activity keeps ticking, so an unresolved approval can't hold the wallet
 *  unlocked past its timeout. If the lock fires first, triggerAutoLock rejects
 *  the pending approval (rejectAllPending) so the dApp gets a clean rejection
 *  rather than a hung promise. */
async function gatedEnqueue(
  req: Parameters<typeof enqueueApproval>[0],
): Promise<ApprovalDecision> {
  // P4-001 D1b — arm the TTL reaper so a pending approval can't outlive
  // APPROVAL_TTL_MS even when the user stays active and auto-lock never fires.
  await ensureApprovalReapAlarm();
  return await enqueueApproval(req);
}

// Progressive brute-force lockout — state lives in chrome.storage.session
// only (no module mirror, since SW hibernation would desync). Returns the
// longest matching window for `fails`, or 0 if no threshold is met.
function lockoutMsFor(fails: number): number {
  for (const t of LOCKOUT_THRESHOLDS) {
    if (fails >= t.fails) return t.ms;
  }
  return 0;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_AUTO_LOCK) return;
  void (async () => {
    // Advisory race guard — the alarm and a `resetAutoLock()` can collide
    // when the popup fires a user-activity op as the alarm is dispatching.
    // If the deadline has been pushed forward, bail and let the new alarm
    // do the work.
    const ses = await chrome.storage.session.get(SESSION_KEY_AUTO_LOCK_DEADLINE);
    const deadline = ses[SESSION_KEY_AUTO_LOCK_DEADLINE];
    if (typeof deadline === "number" && Date.now() < deadline) return;
    await triggerAutoLock();
  })();
});

// ---- pending-approval TTL reaper alarm (P4-001 D1b) ----
//
// Self-arming/self-clearing like the notif-poll alarm below: gatedEnqueue arms
// it when an approval is enqueued; each tick rejects approvals older than
// APPROVAL_TTL_MS and clears the alarm once the bus drains. Rejecting goes
// straight through the resolvers (NOT the `resolve` popup op), so a reap is not
// counted as user activity and never resets the auto-lock deadline.

/** Arm the approval reaper (idempotent — create with the same name replaces). */
async function ensureApprovalReapAlarm(): Promise<void> {
  try {
    await chrome.alarms.create(ALARM_APPROVAL_REAP, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5,
    });
  } catch {
    // best-effort
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_APPROVAL_REAP) return;
  void (async () => {
    const { remaining } = reapExpired(APPROVAL_TTL_MS, Date.now());
    if (remaining === 0) {
      try {
        await chrome.alarms.clear(ALARM_APPROVAL_REAP);
      } catch {
        // best-effort
      }
    }
  })();
});

// ---- notification poll alarm ----
//
// A periodic alarm that runs `pollPendingAndNotify` while any tx is pending,
// so an away-confirmation (a tx that confirms while every wallet surface is
// closed) still toasts + badges at confirm time. LOCK-INDEPENDENT — unlike
// the auto-lock alarm there is NO isUnlockedV4 gate: the poll reads only
// public receipts for already-stored hashes and writes only the notification
// store + toast + badge. Self-limiting: armed when a pending row is persisted,
// cleared when the pending set empties; the 5-min PENDING_TTL_MS backstop
// bounds any stuck tx.

/** Notification-poll alarm cadence (minutes). 0.5 = 30 s, the MV3 alarm floor
 *  on modern Chrome (was 1 min). This is BOTH the first-fire delay and the
 *  repeat period (see ensureNotifPollAlarm), so a tx that confirms while every
 *  wallet surface is closed is detected within ~30 s — the tightest a
 *  closed-extension background poll can be without a service-worker keepalive
 *  hack (the browser throttles SW wakeups to this floor). Was 1 min, which let
 *  the user reopen before the first fire so the on-open path always won — the
 *  "only notifies on open" report this fixes. */
const NOTIF_POLL_PERIOD_MIN = 0.5;
/** Per-call AbortController timeout for the poll's classification RPC. */
const NOTIF_POLL_RPC_TIMEOUT_MS = 5_000;
/** Back-off cap: periods 0.5 → 1 → 2 min (2 < the 5-min PENDING_TTL_MS, so a
 *  recoverable tx still gets one more poll before TTL eviction). */
const NOTIF_POLL_BACKOFF_CAP = 2;
let notifPollBackoff = 0;

/** Arm the poll alarm (idempotent — create with the same name replaces).
 *  NO isUnlockedV4 gate — the poll is lock-independent by design. */
async function ensureNotifPollAlarm(
  periodMin = NOTIF_POLL_PERIOD_MIN,
): Promise<void> {
  try {
    // delayInMinutes is set equal to periodInMinutes so the FIRST fire is
    // explicit at `periodMin` (a periodInMinutes-only alarm's first fire is
    // also one period out, but stating the delay guarantees it across Chrome
    // versions). Re-creating with the same name replaces the schedule, so this
    // stays idempotent.
    await chrome.alarms.create(ALARM_NOTIF_POLL, {
      delayInMinutes: periodMin,
      periodInMinutes: periodMin,
    });
  } catch {
    // best-effort
  }
}

async function clearNotifPollAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(ALARM_NOTIF_POLL);
  } catch {
    // best-effort
  }
}

/** True if ANY `mono.activity.pending.*` scope holds ≥1 row. Lock-independent
 *  prefix-scan; used for the boot re-arm + the clear/re-create race guard. */
async function hasAnyPendingTx(): Promise<boolean> {
  try {
    const all = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(null, (res) => resolve(res ?? {}));
    });
    for (const key of Object.keys(all)) {
      if (!key.startsWith("mono.activity.pending.")) continue;
      if ((validatePendingActivityCache(all[key])?.pending ?? []).length > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NOTIF_POLL) return;
  void (async () => {
    const { remaining, allFailed } = await pollPendingAndNotify();
    if (remaining === 0) {
      // Clear/re-create race guard (cf. the auto-lock deadline guard above):
      // a tx persisted between the scan and now would have re-armed via
      // persistPendingRowBackground; only clear if STILL empty. The residual
      // window is recovered by the next persist's ensureNotifPollAlarm + the
      // boot re-arm.
      if (!(await hasAnyPendingTx())) {
        await clearNotifPollAlarm();
        notifPollBackoff = 0;
      }
      return;
    }
    // Consecutive all-operators-failure back-off — lengthen the period so a
    // total outage with a stuck tx doesn't wake the SW every minute. Reset
    // the moment a tick reaches an operator again.
    if (allFailed) {
      if (notifPollBackoff < NOTIF_POLL_BACKOFF_CAP) {
        notifPollBackoff++;
        await ensureNotifPollAlarm(NOTIF_POLL_PERIOD_MIN * 2 ** notifPollBackoff);
      }
    } else if (notifPollBackoff !== 0) {
      notifPollBackoff = 0;
      await ensureNotifPollAlarm(NOTIF_POLL_PERIOD_MIN);
    }
  })();
});

// ---- Helpers ----

function ok(result: unknown): RpcResponse {
  return { result };
}
function err(code: number, message: string): RpcResponse {
  return { error: { code, message } };
}

// EIP-1193 standard error codes.
const ERR_USER_REJECTED = 4001;
const ERR_UNAUTHORIZED = 4100;
const ERR_UNSUPPORTED_METHOD = 4200;
const ERR_CHAIN_NOT_ADDED = 4902;
const ERR_INTERNAL = -32603;

// S6 #45 B1 — multisig send-bypass guard.
//
// A kind:"multisig" active vault must route every fund-moving transaction
// through the propose/approve ceremony (multisig-propose / -sign / -execute),
// NEVER the normal single-signer submit paths — otherwise the executor's lone
// signature would move the vault's funds without the M-of-N threshold (the
// chain verifies only that one signature today). The guard lives ONLY at the
// single-signer ENTRY handlers; multisig-execute reaches submitMlDsaTx
// directly with a multisig active vault and is intentionally NOT guarded (it
// IS the sanctioned broadcast). This closes the in-wallet bypass; the executor
// seed-export bypass is closeable by moving funds to a native monom M-of-N
// address (chain enforces it; SDK now exposes the witness encoders — S6-01 resolved).
const MULTISIG_SEND_REFUSAL =
  "This is a multisig wallet — transactions go through the multisig propose/approve flow.";

/** True when the active (unlocked) vault is a multisig vault. Cheap +
 *  side-effect-free: getActiveVaultIdV4 is in-memory (null when locked);
 *  readMultisigMetaV4 does one container read, needs no unlock, and returns
 *  null unless kind==="multisig". MUST be called only from the single-signer
 *  entry handlers, never from the submitMlDsaTx chokepoint (which
 *  multisig-execute reaches directly with a multisig active vault). */
async function activeVaultIsMultisig(): Promise<boolean> {
  const id = getActiveVaultIdV4();
  if (!id) return false;
  return (await readMultisigMetaV4(id)) !== null;
}

/**
 * Build an `RpcClient` for the given chain. We keep an in-memory cache keyed
 * by `<chainId, rpcUrl>` so each chain reuses a single transport across
 * calls — the service worker rebuilds the cache on cold start, which is
 * fine because the underlying transport holds no state beyond the endpoint
 * URL.
 */
const rpcClientCache = new Map<string, RpcClient>();

function rpcClientFor(chainId: string): RpcClient {
  const net = lookupChain(chainId);
  if (!net) throw new Error(`unknown chain ${chainId}`);
  const key = `${chainId}|${net.rpc}`;
  let client = rpcClientCache.get(key);
  if (!client) {
    client = new RpcClient(net.rpc);
    rpcClientCache.set(key, client);
  }
  return client;
}

/**
 * Send a single JSON-RPC method via `RpcClient.call`. Thin wrapper that
 * exists so call sites read uniformly across the file; for typed reads the
 * `RpcClient` ethX/lythX/netX helpers are preferred over this escape hatch.
 */
function rpcSend<T>(
  client: RpcClient,
  method: string,
  params: unknown[],
): Promise<T> {
  return client.call<T>(method, params);
}

async function testnetTransactionCountHex(address: string): Promise<string> {
  const { result } = await testnetJsonRpc<number | string>(
    "lyth_getTransactionCount",
    [userAddressForNativeRpc(address)],
  );
  return rpcQuantityToHex(result, "lyth_getTransactionCount");
}

// ── Local pending-nonce tracker ──────────────────────────────────────────────
// This chain has NO pending-nonce surface: `lyth_getTransactionCount` returns
// the COMMITTED nonce and the runtime ignores any block tag, so a 2nd tx sent
// before the 1st commits would reuse the same nonce → the operator mempool
// rejects it ("replace underpriced"). We therefore remember the highest
// nonce THIS wallet successfully submitted per (address, chainId) and advance
// past it. Strictly LOCAL (we never trust an operator's pending count — there
// is none), and TTL-healed so a dropped/never-committed tx cannot wedge the
// nonce: past the TTL we fall back to the committed nonce.
const PENDING_NONCE_KEY = "mono.nonce.pending"; // chrome.storage.session
// Must exceed the encrypted-mempool reveal/commit latency (~12s) with margin so
// a still-pending nonce isn't reused prematurely; short enough to self-heal a
// dropped tx quickly.
const PENDING_NONCE_TTL_MS = 5 * 60 * 1000;

interface PendingNonceEntry {
  /** Highest nonce successfully submitted for this (address, chainId). */
  nonce: number;
  /** Recorded-at (ms epoch); entries past PENDING_NONCE_TTL_MS are ignored. */
  ts: number;
}

function pendingNonceKey(address: string, chainIdHex: string): string {
  return `${address.toLowerCase()}:${chainIdHex.toLowerCase()}`;
}

async function readPendingNonceMap(): Promise<Record<string, PendingNonceEntry>> {
  try {
    const ses = await chrome.storage.session.get(PENDING_NONCE_KEY);
    const m = ses[PENDING_NONCE_KEY];
    return m !== null && typeof m === "object"
      ? (m as Record<string, PendingNonceEntry>)
      : {};
  } catch {
    return {};
  }
}

/** Nonce hex to sign: max(committed-from-chain, local-pending + 1), TTL-healed.
 *  Falls back to the committed nonce on any error or a stale/absent entry. */
async function nextNonceHex(address: string, chainIdHex: string): Promise<string> {
  const committedHex = await testnetTransactionCountHex(address);
  let next: bigint;
  try {
    next = BigInt(committedHex);
  } catch {
    return committedHex;
  }
  try {
    const entry = (await readPendingNonceMap())[
      pendingNonceKey(address, chainIdHex)
    ];
    if (
      entry !== undefined &&
      typeof entry.nonce === "number" &&
      typeof entry.ts === "number" &&
      Date.now() - entry.ts < PENDING_NONCE_TTL_MS
    ) {
      const localNext = BigInt(entry.nonce) + 1n;
      if (localNext > next) next = localNext;
    }
  } catch {
    // fall through to the committed nonce
  }
  return "0x" + next.toString(16);
}

/** Record a successfully-submitted nonce so the next tx advances past it. Only
 *  the SUCCESS path calls this (a rejected submit must NOT advance the nonce). */
async function recordSubmittedNonce(
  address: string,
  chainIdHex: string,
  nonceHex: string,
): Promise<void> {
  try {
    const used = Number(BigInt(nonceHex));
    if (!Number.isFinite(used) || used < 0) return;
    const map = await readPendingNonceMap();
    const key = pendingNonceKey(address, chainIdHex);
    const prev = map[key];
    const highest =
      prev !== undefined && Date.now() - prev.ts < PENDING_NONCE_TTL_MS
        ? Math.max(prev.nonce, used)
        : used;
    map[key] = { nonce: highest, ts: Date.now() };
    await chrome.storage.session.set({ [PENDING_NONCE_KEY]: map });
  } catch {
    // best-effort — a write failure just means the next tx re-reads committed
  }
}

interface ExecutionUnitPriceQuoteHex {
  executionUnitPriceHex: string;
  basePriceHex: string;
  priorityTipHex: string;
}

async function testnetExecutionUnitPriceQuoteHex(): Promise<ExecutionUnitPriceQuoteHex> {
  const { result } = await testnetJsonRpc<Record<string, unknown>>(
    "lyth_executionUnitPrice",
    [],
  );
  return {
    executionUnitPriceHex: rpcQuantityToHex(
      (result.executionUnitPriceLythoshi ?? result.execution_unit_price_lythoshi) as number | string | bigint,
      "lyth_executionUnitPrice.executionUnitPriceLythoshi",
    ),
    basePriceHex: rpcQuantityToHex(
      (result.basePricePerExecutionUnitLythoshi ?? result.base_price_per_execution_unit_lythoshi) as number | string | bigint,
      "lyth_executionUnitPrice.basePricePerExecutionUnitLythoshi",
    ),
    priorityTipHex: rpcQuantityToHex(
      (result.priorityTipLythoshi ?? result.priority_tip_lythoshi) as number | string | bigint,
      "lyth_executionUnitPrice.priorityTipLythoshi",
    ),
  };
}

async function testnetExecutionUnitPriceHex(): Promise<string> {
  return (await testnetExecutionUnitPriceQuoteHex()).executionUnitPriceHex;
}

function rpcQuantityToHex(value: number | string | bigint, field: string): string {
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} returned an invalid quantity`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} returned an invalid quantity`);
    parsed = value;
  } else if (/^0x[0-9a-fA-F]+$/.test(value)) {
    parsed = BigInt(value);
  } else if (/^[0-9]+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error(`${field} returned an invalid quantity`);
  }
  return `0x${parsed.toString(16)}`;
}

/**
 * T4-04 (Item D, b1) — accept a popup-supplied `signedFee`: the EXACT fee the
 * Send preview displayed (base + tier-scaled tip, and the unit limit). When
 * present the SW signs THIS instead of a second `suggestFee` operator read,
 * closing both the display-vs-sign double-read and the Slow/Fast tier-multiplier
 * desync. Every field is re-validated through `rpcQuantityToHex` (rejects
 * negatives/garbage). Returns null when absent or malformed (caller falls back
 * to `suggestFee`). The ceiling clamp is applied by the caller, not here.
 */
function acceptSignedFee(signedFee: unknown): {
  maxFeePerGasHex: string;
  maxPriorityFeePerGasHex: string;
  executionUnitLimitHex: string;
} | null {
  if (signedFee == null || typeof signedFee !== "object") return null;
  const f = signedFee as Record<string, unknown>;
  if (
    typeof f.maxFeePerGasHex !== "string" ||
    typeof f.maxPriorityFeePerGasHex !== "string" ||
    typeof f.executionUnitLimitHex !== "string"
  ) {
    return null;
  }
  try {
    return {
      maxFeePerGasHex: rpcQuantityToHex(f.maxFeePerGasHex, "signedFee.maxFeePerGas"),
      maxPriorityFeePerGasHex: rpcQuantityToHex(
        f.maxPriorityFeePerGasHex,
        "signedFee.maxPriorityFeePerGas",
      ),
      executionUnitLimitHex: rpcQuantityToHex(
        f.executionUnitLimitHex,
        "signedFee.executionUnitLimit",
      ),
    };
  } catch {
    return null;
  }
}

// T2-01 — tab→origin map so account-carrying provider events can be scoped to
// connected origins WITHOUT the "tabs" permission (reading a tab's URL would
// need it and triggers a "read your browsing history" store warning). Populated
// from the bridge-stamped origin on each rpc message (see the onMessage rpc
// branch) AND from the content-script origin-announce sent on load (the
// onMessage "announce" branch); entries self-clean on send failure (tab closed).
// The announce flips the entry the instant a new page loads, so the former
// "stale until the tab's next rpc" residual on cross-origin navigation now
// closes at the content-script load instant — still permission-free.
const tabOriginById = new Map<number, string>();

function broadcastEvent(event: string, payload: unknown): void {
  // T2-01 — account-carrying events (the wallet address) go ONLY to connected
  // origins. chainChanged and other non-address events keep the broadcast-to-
  // all path: they leak nothing, and scoping them would expose the navigation-
  // staleness residual on a non-sensitive event for no benefit.
  if (event === "accountsChanged" || event === "connect") {
    for (const [tabId, origin] of tabOriginById) {
      if (!session.connectedOrigins.has(origin)) continue;
      chrome.tabs
        .sendMessage(tabId, { kind: "event", event, payload })
        .catch(() => {
          tabOriginById.delete(tabId);
        });
    }
    return;
  }
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { kind: "event", event, payload }).catch(() => {
        /* tab may not host our content script; ignore */
      });
    }
  });
}

// T2-03 — EIP-1193 disconnect: a scoped accountsChanged:[] to one origin's tabs
// so a revoked dApp learns it lost access instead of keeping a stale account.
function broadcastDisconnect(origin: string): void {
  for (const [tabId, o] of tabOriginById) {
    if (o !== origin) continue;
    chrome.tabs
      .sendMessage(tabId, { kind: "event", event: "accountsChanged", payload: [] })
      .catch(() => {
        tabOriginById.delete(tabId);
      });
  }
}

/** Connection-scoped provider state — the single source for what a dApp
 *  origin may learn about the wallet without an approval. Mirrors the
 *  `eth_accounts` arm exactly: locked → no accounts (never leak the address
 *  while locked); unlocked but origin not connected → no accounts. `chainId`
 *  is included unconditionally — the `eth_chainId` arm already answers any
 *  origin without a connection check (public, non-identifying). Used by BOTH
 *  the `eth_accounts` arm and the announce state reply so the scoping logic
 *  cannot drift between the two paths. */
function connectionScopedProviderState(origin: string): {
  accounts: string[];
  chainId: string;
} {
  const addr = getUnlockedAddressV4();
  const accounts =
    addr !== null && session.connectedOrigins.has(origin) ? [addr] : [];
  return { accounts, chainId: session.chainId };
}

// ---- RPC dispatch ----

async function handleRpc(message: RpcMessage): Promise<RpcResponse> {
  const { method, params } = message.args;
  const origin = message.origin;

  switch (method) {
    case "eth_chainId":
      return ok(session.chainId);

    case "net_version":
      return ok(String(parseInt(session.chainId, 16)));

    case "eth_accounts": {
      // Locked → no accounts (never resolve or leak the address to a dApp
      // while locked); unconnected → no accounts. The scoping logic lives in
      // connectionScopedProviderState, shared with the announce state reply.
      return ok(connectionScopedProviderState(origin).accounts);
    }

    case "eth_requestAccounts": {
      // If wallet doesn't exist yet, surface a clear error so the dapp can
      // tell the user to onboard. We could also auto-open the popup at the
      // onboarding screen — left to next stage.
      if (!(await hasContainerV4())) {
        return err(ERR_UNAUTHORIZED, "Monolythium Wallet has no vault — open the extension and complete onboarding first");
      }
      // Decision §9: already-connected origin + unlocked wallet
      // resolves silently. Locked or unconnected falls through to approval.
      // No accountsChanged/connect re-emit — dApp is already connected.
      if (session.connectedOrigins.has(origin) && isUnlockedV4()) {
        const cached = getUnlockedAddressV4();
        if (cached) {
          return ok([cached]);
        }
      }
      const decision = await gatedEnqueue({ kind: "connect", origin });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the connection");
      }
      // After approval the keystore must be unlocked (popup unlocks before
      // confirming). If not, fail closed.
      const addr = getUnlockedAddressV4();
      if (!addr) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      session.connectedOrigins.add(origin);
      await saveConnectedSite(origin, addr);
      broadcastEvent("accountsChanged", [addr]);
      broadcastEvent("connect", { chainId: session.chainId });
      return ok([addr]);
    }

    case "eth_sign":
    case "personal_sign": {
      // `eth_sign` is the legacy alias dapp libraries still send. We treat it
      // identically to `personal_sign` (apply the EIP-191 prefix and require
      // user approval) — this is the safe MetaMask-shaped behaviour. Wallets
      // that bypass the prefix have shipped phishing-friendly attack
      // surfaces; we deliberately do not.
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      // EIP-191 personal_sign params: [message, address] (modern) or
      // [address, message] (legacy MetaMask / `eth_sign` order). Detect by
      // looking at which arg is an address.
      const arr = Array.isArray(params) ? params : [];
      let messageParam: unknown;
      const a = arr[0];
      const b = arr[1];
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        messageParam = b;
      } else {
        messageParam = a;
      }
      if (typeof messageParam !== "string") {
        return err(-32602, "personal_sign expects a message string");
      }

      const decision = await gatedEnqueue({
        kind: "personal_sign",
        origin,
        message: messageParam,
        address: getUnlockedAddressV4() ?? "",
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the message");
      }
      if (!isUnlockedV4()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      try {
        // The wallet's on-chain address is derived from the ML-DSA-65
        // pubkey; the early `if (!isUnlockedV4()) return err` above
        // guarantees the v4 backend is unlocked here.
        const sig = personalSignV4(messageParam);
        return ok("0x" + bytesToHex(sig));
      } catch (e) {
        return err(ERR_INTERNAL, `signing failed: ${(e as Error).message}`);
      }
    }

    case "eth_sendTransaction": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      const txReq = (arr[0] as EthSendTransactionRequest | undefined) ?? {};
      if (!chainRequiresMlDsa(session.chainId)) {
        return err(4200, "eth_sendTransaction only supports native encrypted Monolythium Testnet sends");
      }
      // S6 #45 B1: refuse single-signer sends from a multisig active vault —
      // they must go through the propose/approve ceremony (not this lone-
      // executor path). Checked before buildSendTxView so no operator RPC fires.
      if (await activeVaultIsMultisig()) {
        return err(ERR_UNAUTHORIZED, MULTISIG_SEND_REFUSAL);
      }

      // NN-01: snapshot the active vault id at view-build time (synchronously,
      // before any await / the separate-window approval) so a vault-select
      // landing DURING the approval await is caught at sign time. The popup
      // displays `txReq.from ?? getUnlockedAddressV4()` off the same global, so
      // this binds the signer to the displayed vault. Coalesced post-unlock
      // below for the locked-at-view-build case (no false abort).
      const boundVaultIdAtView = getActiveVaultIdV4();
      // Build the approval view BEFORE opening the popup so the user sees
      // real numbers (execution-unit estimate, simulation outcome, nonce)
      // instead of demo placeholders. RPC failures degrade gracefully; the
      // user can still approve, but the popup will surface the gap.
      const view = await buildSendTxView(txReq);
      const approvalTx = {
        ...(typeof txReq.from === "string" ? { from: txReq.from } : {}),
        ...(typeof txReq.to === "string" ? { to: txReq.to } : {}),
        ...(typeof txReq.value === "string" ? { value: txReq.value } : {}),
        ...(typeof txReq.data === "string" ? { data: txReq.data } : {}),
        ...(typeof txReq.gas === "string" ? { gas: txReq.gas } : {}),
        ...(typeof txReq.gasPrice === "string" ? { gasPrice: txReq.gasPrice } : {}),
        ...(typeof txReq.maxFeePerGas === "string" ? { maxFeePerGas: txReq.maxFeePerGas } : {}),
        ...(typeof txReq.maxPriorityFeePerGas === "string"
          ? { maxPriorityFeePerGas: txReq.maxPriorityFeePerGas }
          : {}),
        ...(typeof txReq.nonce === "string" ? { nonce: txReq.nonce } : {}),
        ...(typeof txReq.chainId === "string" ? { chainId: txReq.chainId } : {}),
      };

      const decision = await gatedEnqueue({
        kind: "send_tx",
        origin,
        tx: approvalTx,
        view,
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the transaction");
      }

      // Monolythium-protocol chains require the SDK's ML-DSA-65 bincode
      // wire format. The v3 keystore holds the unlocked backend; reads and
      // writes use the published testnet operators while the canonical
      // alias is unavailable.
      if (chainRequiresMlDsa(session.chainId)) {
        if (!isUnlockedV4()) {
          return err(ERR_UNAUTHORIZED, "wallet is locked");
        }
        // NN-01: if locked at view-build (snapshot null), coalesce to the
        // post-unlock active vault — the isUnlockedV4 gate above guarantees a
        // non-null read here; guard defensively. Either branch binds the
        // correct vault with no false abort (unlocked-at-view → displayed
        // vault, catches the approval-window swap; locked-at-view → post-unlock
        // vault, catches the sign-time window).
        const boundVaultId = boundVaultIdAtView ?? getActiveVaultIdV4();
        if (boundVaultId === null) {
          return err(ERR_UNAUTHORIZED, "wallet is locked");
        }
        try {
          const fromAddr =
            getUnlockedAddressV4() ?? "0x0000000000000000000000000000000000000000";
          // Resolve missing nonce/execution units/fee from the operators directly —
          // the chain registry's RPC alias resolves NXDOMAIN and the
          // existing `view` was built against that broken alias too, so
          // its fields are usually null on the testnet.
          const nonceHex =
            txReq.nonce ?? view.nonce ??
            await testnetTransactionCountHex(fromAddr);
          // Prefer the price captured into `view` at approval time over a
          // fresh read, then clamp to the sane ceiling (T4-04 D3) so a
          // malicious/MITM operator cannot inflate the fee signed into the
          // plaintext submission on the dApp path either.
          const rawExecutionUnitPriceHex =
            txReq.gasPrice ?? view.pricePerExecutionUnitLythoshiHex ??
            await testnetExecutionUnitPriceHex();
          const executionUnitPriceHex =
            "0x" +
            clampToSaneBound(
              BigInt(rawExecutionUnitPriceHex),
              MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
            ).toString(16);
          // the testnet's mempool intrinsic execution-unit floor is above what
          // the compatibility estimate reports. Honour an explicit dapp
          // execution-unit hint if provided; otherwise use the wallet's
          // The testnet floor with headroom.
          const executionUnitsHex =
            txReq.gas ??
            view.executionUnitLimitHex ??
            TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX;

          // Sign + submit via the plaintext mesh_submitTx path.
          // The testnet does not use an eth_sendRawTransaction fallback path.
          const { txHash } = await submitMlDsaTx({
            ...(txReq.to !== undefined ? { to: txReq.to } : {}),
            ...(txReq.value !== undefined ? { value: txReq.value } : {}),
            ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            nonce: nonceHex,
            gas: executionUnitsHex,
            gasPrice: executionUnitPriceHex,
            chainIdHex: session.chainId,
          }, boundVaultId);
          return ok(txHash);
        } catch (e) {
          return err(ERR_INTERNAL, `ml-dsa tx failed: ${(e as Error).message}`);
        }
      }

      return err(4200, "eth_sendTransaction only supports native encrypted Monolythium Testnet sends");
    }

    case "monolythium_submitMrvNativePlan": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      const first = arr[0];
      const wrapped =
        first !== null &&
        typeof first === "object" &&
        "plan" in (first as Record<string, unknown>);
      const plan = wrapped
        ? (first as { plan?: WalletMrvNativeSubmissionPlan }).plan
        : (first as WalletMrvNativeSubmissionPlan | undefined);
      if (plan === null || typeof plan !== "object") {
        return err(-32602, "monolythium_submitMrvNativePlan expects an MRV native submission plan");
      }
      const requestedChainId =
        wrapped && typeof (first as { chainIdHex?: unknown }).chainIdHex === "string"
          ? (first as { chainIdHex: string }).chainIdHex
          : session.chainId;
      const chainIdHex = canonicalChainKey(requestedChainId);
      if (chainIdHex !== canonicalChainKey(session.chainId)) {
        return err(-32602, "MRV native submission chainId must match the active wallet chain");
      }
      if (!chainRequiresMlDsa(chainIdHex)) {
        return err(-32602, "MRV native submission is only wired for Monolythium Testnet today");
      }
      const displayFromAddr = getUnlockedAddressV4();
      if (!displayFromAddr) {
        return err(ERR_UNAUTHORIZED, "wallet has no address");
      }
      // S6 #45 B1: a multisig active vault must use the propose/approve flow.
      if (await activeVaultIsMultisig()) {
        return err(ERR_UNAUTHORIZED, MULTISIG_SEND_REFUSAL);
      }

      let txReq: ReturnType<typeof walletMrvNativePlanToSubmitTx>;
      try {
        // T4-04 (Item D, a1): clamp the caller-supplied plan fee before it is
        // displayed + signed (this path bypasses the wallet-send-tx clamp).
        txReq = clampMrvSubmitTxFee(
          walletMrvNativePlanToSubmitTx(plan, {
            chainIdHex,
            fromAddress: displayFromAddr,
          }),
        );
      } catch (e) {
        return err(-32602, (e as Error).message);
      }

      const decision = await gatedEnqueue(buildMrvNativeSendTxApproval(origin, txReq, chainIdHex));
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the MRV native transaction");
      }
      if (!isUnlockedV4()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return err(ERR_UNAUTHORIZED, "wallet has no unlocked address");
      }
      // NN-01: bind to the post-approval active vault. The existing plan.from
      // re-check (mrv-native-plan.ts) covers the wide approval window; this
      // closes the one-await residual before the sign.
      const boundVaultId = getActiveVaultIdV4();
      if (boundVaultId === null) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      try {
        // Clamp the submit-side tx identically so the signed fee equals the
        // approval-side fee shown to the user (bind preserved).
        const approvedTxReq = clampMrvSubmitTxFee(
          walletMrvNativePlanToSubmitTx(plan, {
            chainIdHex,
            fromAddress: fromAddr,
          }),
        );
        const { txHash, via } = await submitMlDsaTx(approvedTxReq, boundVaultId);
        return ok({ txHash, via });
      } catch (e) {
        return err(ERR_INTERNAL, `MRV native submission failed: ${(e as Error).message}`);
      }
    }

    case "monolythium_submitMrvNativeCall": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      const p = arr[0] as {
        contractAddress?: unknown;
        input?: unknown;
        chainIdHex?: unknown;
        executionUnitLimitHex?: unknown;
        maxExecutionFeeLythoshiHex?: unknown;
        priorityTipLythoshiHex?: unknown;
        valueWeiHex?: unknown;
      } | undefined;
      if (typeof p?.contractAddress !== "string") {
        return err(-32602, "monolythium_submitMrvNativeCall: missing contractAddress");
      }
      if (typeof p?.input !== "string") {
        return err(-32602, "monolythium_submitMrvNativeCall: missing input");
      }
      if (typeof p?.executionUnitLimitHex !== "string") {
        return err(-32602, "monolythium_submitMrvNativeCall: missing executionUnitLimitHex");
      }
      const requestedChainId = typeof p.chainIdHex === "string" ? p.chainIdHex : session.chainId;
      const chainIdHex = canonicalChainKey(requestedChainId);
      if (chainIdHex !== canonicalChainKey(session.chainId)) {
        return err(-32602, "MRV native submission chainId must match the active wallet chain");
      }
      if (!chainRequiresMlDsa(chainIdHex)) {
        return err(-32602, "MRV native submission is only wired for Monolythium Testnet today");
      }
      const displayFromAddr = getUnlockedAddressV4();
      if (!displayFromAddr) {
        return err(ERR_UNAUTHORIZED, "wallet has no address");
      }
      // S6 #45 B1: a multisig active vault must use the propose/approve flow.
      if (await activeVaultIsMultisig()) {
        return err(ERR_UNAUTHORIZED, MULTISIG_SEND_REFUSAL);
      }
      let contractAddress: string;
      try {
        contractAddress = requireTypedMrvContractAddress(p.contractAddress).typed;
      } catch (e) {
        return err(-32602, (e as Error).message);
      }

      let plan: WalletMrvNativeSubmissionPlan;
      let txReq: ReturnType<typeof walletMrvNativePlanToSubmitTx>;
      try {
        const nonceHex = await testnetTransactionCountHex(displayFromAddr);
        const fee =
          typeof p.maxExecutionFeeLythoshiHex !== "string" ||
          typeof p.priorityTipLythoshiHex !== "string"
            ? await suggestFee(chainIdHex)
            : null;
        // T4-04 (Item D, a1): clamp the caller/operator-influenced fee to the
        // sane ceiling BEFORE it is bound into the plan + signed — the MRV path
        // is the one fee-bearing send the wallet-send-tx clamp doesn't cover.
        // Clamping at the input means the captured `plan` (and therefore both
        // the approval-side `txReq` and the submit-side `approvedTxReq` derived
        // from it) carry the clamped fee, so display == signed. Mirrors the
        // eth_sendTransaction (1616) / wallet-send-tx (8734) rails.
        const clampedMaxExecutionFeeHex =
          "0x" +
          clampToSaneBound(
            BigInt(
              typeof p.maxExecutionFeeLythoshiHex === "string"
                ? p.maxExecutionFeeLythoshiHex
                : fee?.maxFeePerGas ?? "0x0",
            ),
            MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
          ).toString(16);
        const input: WalletMrvCallNativePlanInput = {
          fromAddress: displayFromAddr,
          chainIdHex,
          nonceHex,
          executionUnitLimitHex: p.executionUnitLimitHex,
          maxExecutionFeeLythoshiHex: clampedMaxExecutionFeeHex,
          priorityTipLythoshiHex: clampPriorityTipToMaxFee(
            typeof p.priorityTipLythoshiHex === "string"
              ? p.priorityTipLythoshiHex
              : fee?.maxPriorityFeePerGas ?? "0x0",
            clampedMaxExecutionFeeHex,
          ),
          contractAddress,
          input: p.input,
        };
        if (typeof p.valueWeiHex === "string") input.valueWeiHex = p.valueWeiHex;
        plan = buildWalletMrvCallNativePlan(input);
        txReq = walletMrvNativePlanToSubmitTx(plan, {
          chainIdHex,
          fromAddress: displayFromAddr,
        });
      } catch (e) {
        return err(ERR_INTERNAL, `MRV native call planning failed: ${(e as Error).message}`);
      }

      const decision = await gatedEnqueue(buildMrvNativeSendTxApproval(origin, txReq, chainIdHex));
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the MRV native transaction");
      }
      if (!isUnlockedV4()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return err(ERR_UNAUTHORIZED, "wallet has no unlocked address");
      }
      // NN-01: same post-approval bind + one-await residual closure as the
      // Plan arm (the plan.from re-check covers the wide approval window).
      const boundVaultId = getActiveVaultIdV4();
      if (boundVaultId === null) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      try {
        const approvedTxReq = walletMrvNativePlanToSubmitTx(plan, {
          chainIdHex,
          fromAddress: fromAddr,
        });
        const { txHash, via } = await submitMlDsaTx(approvedTxReq, boundVaultId);
        return ok({ txHash, via, plan });
      } catch (e) {
        return err(ERR_INTERNAL, `MRV native submission failed: ${(e as Error).message}`);
      }
    }

    case "eth_signTypedData_v4":
    case "eth_signTypedData": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      // EIP-712 dapps pass [address, typedData]; some swap the slots. We only
      // need to locate the typed-data slot (the non-address one). The dApp-
      // supplied address is intentionally NOT carried into the approval: the
      // wallet always signs with — and the approval always displays — its own
      // unlocked address (see the gatedEnqueue payload below), so a dApp cannot
      // make the "Signing as" line show a foreign address (F-2.9a / WYSIWYS).
      let dataParam: unknown = null;
      const a = arr[0];
      const b = arr[1];
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        dataParam = b;
      } else if (typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(b)) {
        dataParam = a;
      } else {
        // Fall back: assume canonical [address, data].
        dataParam = b;
      }
      if (dataParam == null) {
        return err(-32602, "eth_signTypedData_v4 expects [address, typedData]");
      }
      const rawTypedData =
        typeof dataParam === "string" ? dataParam : JSON.stringify(dataParam);
      const parsed = parseTypedData(rawTypedData);
      let digest: string | null = null;
      if (parsed) {
        try {
          digest = "0x" + bytesToHex(computeTypedDataDigest(parsed));
        } catch {
          digest = null;
        }
      }

      const decision = await gatedEnqueue({
        kind: "typed_sign",
        origin,
        address: getUnlockedAddressV4() ?? "",
        rawTypedData,
        parsed,
        digest,
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the typed data");
      }
      if (!isUnlockedV4()) return err(ERR_UNAUTHORIZED, "wallet is locked");
      if (!parsed) {
        return err(-32602, "typed data could not be parsed as EIP-712 v4");
      }
      try {
        // Same v4 routing as personal_sign — the v4 ML-DSA backend is the
        // one whose pubkey defines the wallet's on-chain address. The early
        // `if (!isUnlockedV4())` guard above guarantees it is unlocked here.
        const sig = signTypedDataV4FromV4(parsed);
        return ok("0x" + bytesToHex(sig));
      } catch (e) {
        return err(ERR_INTERNAL, `typed-data sign failed: ${(e as Error).message}`);
      }
    }

    case "eth_sendRawTransaction": {
      return err(4200, "eth_sendRawTransaction is not supported by this wallet");
    }

    // Reject these at the wallet boundary with 4200. Two distinct reasons:
    // eth_call / eth_estimateGas ARE served by the chain (read-only
    // native-executor views) but the wallet does not proxy arbitrary EVM reads
    // by design (native / non-EVM chain → dApps use their own RPC); the six
    // eth_*Filter methods are genuinely retired by the chain. A clear boundary
    // answer beats a chain round-trip either way.
    case "eth_call":
    case "eth_estimateGas":
    case "eth_newFilter":
    case "eth_newBlockFilter":
    case "eth_newPendingTransactionFilter":
    case "eth_uninstallFilter":
    case "eth_getFilterChanges":
    case "eth_getFilterLogs": {
      return err(
        4200,
        `${method} is not proxied by this wallet. Monolythium is a native (non-EVM) chain — use your own RPC for chain reads, or submit via the wallet UI.`,
      );
    }

    case "wallet_switchEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_switchEthereumChain: missing chainId param");
      const found = lookupChain(requested);
      if (!found) {
        return err(ERR_CHAIN_NOT_ADDED, "Unknown chain. Use wallet_addEthereumChain first.");
      }
      // A chain switch mutates GLOBAL wallet state (active chainId, persisted, +
      // a chainChanged broadcast to every tab), so it must be authorized like any
      // other state-changing dApp method: the origin must be connected AND the
      // user must approve. Previously this arm applied the switch with no gate at
      // all — any page, even unconnected, could silently flip the active chain
      // (F-2.5). Param-validation (-32602) and unknown-chain (ERR_CHAIN_NOT_ADDED)
      // still answer first so the EIP-3326 dApp contract is preserved for callers.
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const decision = await gatedEnqueue({ kind: "switch_chain", origin, chainId: requested });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the chain switch");
      }
      session.chainId = canonicalChainKey(requested);
      await persistActiveChainId(session.chainId);
      broadcastEvent("chainChanged", session.chainId);
      return ok(null);
    }

    case "wallet_addEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as Partial<AddChainSpec> | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_addEthereumChain: missing chainId param");
      // EIP-3085 says we may silently no-op if the chain is already known.
      if (lookupChain(requested)) {
        return ok(null);
      }
      // Validate minimal shape; unknown chain — ask the user.
      if (!Array.isArray(p?.rpcUrls) || (p?.rpcUrls?.length ?? 0) === 0) {
        return err(-32602, "wallet_addEthereumChain: rpcUrls must be a non-empty array");
      }
      const spec: AddChainSpec = {
        chainId: requested,
        chainName: typeof p?.chainName === "string" ? p.chainName : "Unnamed chain",
        rpcUrls: p.rpcUrls as string[],
        ...(Array.isArray(p?.blockExplorerUrls) ? { blockExplorerUrls: p.blockExplorerUrls } : {}),
        ...(Array.isArray(p?.iconUrls) ? { iconUrls: p.iconUrls } : {}),
        ...(p?.nativeCurrency ? { nativeCurrency: p.nativeCurrency } : {}),
      };
      const decision = await gatedEnqueue({ kind: "add_chain", origin, chain: spec });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the new chain");
      }
      // Persist for subsequent sessions.
      const key = canonicalChainKey(spec.chainId);
      const chainIdNum = parseHexQuantity(spec.chainId);
      userChains[key] = {
        name: spec.chainName,
        rpc: spec.rpcUrls[0]!,
        chainIdNum,
        ...(spec.blockExplorerUrls?.[0] ? { blockExplorer: spec.blockExplorerUrls[0] } : {}),
        ...(spec.nativeCurrency ? { nativeCurrency: spec.nativeCurrency } : {}),
      };
      await persistUserChains();
      return ok(null);
    }

    default:
      return err(ERR_UNSUPPORTED_METHOD, `Method ${method} is not supported by Monolythium Wallet yet`);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function parseHexQuantity(hex: string): number {
  const r = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (r.length === 0) return 0;
  const n = parseInt(r, 16);
  return Number.isNaN(n) ? 0 : n;
}

// EIP-3085 chain ids are hex-encoded but case-insensitive on the wire. We
// normalize to the casing used by the BUILTIN_CHAINS keys (`0x1B1C` style)
// so lookups don't drift.
function canonicalChainKey(id: string): string {
  if (!id.startsWith("0x") && !id.startsWith("0X")) {
    // Allow decimal input and convert.
    const asNum = Number.parseInt(id, 10);
    if (!Number.isNaN(asNum)) {
      return "0x" + asNum.toString(16).toUpperCase();
    }
    return "0x" + id.toUpperCase();
  }
  return "0x" + id.slice(2).toUpperCase();
}

/**
 * Best-effort EIP-712 v4 parser. Accepts the JSON string the dapp sent
 * (modern wallets pass strings; some legacy wallets pass an object). Returns
 * null when the input cannot be coerced into the canonical envelope shape.
 */
function parseTypedData(raw: string): TypedDataEnvelope | null {
  try {
    const obj = JSON.parse(raw) as {
      domain?: Record<string, unknown>;
      types?: Record<string, Array<{ name: string; type: string }>>;
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    if (!obj.domain || !obj.types || !obj.primaryType || !obj.message) return null;
    return {
      domain: obj.domain,
      types: obj.types,
      primaryType: obj.primaryType,
      message: obj.message,
    };
  } catch {
    return null;
  }
}

/**
 * Pre-populate the `SendTxView` shown on the approval popup. The wallet does
 * not run an on-chain simulation for the approval view — it shows declared
 * intent (recipient, value, calldata, fee) without a simulated outcome. (The
 * chain DOES serve `eth_call` / `eth_estimateGas` as read-only native-executor
 * views, but the wallet does not use them for the approval preview.) Fee and
 * nonce reads still go through the chain's curated passive surface
 * (`eth_gasPrice` / `eth_getTransactionCount`) or the testnet native helpers
 * when running against a testnet operator.
 */
async function buildSendTxView(
  txReq: EthSendTransactionRequest,
): Promise<SendTxView> {
  const chainId = session.chainId;
  const net = lookupChain(chainId);
  const chainLabel = net?.name ?? chainId;

  const view: SendTxView = {
    executionUnitLimitHex: txReq.gas ?? null,
    pricePerExecutionUnitLythoshiHex: txReq.gasPrice ?? null,
    nonce: txReq.nonce ?? null,
    simulation: null,
    chainId,
    chainLabel,
  };
  if (!net) return view;

  const client = rpcClientFor(chainId);
  // SEPARATE FINDING (NOT NN-01; tracked for its own triage): the approval view
  // displays `txReq.from ?? getUnlockedAddressV4()`, but the wallet always SIGNS
  // with the active vault's backend. A dApp-supplied `from` that differs from
  // the active vault is a pre-existing display-vs-sign WYSIWYS gap, independent
  // of the NN-01 active-vault TOCTOU (which binds the signer to the active vault
  // via boundVaultId). Do not conflate the two.
  const fromAddr =
    txReq.from ?? getUnlockedAddressV4() ?? "0x0000000000000000000000000000000000000000";

  const [pricePerExecutionUnitLythoshiHex, nonce] = await Promise.all([
    view.pricePerExecutionUnitLythoshiHex != null
      ? Promise.resolve(view.pricePerExecutionUnitLythoshiHex)
      : (chainRequiresMlDsa(chainId)
          ? testnetExecutionUnitPriceHex()
          : rpcSend<string>(client, "eth_gasPrice", []))
          .catch(() => null as string | null),
    view.nonce != null
      ? Promise.resolve(view.nonce)
      : (chainRequiresMlDsa(chainId)
          ? testnetTransactionCountHex(fromAddr)
          : rpcSend<string>(client, "eth_getTransactionCount", [fromAddr, "pending"]))
          .catch(() => null as string | null),
  ]);

  view.pricePerExecutionUnitLythoshiHex = pricePerExecutionUnitLythoshiHex;
  view.nonce = nonce;
  return view;
}

function buildMrvNativeSendTxApproval(
  origin: string,
  txReq: ReturnType<typeof walletMrvNativePlanToSubmitTx>,
  chainIdHex: string,
): Parameters<typeof gatedEnqueue>[0] {
  const chainLabel = lookupChain(chainIdHex)?.name ?? chainIdHex;
  return {
    kind: "send_tx",
    origin,
    tx: {
      ...(txReq.to !== undefined ? { to: txReq.to } : {}),
      value: txReq.value,
      data: txReq.data,
      gas: txReq.gas,
      gasPrice: txReq.maxFeePerGas,
      maxFeePerGas: txReq.maxFeePerGas,
      maxPriorityFeePerGas: txReq.maxPriorityFeePerGas,
      nonce: txReq.nonce,
      chainId: txReq.chainIdHex,
    },
    view: {
      executionUnitLimitHex: txReq.gas,
      pricePerExecutionUnitLythoshiHex: txReq.maxFeePerGas,
      nonce: txReq.nonce,
      simulation: null,
      chainId: chainIdHex,
      chainLabel,
    },
  };
}

// ---- Operator liveness cache ----
//
// Backs the popup's chain-status banner. We probe the published testnet
// operators in order and remember which one answered. The cache lives at
// module scope inside the service worker, so it survives across popup
// re-renders but resets when the worker hibernates — that's fine because
// hibernation is itself a "re-check liveness" signal.
//
// `name === null` means we probed and nothing answered. We still cache
// that result for the same TTL so the popup doesn't hammer dead nodes
// every render; the popup's own 10-second tick will retry once the TTL
// lapses.
const OPERATOR_CACHE_TTL_MS = 10_000;
// Shared between `wallet-operator-status` (popup chain-status banner) and
// `wallet-chain-block-number` (popup chain-health poll). Both want the same
// "first alive testnet operator" answer; caching name+rpc together avoids
// re-running the operator probe loop at the 8-second health-poll cadence.
let cachedOperator: {
  name: string | null;
  rpc: string | null;
  checkedAt: number;
} | null = null;

// Persist the last-good operator across SW hibernation. cachedOperator is
// in-memory, so every reopen after the worker idled out lost it and the first
// chain-block poll paid the full operator-probe RTT before the banner could go
// LIVE — that probe was the bulk of the "stuck on CONNECTING…" delay on reopen.
// chrome.storage.session is SW-scope, survives hibernation, and clears on
// browser restart — the right tier for a runtime liveness hint (never on disk).
const SESSION_KEY_LAST_OPERATOR = "mono.session.operator.v1";

/** Set cachedOperator and best-effort persist a usable result so the next SW
 *  boot can skip the probe. A null-rpc result ("no operator") is not seeded. */
function setCachedOperator(op: {
  name: string | null;
  rpc: string | null;
  checkedAt: number;
}): void {
  cachedOperator = op;
  if (op.rpc !== null) {
    void chrome.storage.session
      .set({ [SESSION_KEY_LAST_OPERATOR]: { name: op.name, rpc: op.rpc } })
      .catch(() => {});
  }
}

/** On boot, seed cachedOperator from the persisted hint as a STALE candidate
 *  (checkedAt: 0) — used only as an optimistic, self-validated fast path by the
 *  chain-block poll, never trusted as a fresh cache hit. No hint → first poll
 *  probes exactly as before. */
async function rehydrateCachedOperator(): Promise<void> {
  if (cachedOperator !== null) return; // a live probe already populated it
  try {
    const s = await chrome.storage.session.get(SESSION_KEY_LAST_OPERATOR);
    const hint = s?.[SESSION_KEY_LAST_OPERATOR] as
      | { name?: unknown; rpc?: unknown }
      | undefined;
    // Only seed a hint that is STILL in the active operator list. Otherwise a
    // since-removed operator (deleted from the override) whose server is still
    // alive would be polled and falsely show LIVE — never falling through to
    // the fresh probe that surfaces a quarantined / offline remaining fleet.
    if (
      hint &&
      typeof hint.rpc === "string" &&
      getActiveOperators().some((o) => o.rpc === hint.rpc)
    ) {
      cachedOperator = {
        name: typeof hint.name === "string" ? hint.name : null,
        rpc: hint.rpc,
        checkedAt: 0,
      };
    }
  } catch {
    // best-effort — no hint just means the first poll probes as before
  }
}

/** Read eth_blockNumber from one operator RPC (1.5 s budget). Extracted so the
 *  chain-block handler can try a cached/rehydrated operator first, then fall
 *  back to a freshly-probed one, without duplicating the fetch + error mapping. */
async function readChainBlock(
  rpc: string,
  operatorName: string | null,
): Promise<
  | { ok: true; blockHex: string; operator: string | null }
  | {
      ok: false;
      reason: string;
      cause: ReturnType<typeof classifyNoOperatorReason>;
    }
> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1_500);
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        ok: false,
        reason: `http ${res.status}`,
        cause: classifyNoOperatorReason(),
      };
    }
    const body = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (body.error) {
      // A -32047 "chain quarantined" from the active operator is named
      // distinctly so the banner can read "OPERATOR QUARANTINED" once no
      // healthy operator remains. A single quarantined op with a healthy
      // failover never surfaces it (the handler falls through to a fresh
      // probe — see the wallet-chain-block-number case).
      const quarantined = /quarantin/i.test(body.error.message ?? "");
      return {
        ok: false,
        reason: body.error.message ?? "rpc error",
        cause: quarantined ? "quarantined" : classifyNoOperatorReason(),
      };
    }
    if (typeof body.result !== "string") {
      return {
        ok: false,
        reason: "bad response",
        cause: classifyNoOperatorReason(),
      };
    }
    return { ok: true, blockHex: body.result, operator: operatorName };
  } catch (e) {
    return {
      ok: false,
      reason: (e as Error).message,
      cause: classifyNoOperatorReason(),
    };
  }
}

// ---- Passkey usage ledger (daily-cap mode) ----
//
// Per-vault list of compatibility-shaped `{ at, valueWei }` entries
// (lythoshi) for txs signed under the passkey-unlock path. Enforces the
// daily-cap mode of `PasskeyPolicy`.
//
// Persisted in chrome.storage.session (in-memory, SW-scope, cleared on
// browser restart — the same tier as the MEK, never on disk) rather than a
// plain module-level Map, so MV3 SW hibernation no longer silently resets
// the rolling daily window mid-session (#36). This is NOT a security
// invariant — the daily cap is a wallet-side spam guard — but persistence
// makes daily mode behave as users expect across the frequent SW restarts.
// NOTE: in DAILY mode the rolling sum is the ONLY control (daily mode
// applies no per-tx ceiling — see passkey.ts `evaluatePolicy`); the per-tx
// limit binds every tx only in per-tx mode. bigint doesn't survive the
// structured-clone boundary into chrome.storage reliably, so `valueWei` is
// stored as a decimal string and rehydrated to bigint.
const SESSION_KEY_PASSKEY_USAGE = "mono.session.passkey-usage.v1";
type PasskeyUsageWire = Record<string, { at: number; valueWei: string }[]>;

async function readPasskeyUsageWire(): Promise<PasskeyUsageWire> {
  try {
    const raw = await chrome.storage.session.get(SESSION_KEY_PASSKEY_USAGE);
    const stored = raw[SESSION_KEY_PASSKEY_USAGE];
    if (!stored || typeof stored !== "object") return {};
    return stored as PasskeyUsageWire;
  } catch {
    return {};
  }
}

/** Pruned (<24h) usage entries for a vault, decoded to bigint lythoshi.
 *  No-mock: a missing/malformed store yields an empty list, never a
 *  fabricated entry. */
async function readPasskeyUsageEntries(
  vaultId: string,
): Promise<{ at: number; valueWei: bigint }[]> {
  const wire = await readPasskeyUsageWire();
  const entries = wire[vaultId];
  if (!Array.isArray(entries)) return [];
  const cutoff = Date.now() - DAILY_CAP_WINDOW_MS;
  const out: { at: number; valueWei: bigint }[] = [];
  for (const e of entries) {
    if (!e || typeof e.at !== "number" || typeof e.valueWei !== "string") {
      continue;
    }
    if (e.at < cutoff) continue; // prune-on-read
    let v: bigint;
    try {
      v = BigInt(e.valueWei);
    } catch {
      continue;
    }
    out.push({ at: e.at, valueWei: v });
  }
  return out;
}

/** Append a usage entry for a vault and persist to session, pruning
 *  >24h entries so the stored blob stays bounded. Best-effort. */
async function recordPasskeyUsageEntry(
  vaultId: string,
  valueWei: bigint,
): Promise<void> {
  const wire = await readPasskeyUsageWire();
  const cutoff = Date.now() - DAILY_CAP_WINDOW_MS;
  const prior = Array.isArray(wire[vaultId]) ? wire[vaultId]! : [];
  const kept = prior.filter(
    (e) => e && typeof e.at === "number" && e.at >= cutoff,
  );
  kept.push({ at: Date.now(), valueWei: valueWei.toString() });
  wire[vaultId] = kept;
  try {
    await chrome.storage.session.set({ [SESSION_KEY_PASSKEY_USAGE]: wire });
  } catch {
    // session set best-effort.
  }
}

/**
 * Suggest `(maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas)` for a
 * given chain. On the testnet the values come from the native
 * `lyth_executionUnitPrice` RPC.
 *
 * For non-testnet chains we keep the compatibility read used by the
 * external-chain signing path.
 */
async function suggestFee(chainIdHex: string): Promise<{
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  baseFeePerGas: string;
  /** Hex execution-unit limit recommendation. the testnet has a known intrinsic
   * floor that `eth_estimateGas` doesn't reflect — surface the
   * pre-resolved value to the popup so the fee preview is accurate.
   * Other chains return null and let the caller estimate themselves. */
  gasLimit: string | null;
}> {
  if (chainRequiresMlDsa(chainIdHex)) {
    const quote = await testnetExecutionUnitPriceQuoteHex();
    return {
      baseFeePerGas: quote.basePriceHex,
      maxPriorityFeePerGas: quote.priorityTipHex,
      maxFeePerGas: quote.executionUnitPriceHex,
      gasLimit: TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX,
    };
  }
  const client = rpcClientFor(chainIdHex);
  const gasPriceHex = await rpcSend<string>(client, "eth_gasPrice", []);
  return {
    baseFeePerGas: gasPriceHex,
    maxPriorityFeePerGas: gasPriceHex,
    maxFeePerGas: gasPriceHex,
    gasLimit: null,
  };
}

/**
 * SDK 0.3.11 sane-fee invariant: the priority tip must never exceed the
 * max execution-unit price (`priority_tip <= max_execution_unit_price`).
 * A tip above the ceiling is meaningless — the chain re-clamps it, which
 * would desync the fee the wallet displays from the fee actually paid.
 * Clamp at the wallet boundary so the two agree. Both inputs are
 * `0x`-prefixed hex quantities; the smaller is returned verbatim so we
 * never widen the user's intended ceiling.
 */
function clampPriorityTipToMaxFee(
  priorityTipHex: string,
  maxFeeHex: string,
): string {
  try {
    const tip = BigInt(priorityTipHex);
    const cap = BigInt(maxFeeHex);
    return tip > cap ? maxFeeHex : priorityTipHex;
  } catch {
    // Non-hex input shouldn't reach here (suggestFee returns hex), but if
    // it does, fall back to the unmodified tip rather than throwing on the
    // hot send path.
    return priorityTipHex;
  }
}

/**
 * T4-04 (Item D, a1) — clamp an MRV submit-tx's execution-unit price to the
 * sane ceiling (and re-clamp the tip to the capped max) before it is signed.
 * The MRV plan-based paths (`monolythium_submitMrvNativePlan`,
 * `wallet-mrv-submit-plan`) carry a caller-supplied / operator-influenced fee
 * that does NOT pass through the `wallet-send-tx` clamp (8734) or the
 * `eth_sendTransaction` clamp (1616), so this applies the same de-trust
 * backstop. In-bound fees are returned unchanged; the bind (display == signed)
 * is preserved by clamping the approval-side and submit-side tx identically.
 */
function clampMrvSubmitTxFee(
  txReq: ReturnType<typeof walletMrvNativePlanToSubmitTx>,
): ReturnType<typeof walletMrvNativePlanToSubmitTx> {
  const clampedMaxFee =
    "0x" +
    clampToSaneBound(
      BigInt(txReq.maxFeePerGas),
      MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
    ).toString(16);
  return {
    ...txReq,
    maxFeePerGas: clampedMaxFee,
    maxPriorityFeePerGas: clampPriorityTipToMaxFee(
      txReq.maxPriorityFeePerGas,
      clampedMaxFee,
    ),
  };
}

// ---- Passkey IPC marshalling ----
//
// `bigint` does not survive `chrome.runtime.sendMessage` — the
// structured-clone algorithm preserves it in DOM contexts but the
// extension messaging layer JSON-serialises payloads. Encode every
// lythoshi value as a decimal string on the wire; parse back on receive.

interface SerializedPasskeyPolicy {
  enabled: boolean;
  mode: "per-tx" | "daily";
  limitWei: string;
  dailyCapWei: string;
}

interface SerializedPasskeyState {
  credentials: PasskeyCredential[];
  policy: SerializedPasskeyPolicy;
}

function serializePasskeyState(s: {
  credentials: PasskeyCredential[];
  policy: PasskeyPolicy;
}): SerializedPasskeyState {
  // Defensive against a degraded in-memory shape.
  // BigInt fields can be `undefined` if the policy was loaded from
  // chrome.storage on a Chrome version that didn't preserve bigints
  // (the durable fix lives in keystore-mldsa.ts; this is a belt-and-
  // braces second line of defence so a bad value never crashes the
  // IPC response with "Cannot read properties of undefined (reading
  // 'toString')"). Falls back to the default policy limits when a
  // field can't be coerced.
  const policy = s?.policy ?? {};
  const safeLimit = bigintFieldToString(
    (policy as PasskeyPolicy).limitWei,
    DEFAULT_PASSKEY_LIMIT_LYTHOSHI.toString(),
  );
  const safeDaily = bigintFieldToString(
    (policy as PasskeyPolicy).dailyCapWei,
    DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI.toString(),
  );
  return {
    credentials: Array.isArray(s?.credentials)
      ? s.credentials.map((c) => ({ ...c }))
      : [],
    policy: {
      enabled:
        typeof (policy as PasskeyPolicy).enabled === "boolean"
          ? (policy as PasskeyPolicy).enabled
          : false,
      mode:
        (policy as PasskeyPolicy).mode === "daily" ? "daily" : "per-tx",
      limitWei: safeLimit,
      dailyCapWei: safeDaily,
    },
  };
}

/** Coerce a possibly-undefined / possibly-non-bigint policy field
 *  into the decimal-string wire format. Tolerates bigint (the in-
 *  memory case), string (the on-disk case after the hotfix), and
 *  number (defensive). Falls back to the supplied decimal string
 *  on anything else. */
function bigintFieldToString(v: unknown, fallback: string): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && v.length > 0) {
    try {
      // round-trip through BigInt to make sure the wire value parses
      // cleanly on the popup side.
      return BigInt(v).toString();
    } catch {
      return fallback;
    }
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    try {
      return BigInt(Math.floor(v)).toString();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parsePasskeyCredential(raw: unknown): PasskeyCredential | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.credentialId !== "string" || r.credentialId.length === 0) return null;
  if (typeof r.name !== "string") return null;
  if (r.kind !== "platform" && r.kind !== "cross-platform") return null;
  if (typeof r.createdAt !== "number") return null;
  return {
    credentialId: r.credentialId,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
  };
}

function parsePasskeyPolicy(raw: unknown): PasskeyPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  if (r.mode !== "per-tx" && r.mode !== "daily") return null;
  if (typeof r.limitWei !== "string" || typeof r.dailyCapWei !== "string") return null;
  let limitWei: bigint;
  let dailyCapWei: bigint;
  try {
    limitWei = BigInt(r.limitWei);
    dailyCapWei = BigInt(r.dailyCapWei);
  } catch {
    return null;
  }
  return { enabled: r.enabled, mode: r.mode, limitWei, dailyCapWei };
}

const MRV_RECEIPTS_ROOT_DOMAIN = "monolythium/v2/receipts_root/1";
const MRV_RECEIPTS_ROOT_DOMAIN_BYTES = new TextEncoder().encode(
  MRV_RECEIPTS_ROOT_DOMAIN,
);
const MRV_COMPACT_RECEIPT_LEAF_DOMAIN_BYTES = new TextEncoder().encode(
  "monolythium/v4.1/receipt_leaf/1",
);
const MRV_COMPACT_RECEIPT_NODE_DOMAIN_BYTES = new TextEncoder().encode(
  "monolythium/v4.1/receipt_node/1",
);
const MAX_U32 = 0xffff_ffff;
const MRV_NO_EVM_RECEIPT_TRUST_REGISTRY_NETWORK = "testnet-69420";
const MRV_ROUND_CERTIFICATE_SOURCE = "roundCertificate";
const MRV_LEGACY_ROUND_CERTIFICATE_SOURCE = "blsRoundCertificate";

function parseMrvNativeReceiptEvidence(
  raw: unknown,
  finalityTrust: WalletMrvNoEvmFinalityTrustResolution,
  archiveTrust: WalletMrvNoEvmArchiveTrustResolution,
): WalletMrvNativeReceiptEvidence | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const noEvmProofRaw = r.noEvmProof;
  const noEvmProof =
    noEvmProofRaw === null || noEvmProofRaw === undefined
      ? null
      : parseMrvNoEvmReceiptProofTranscript(noEvmProofRaw);
  if (
    noEvmProofRaw !== null &&
    noEvmProofRaw !== undefined &&
    noEvmProof === null
  ) {
    return null;
  }
  const noEvmProofVerification =
    noEvmProof === null ? null : verifyMrvNoEvmReceiptProofTranscript(noEvmProof);
  const noEvmArchiveVerification =
    noEvmProof === null
      ? null
      : verifyMrvNoEvmArchiveProofSignatures(
          noEvmProof.archiveProof,
          archiveTrust,
          noEvmProof.blockHeight,
        );
  const noEvmFinalityVerification =
    noEvmProof === null
      ? null
      : verifyMrvNoEvmFinalityEvidence(
          noEvmProof.finalityEvidence,
          finalityTrust,
        );
  return {
    schema: typeof r.schema === "string" ? r.schema : null,
    txType: typeof r.txType === "number" ? r.txType : null,
    artifactHash: typeof r.artifactHash === "string" ? r.artifactHash : null,
    receiptCommitment: parseMrvReceiptCommitment(r.receiptCommitment),
    eventCount: typeof r.eventCount === "number" ? r.eventCount : null,
    noEvmProof,
    noEvmProofStatus:
      noEvmProofVerification === null
        ? "missing"
        : noEvmProofVerification.status === "verified"
          ? noEvmProof?.proofKind === "compactInclusion"
            ? "proof-verified"
            : "transcript-verified"
          : noEvmProof?.proofKind === "compactInclusion"
            ? "proof-mismatch"
            : "transcript-mismatch",
    noEvmProofVerification,
    noEvmArchiveVerification,
    noEvmFinalityVerification,
  };
}

function parseMrvReceiptCommitment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : null;
}

function parseMrvNoEvmReceiptProofTranscript(
  raw: unknown,
): WalletMrvNoEvmReceiptProofTranscript | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== "mono.no_evm_receipt_proof.v1") return null;
  const proofKindRaw = r.proofKind ?? "boundedCacheTranscript";
  if (
    proofKindRaw !== "boundedCacheTranscript" &&
    proofKindRaw !== "compactInclusion"
  ) {
    return null;
  }

  const rootAlgorithm = parseNonEmptyString(r.rootAlgorithm);
  const receiptCodec = parseNonEmptyString(r.receiptCodec);
  const blockHash = parseMrvReceiptHash(r.blockHash);
  const txHash = parseMrvReceiptHash(r.txHash);
  const receiptsRoot = parseMrvReceiptHash(r.receiptsRoot);
  const targetReceiptHash = parseMrvReceiptHash(r.targetReceiptHash);
  const blockHeight = parseNonNegativeSafeInteger(r.blockHeight);
  const txIndex = parseNonNegativeU32(r.txIndex);
  const receiptCount = parsePositiveU32(r.receiptCount);
  const missingProofMaterial = parseOptionalStringArray(r.missingProofMaterial);
  const finalityEvidence =
    r.finalityEvidence === null || r.finalityEvidence === undefined
      ? null
      : parseMrvFinalityEvidence(r.finalityEvidence);

  if (
    rootAlgorithm === null ||
    receiptCodec === null ||
    blockHash === null ||
    txHash === null ||
    receiptsRoot === null ||
    targetReceiptHash === null ||
    blockHeight === null ||
    txIndex === null ||
    receiptCount === null ||
    missingProofMaterial === null ||
    (finalityEvidence === null &&
      r.finalityEvidence !== null &&
      r.finalityEvidence !== undefined) ||
    txIndex >= receiptCount
  ) {
    return null;
  }

  if (proofKindRaw === "boundedCacheTranscript") {
    if (r.proofType !== "canonicalReceiptsTranscript") return null;
    const historySource = parseMrvNoEvmBoundedHistorySource(r.historySource);
    const receiptTranscript = parseMrvReceiptTranscript(r.receiptTranscript);
    if (
      historySource === null ||
      receiptTranscript === null ||
      receiptTranscript.length !== receiptCount ||
      r.compactInclusionProof !== null && r.compactInclusionProof !== undefined
    ) {
      return null;
    }

    return {
      schema: "mono.no_evm_receipt_proof.v1",
      proofKind: "boundedCacheTranscript",
      proofType: "canonicalReceiptsTranscript",
      historySource,
      compactInclusionProof: null,
      archiveProof: null,
      finalityEvidence,
      missingProofMaterial,
      rootAlgorithm,
      receiptCodec,
      blockHash,
      txHash,
      receiptsRoot,
      targetReceiptHash,
      blockHeight,
      txIndex,
      receiptCount,
      receiptTranscript,
      targetReceiptBytes: null,
    };
  }

  if (r.proofType !== "canonicalReceiptInclusion") return null;
  const historySource = parseMrvNoEvmCompactHistorySource(r.historySource);
  const compactInclusionProof = parseMrvCompactInclusionProof(
    r.compactInclusionProof,
  );
  const archiveProof =
    r.archiveProof === null || r.archiveProof === undefined
      ? null
      : parseMrvArchiveProof(r.archiveProof, blockHeight);
  const targetReceiptBytes = parseMrvReceiptBytesHex(r.targetReceiptBytes);
  const receiptTranscript = parseOptionalMrvReceiptTranscript(r.receiptTranscript);
  if (
    historySource === null ||
    compactInclusionProof === null ||
    (archiveProof === null &&
      r.archiveProof !== null &&
      r.archiveProof !== undefined) ||
    targetReceiptBytes === null ||
    receiptTranscript === null
  ) {
    return null;
  }

  return {
    schema: "mono.no_evm_receipt_proof.v1",
    proofKind: "compactInclusion",
    proofType: "canonicalReceiptInclusion",
    historySource,
    compactInclusionProof,
    archiveProof,
    finalityEvidence,
    missingProofMaterial,
    rootAlgorithm,
    receiptCodec,
    blockHash,
    txHash,
    receiptsRoot,
    targetReceiptHash,
    blockHeight,
    txIndex,
    receiptCount,
    receiptTranscript,
    targetReceiptBytes,
  };
}

function parseNonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function parseNonNegativeSafeInteger(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : null;
}

function parseNonNegativeU32(raw: unknown): number | null {
  const value = parseNonNegativeSafeInteger(raw);
  return value !== null && value <= MAX_U32 ? value : null;
}

function parsePositiveU32(raw: unknown): number | null {
  const value = parseNonNegativeU32(raw);
  return value !== null && value > 0 ? value : null;
}

function parseMrvReceiptHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : null;
}

function parseMrvReceiptTranscript(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const transcript: string[] = [];
  for (const entry of raw) {
    const parsed = parseMrvReceiptBytesHex(entry);
    if (parsed === null) return null;
    transcript.push(parsed);
  }
  return transcript;
}

function parseOptionalMrvReceiptTranscript(raw: unknown): string[] | null {
  return raw === null || raw === undefined ? [] : parseMrvReceiptTranscript(raw);
}

function parseMrvReceiptBytesHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(raw) ? raw : null;
}

function parseOptionalStringArray(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return null;
    values.push(value);
  }
  return values;
}

function parseMrvNoEvmBoundedHistorySource(
  raw: unknown,
): WalletMrvNoEvmBoundedReceiptProofTranscript["historySource"] | null {
  if (raw === null || raw === undefined) return "legacyUnspecified";
  return raw === "legacyUnspecified" || raw === "liveBlockCache" ? raw : null;
}

function parseMrvNoEvmCompactHistorySource(
  raw: unknown,
): WalletMrvNoEvmCompactReceiptProofTranscript["historySource"] | null {
  return raw === "liveBlockCache" || raw === "indexerReceiptArchive"
    ? raw
    : null;
}

function parseMrvCompactInclusionProof(
  raw: unknown,
): WalletMrvNoEvmCompactInclusionProof | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== "mono.no_evm_receipt_compact_inclusion.v1") return null;
  if (r.treeAlgorithm !== "binary-keccak-receipt-tree") return null;
  const root = parseMrvReceiptHash(r.root);
  const leafHash = parseMrvReceiptHash(r.leafHash);
  const siblingHashes = parseMrvHashArray(r.siblingHashes);
  const pathSides = parseBooleanArray(r.pathSides);
  if (
    root === null ||
    leafHash === null ||
    siblingHashes === null ||
    pathSides === null ||
    siblingHashes.length !== pathSides.length
  ) {
    return null;
  }
  return {
    schema: "mono.no_evm_receipt_compact_inclusion.v1",
    treeAlgorithm: "binary-keccak-receipt-tree",
    root,
    leafHash,
    siblingHashes,
    pathSides,
  };
}

function parseMrvArchiveProof(
  raw: unknown,
  blockHeight: number,
): WalletMrvNoEvmArchiveProof | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== "mono.no_evm_receipt_archive_binding.v1") return null;
  if (r.source !== "indexerReceiptArchiveContentDigest") return null;
  const manifestHash = parseMrvReceiptHash(r.manifestHash);
  const contentHash = parseMrvReceiptHash(r.contentHash);
  const signatureDigest =
    r.signatureDigest === null || r.signatureDigest === undefined
      ? undefined
      : parseMrvReceiptHash(r.signatureDigest);
  const signatures = parseMrvArchiveProofSignatures(r.signatures);
  const coveringSnapshot =
    r.coveringSnapshot === null || r.coveringSnapshot === undefined
      ? undefined
      : parseMrvArchiveCoveringSnapshot(
          r.coveringSnapshot,
          contentHash,
          blockHeight,
        );
  if (
    manifestHash === null ||
    contentHash === null ||
    signatureDigest === null ||
    signatures === null ||
    coveringSnapshot === null
  ) {
    return null;
  }
  return {
    schema: "mono.no_evm_receipt_archive_binding.v1",
    source: "indexerReceiptArchiveContentDigest",
    manifestHash,
    contentHash,
    ...(signatureDigest === undefined ? {} : { signatureDigest }),
    signatures,
    ...(coveringSnapshot === undefined ? {} : { coveringSnapshot }),
  };
}

function parseMrvArchiveCoveringSnapshot(
  raw: unknown,
  archiveContentHash: string | null,
  blockHeight: number,
): WalletMrvNoEvmArchiveCoveringSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const snapshotHeight = parseNonNegativeSafeInteger(r.snapshotHeight);
  const manifestHash = parseMrvReceiptHash(r.manifestHash);
  const signatureDigest = parseMrvReceiptHash(r.signatureDigest);
  const contentHash = parseMrvReceiptHash(r.contentHash);
  const checkpointContentHash = parseMrvReceiptHash(r.checkpointContentHash);
  const checkpointFrom = parseNonNegativeSafeInteger(r.checkpointFrom);
  const checkpointTo = parseNonNegativeSafeInteger(r.checkpointTo);
  const signatures = parseMrvArchiveProofSignatures(r.signatures);
  if (
    snapshotHeight === null ||
    manifestHash === null ||
    signatureDigest === null ||
    contentHash === null ||
    checkpointContentHash === null ||
    checkpointFrom === null ||
    checkpointTo === null ||
    signatures === null ||
    signatures.length === 0 ||
    checkpointFrom !== 0 ||
    checkpointTo > snapshotHeight ||
    checkpointTo !== blockHeight ||
    archiveContentHash === null ||
    !sameMrvHash(checkpointContentHash, archiveContentHash)
  ) {
    return null;
  }
  return {
    snapshotHeight,
    manifestHash,
    signatureDigest,
    contentHash,
    checkpointContentHash,
    checkpointFrom,
    checkpointTo,
    signatures,
  };
}

function parseMrvArchiveProofSignatures(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const signatures: string[] = [];
  for (const signature of raw) {
    if (typeof signature !== "string") return null;
    if (!/^mono\.snapshot\.sig\.v1:0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]+$/.test(signature)) {
      return null;
    }
    signatures.push(signature);
  }
  return signatures;
}

function parseMrvFinalityEvidence(
  raw: unknown,
): WalletMrvNoEvmFinalityEvidence | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== "mono.no_evm_receipt_finality.v1") return null;
  if (
    r.source !== MRV_ROUND_CERTIFICATE_SOURCE &&
    r.source !== MRV_LEGACY_ROUND_CERTIFICATE_SOURCE
  ) {
    return null;
  }
  const round = parseNonNegativeSafeInteger(r.round);
  const certificate = parseMrvFinalityCertificate(r.certificate);
  if (round === null || certificate === null || certificate.round !== round) {
    return null;
  }
  return {
    schema: "mono.no_evm_receipt_finality.v1",
    source: MRV_ROUND_CERTIFICATE_SOURCE,
    round,
    certificate,
  };
}

function parseMrvFinalityCertificate(
  raw: unknown,
): WalletMrvNoEvmFinalityCertificate | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const round = parseNonNegativeSafeInteger(r.round);
  const signature = parseMrvReceiptBytesHex(r.signature);
  const signersBitmap = parseMrvReceiptBytesHex(r.signersBitmap);
  const signerIndices = parseMrvSignerIndices(r.signerIndices);
  const signerCount = parseNonNegativeU32(r.signerCount);
  if (
    round === null ||
    signature === null ||
    signersBitmap === null ||
    signerIndices === null ||
    signerCount === null ||
    signerCount !== signerIndices.length
  ) {
    return null;
  }
  return {
    round,
    signature,
    signersBitmap,
    signerIndices,
    signerCount,
  };
}

function parseMrvSignerIndices(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const indices: number[] = [];
  for (const entry of raw) {
    const index = parseNonNegativeU32(entry);
    if (index === null) return null;
    indices.push(index);
  }
  return indices;
}

function parseMrvHashArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const hashes: string[] = [];
  for (const entry of raw) {
    const hash = parseMrvReceiptHash(entry);
    if (hash === null) return null;
    hashes.push(hash);
  }
  return hashes;
}

function parseBooleanArray(raw: unknown): boolean[] | null {
  if (!Array.isArray(raw)) return null;
  const values: boolean[] = [];
  for (const entry of raw) {
    if (typeof entry !== "boolean") return null;
    values.push(entry);
  }
  return values;
}

function resolveMrvNoEvmFinalityTrustConfig(
  raw: unknown,
  requestChainIdHex: string,
  readRegistryTrust: () => WalletMrvNoEvmRegistryTrustPolicyResolution,
): WalletMrvNoEvmFinalityTrustResolution {
  if (raw !== undefined) {
    return raw === null
      ? { kind: "none" }
      : parseMrvNoEvmFinalityTrustConfig(raw, requestChainIdHex, "caller");
  }

  const envRaw = readMrvNoEvmFinalityTrustEnv();
  if (envRaw !== null) {
    return parseMrvNoEvmFinalityTrustConfig(
      envRaw,
      requestChainIdHex,
      "environment",
    );
  }
  return resolveMrvNoEvmRegistryFinalityTrustConfig(
    readRegistryTrust(),
    requestChainIdHex,
  );
}

function readMrvNoEvmFinalityTrustEnv(): WalletMrvNoEvmFinalityTrustConfig | null {
  const chainIdHex = readMrvEnvString([
    "VITE_WALLET_MRV_FINALITY_CHAIN_ID_HEX",
    "VITE_MONO_MRV_FINALITY_CHAIN_ID_HEX",
  ]);
  const clusterPublicKey = readMrvEnvString([
    "VITE_WALLET_MRV_FINALITY_CLUSTER_PUBLIC_KEY",
    "VITE_MONO_MRV_FINALITY_CLUSTER_PUBLIC_KEY",
  ]);
  const committeeSize = readMrvEnvString([
    "VITE_WALLET_MRV_FINALITY_COMMITTEE_SIZE",
    "VITE_MONO_MRV_FINALITY_COMMITTEE_SIZE",
  ]);
  const threshold = readMrvEnvString([
    "VITE_WALLET_MRV_FINALITY_THRESHOLD",
    "VITE_MONO_MRV_FINALITY_THRESHOLD",
  ]);

  if (
    chainIdHex === undefined &&
    clusterPublicKey === undefined &&
    committeeSize === undefined &&
    threshold === undefined
  ) {
    return null;
  }

  return {
    chainIdHex: chainIdHex ?? "",
    clusterPublicKey: clusterPublicKey ?? "",
    committeeSize: committeeSize === undefined ? Number.NaN : Number(committeeSize),
    threshold: threshold === undefined ? Number.NaN : Number(threshold),
  };
}

function resolveMrvNoEvmArchiveTrustConfig(
  requestChainIdHex: string,
  readRegistryTrust: () => WalletMrvNoEvmRegistryTrustPolicyResolution,
): WalletMrvNoEvmArchiveTrustResolution {
  const envRaw = readMrvNoEvmArchiveTrustEnv();
  if (envRaw === null) {
    return resolveMrvNoEvmRegistryArchiveTrustConfig(
      readRegistryTrust(),
      requestChainIdHex,
    );
  }
  return parseMrvNoEvmArchiveTrustConfig(envRaw, "environment");
}

function readMrvNoEvmArchiveTrustEnv(): WalletMrvNoEvmArchiveTrustConfig | null {
  const trustedPublicKeysRaw = readMrvEnvString([
    "VITE_WALLET_MRV_ARCHIVE_TRUSTED_PUBKEYS",
    "VITE_MONO_MRV_ARCHIVE_TRUSTED_PUBKEYS",
  ]);
  const threshold = readMrvEnvString([
    "VITE_WALLET_MRV_ARCHIVE_SIGNATURE_THRESHOLD",
    "VITE_MONO_MRV_ARCHIVE_SIGNATURE_THRESHOLD",
  ]);

  if (trustedPublicKeysRaw === undefined && threshold === undefined) {
    return null;
  }

  return {
    trustedPublicKeys:
      trustedPublicKeysRaw === undefined
        ? []
        : trustedPublicKeysRaw
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
    threshold: threshold === undefined ? Number.NaN : Number(threshold),
  };
}

function resolveMrvNoEvmRegistryReceiptTrustPolicy(
  requestChainIdHex: string,
): WalletMrvNoEvmRegistryTrustPolicyResolution {
  const requestChainId = parseMrvChainIdBigInt(requestChainIdHex);
  if (requestChainId === null) {
    return { kind: "invalid", reason: "receipt request chain id is malformed" };
  }
  if (requestChainId !== MONOLYTHIUM_TESTNET_CHAIN_ID) return { kind: "none" };

  try {
    const policy = getNoEvmReceiptTrustPolicy(
      MRV_NO_EVM_RECEIPT_TRUST_REGISTRY_NETWORK,
    );
    return policy === null ? { kind: "none" } : { kind: "policy", policy };
  } catch (e) {
    return {
      kind: "invalid",
      reason: `registry no-EVM receipt trust policy failed to load: ${mrvErrorMessage(e)}`,
    };
  }
}

function resolveMrvNoEvmRegistryFinalityTrustConfig(
  registryTrust: WalletMrvNoEvmRegistryTrustPolicyResolution,
  requestChainIdHex: string,
): WalletMrvNoEvmFinalityTrustResolution {
  if (registryTrust.kind === "none") return { kind: "none" };
  if (registryTrust.kind === "invalid") {
    return { kind: "invalid", reason: registryTrust.reason };
  }

  const finality = registryTrust.policy.finality;
  if (finality === undefined) return { kind: "none" };
  if (finality.mode === "multisig") {
    return {
      kind: "invalid",
      reason:
        "registry round-finality trust mode multisig is not supported by browser wallet threshold-cluster verification",
    };
  }

  const chainId = parseMrvRegistryPolicyChainId(
    finality.chainId ?? registryTrust.policy.chainId,
  );
  if (chainId === null) {
    return {
      kind: "invalid",
      reason: "registry round-finality trust policy is missing chainId",
    };
  }
  const requestChainId = parseMrvChainIdBigInt(requestChainIdHex);
  if (requestChainId === null) {
    return { kind: "invalid", reason: "receipt request chain id is malformed" };
  }
  if (chainId !== requestChainId) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality chain id does not match the receipt request chain id",
    };
  }

  const committeeSize = parsePositiveSafeIntegerValue(finality.committeeSize);
  if (committeeSize === null) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality trust policy has invalid committeeSize",
    };
  }
  const threshold = parsePositiveSafeIntegerValue(finality.threshold);
  if (threshold === null) {
    return {
      kind: "invalid",
      reason: "registry round-finality trust policy has invalid threshold",
    };
  }
  if (threshold > committeeSize) {
    return {
      kind: "invalid",
      reason: "registry round-finality threshold exceeds committee size",
    };
  }

  const clusterPublicKey = parseMrvTrustPolicyBytes(
    finality.clusterPublicKey,
    48,
  );
  if (clusterPublicKey === null) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality clusterPublicKey must be 48 bytes",
    };
  }

  const validFromRound = parseMrvOptionalTrustPolicyBound(
    finality.validFromRound,
  );
  if (validFromRound === null) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality trust policy has invalid validFromRound",
    };
  }
  const validToRound = parseMrvOptionalTrustPolicyBound(finality.validToRound);
  if (validToRound === null) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality trust policy has invalid validToRound",
    };
  }
  if (
    validFromRound !== undefined &&
    validToRound !== undefined &&
    validFromRound > validToRound
  ) {
    return {
      kind: "invalid",
      reason:
        "registry round-finality trust policy validFromRound exceeds validToRound",
    };
  }

  const config: ResolvedMrvNoEvmFinalityTrustConfig = {
    chainId,
    clusterPublicKey,
    committeeSize,
    threshold,
  };
  if (validFromRound !== undefined) config.validFromRound = validFromRound;
  if (validToRound !== undefined) config.validToRound = validToRound;
  return { kind: "configured", config };
}

function resolveMrvNoEvmRegistryArchiveTrustConfig(
  registryTrust: WalletMrvNoEvmRegistryTrustPolicyResolution,
  requestChainIdHex: string,
): WalletMrvNoEvmArchiveTrustResolution {
  if (registryTrust.kind === "none") return { kind: "none" };
  if (registryTrust.kind === "invalid") {
    return { kind: "invalid", reason: registryTrust.reason };
  }

  const archive = registryTrust.policy.archive;
  if (archive === undefined) return { kind: "none" };

  const chainId = parseMrvRegistryPolicyChainId(registryTrust.policy.chainId);
  if (chainId === null) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy is missing chainId",
    };
  }
  const requestChainId = parseMrvChainIdBigInt(requestChainIdHex);
  if (requestChainId === null) {
    return { kind: "invalid", reason: "receipt request chain id is malformed" };
  }
  if (chainId !== requestChainId) {
    return {
      kind: "invalid",
      reason:
        "registry archive trust policy chain id does not match the receipt request chain id",
    };
  }

  const threshold = parsePositiveSafeIntegerValue(archive.threshold);
  if (threshold === null) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy has invalid threshold",
    };
  }
  if (!Array.isArray(archive.trustedSigners)) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy is missing trustedSigners",
    };
  }
  if (archive.trustedSigners.length === 0) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy is missing trustedSigners",
    };
  }
  if (threshold > archive.trustedSigners.length) {
    return {
      kind: "invalid",
      reason: "registry archive signature threshold exceeds trusted signer count",
    };
  }

  const validFromHeight = parseMrvOptionalTrustPolicyBound(
    archive.validFromHeight,
  );
  if (validFromHeight === null) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy has invalid validFromHeight",
    };
  }
  const validToHeight = parseMrvOptionalTrustPolicyBound(archive.validToHeight);
  if (validToHeight === null) {
    return {
      kind: "invalid",
      reason: "registry archive trust policy has invalid validToHeight",
    };
  }
  if (
    validFromHeight !== undefined &&
    validToHeight !== undefined &&
    validFromHeight > validToHeight
  ) {
    return {
      kind: "invalid",
      reason:
        "registry archive trust policy validFromHeight exceeds validToHeight",
    };
  }

  const trustedSigners: NoEvmArchiveTrustedSigner[] = [];
  for (let index = 0; index < archive.trustedSigners.length; index += 1) {
    const signer = archive.trustedSigners[index];
    if (signer === undefined) {
      return {
        kind: "invalid",
        reason: `registry archive trust policy has invalid trustedSigners[${index}]`,
      };
    }
    const publicKey = parseMrvTrustPolicyBytes(
      signer.publicKey,
      ML_DSA_65_PUBLIC_KEY_LEN,
    );
    if (publicKey === null) {
      return {
        kind: "invalid",
        reason: `registry archive trustedSigners[${index}].publicKey must be ${ML_DSA_65_PUBLIC_KEY_LEN} bytes`,
      };
    }
    const signerValidFromHeight = parseMrvOptionalTrustPolicyBound(
      signer.validFromHeight,
    );
    if (signerValidFromHeight === null) {
      return {
        kind: "invalid",
        reason: `registry archive trustedSigners[${index}] has invalid validFromHeight`,
      };
    }
    const signerValidToHeight = parseMrvOptionalTrustPolicyBound(
      signer.validToHeight,
    );
    if (signerValidToHeight === null) {
      return {
        kind: "invalid",
        reason: `registry archive trustedSigners[${index}] has invalid validToHeight`,
      };
    }
    if (
      signerValidFromHeight !== undefined &&
      signerValidToHeight !== undefined &&
      signerValidFromHeight > signerValidToHeight
    ) {
      return {
        kind: "invalid",
        reason: `registry archive trustedSigners[${index}] validFromHeight exceeds validToHeight`,
      };
    }

    const trustedSigner: NoEvmArchiveTrustedSigner = { publicKey };
    if (typeof signer.signerId === "string") {
      trustedSigner.signerId = signer.signerId;
    }
    if (signerValidFromHeight !== undefined) {
      trustedSigner.validFromHeight = signerValidFromHeight;
    }
    if (signerValidToHeight !== undefined) {
      trustedSigner.validToHeight = signerValidToHeight;
    }
    trustedSigners.push(trustedSigner);
  }

  const config: ResolvedMrvNoEvmArchiveTrustConfig = {
    trustedSigners,
    threshold,
  };
  if (validFromHeight !== undefined) config.validFromHeight = validFromHeight;
  if (validToHeight !== undefined) config.validToHeight = validToHeight;
  return { kind: "configured", config };
}

function readMrvEnvString(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = import.meta.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseMrvNoEvmFinalityTrustConfig(
  raw: unknown,
  requestChainIdHex: string,
  source: "caller" | "environment",
): WalletMrvNoEvmFinalityTrustResolution {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config must be an object`,
    };
  }
  const r = raw as Record<string, unknown>;
  const chainIdRaw = r.chainIdHex ?? r.chainId;
  const clusterPublicKeyRaw =
    r.clusterPublicKey ?? r.thresholdClusterPublicKey;
  const committeeSize = parsePositiveSafeIntegerValue(r.committeeSize);
  const threshold = parsePositiveSafeIntegerValue(r.threshold);
  if (typeof chainIdRaw !== "string" || chainIdRaw.length === 0) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config is missing chainIdHex`,
    };
  }
  if (typeof clusterPublicKeyRaw !== "string" || clusterPublicKeyRaw.length === 0) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config is missing clusterPublicKey`,
    };
  }
  if (committeeSize === null) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config has invalid committeeSize`,
    };
  }
  if (threshold === null) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config has invalid threshold`,
    };
  }
  if (threshold > committeeSize) {
    return {
      kind: "invalid",
      reason: `${source} round-finality threshold exceeds committee size`,
    };
  }

  const requestChainId = parseMrvChainIdBigInt(requestChainIdHex);
  const configuredChainId = parseMrvChainIdBigInt(chainIdRaw);
  if (requestChainId === null) {
    return {
      kind: "invalid",
      reason: "receipt request chain id is malformed",
    };
  }
  if (configuredChainId === null) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config has invalid chainIdHex`,
    };
  }
  if (configuredChainId !== requestChainId) {
    return {
      kind: "invalid",
      reason: `${source} round-finality chain id does not match the receipt request chain id`,
    };
  }

  const clusterPublicKeyHex = parseMrvReceiptBytesHex(clusterPublicKeyRaw);
  if (clusterPublicKeyHex === null) {
    return {
      kind: "invalid",
      reason: `${source} round-finality trust config has malformed clusterPublicKey`,
    };
  }
  const clusterPublicKey = hexToMrvReceiptBytes(clusterPublicKeyHex);
  if (clusterPublicKey.length !== 48) {
    return {
      kind: "invalid",
      reason: `${source} round-finality clusterPublicKey must be 48 bytes`,
    };
  }

  return {
    kind: "configured",
    config: {
      chainId: configuredChainId,
      clusterPublicKey,
      committeeSize,
      threshold,
    },
  };
}

function parseMrvNoEvmArchiveTrustConfig(
  raw: unknown,
  source: "environment",
): WalletMrvNoEvmArchiveTrustResolution {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "invalid",
      reason: `${source} archive trust config must be an object`,
    };
  }
  const r = raw as Record<string, unknown>;
  const trustedPublicKeysRaw =
    r.trustedPublicKeys ?? r.publicKeys ?? r.trustedPubkeys ?? r.pubkeys;
  const trustedPublicKeys = parseMrvArchiveTrustedPublicKeyList(
    trustedPublicKeysRaw,
  );
  const threshold = parsePositiveSafeIntegerValue(r.threshold);

  if (trustedPublicKeys === null || trustedPublicKeys.length === 0) {
    return {
      kind: "invalid",
      reason: `${source} archive trust config is missing trustedPublicKeys`,
    };
  }
  if (threshold === null) {
    return {
      kind: "invalid",
      reason: `${source} archive trust config has invalid threshold`,
    };
  }
  if (threshold > trustedPublicKeys.length) {
    return {
      kind: "invalid",
      reason: `${source} archive signature threshold exceeds trusted signer count`,
    };
  }

  const trustedSigners: NoEvmArchiveTrustedSigner[] = [];
  for (let index = 0; index < trustedPublicKeys.length; index += 1) {
    const publicKeyRaw = trustedPublicKeys[index];
    const publicKeyHex =
      publicKeyRaw === undefined ? null : parseMrvReceiptBytesHex(publicKeyRaw);
    if (publicKeyHex === null) {
      return {
        kind: "invalid",
        reason: `${source} archive trust config has malformed trustedPublicKeys[${index}]`,
      };
    }
    const publicKey = hexToMrvReceiptBytes(publicKeyHex);
    if (publicKey.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
      return {
        kind: "invalid",
        reason: `${source} archive trustedPublicKeys[${index}] must be ${ML_DSA_65_PUBLIC_KEY_LEN} bytes`,
      };
    }
    trustedSigners.push({ publicKey });
  }

  return {
    kind: "configured",
    config: { trustedSigners, threshold },
  };
}

function parseMrvArchiveTrustedPublicKeyList(raw: unknown): string[] | null {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  if (!Array.isArray(raw)) return null;
  const publicKeys: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length > 0) publicKeys.push(trimmed);
  }
  return publicKeys;
}

function parsePositiveSafeIntegerValue(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMrvRegistryPolicyChainId(raw: unknown): bigint | null {
  if (typeof raw === "bigint" && raw > 0n) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return BigInt(raw);
  }
  return null;
}

function parseMrvTrustPolicyBytes(
  raw: Uint8Array | readonly number[],
  expectedLength: number,
): Uint8Array | null {
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (Array.isArray(raw)) {
    bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      const value = raw[index];
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 0xff
      ) {
        return null;
      }
      bytes[index] = value;
    }
  } else {
    return null;
  }
  return bytes.length === expectedLength ? bytes : null;
}

function parseMrvOptionalTrustPolicyBound(raw: unknown): bigint | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw === "bigint" && raw >= 0n) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return BigInt(raw);
  }
  return null;
}

function mrvIsWithinOptionalTrustBounds(
  value: bigint,
  validFrom: number | bigint | undefined,
  validTo: number | bigint | undefined,
): boolean {
  if (validFrom !== undefined && value < BigInt(validFrom)) return false;
  if (validTo !== undefined && value > BigInt(validTo)) return false;
  return true;
}

function parseMrvChainIdBigInt(raw: string): bigint | null {
  try {
    if (/^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
    if (/^[0-9]+$/.test(raw)) return BigInt(raw);
    return null;
  } catch {
    return null;
  }
}

function verifyMrvNoEvmArchiveProofSignatures(
  archiveProof: WalletMrvNoEvmArchiveProof | null,
  archiveTrust: WalletMrvNoEvmArchiveTrustResolution,
  blockHeight: number,
): WalletMrvNoEvmArchiveVerification | null {
  if (archiveProof === null) return null;
  if (archiveTrust.kind === "none") {
    return {
      status: "unconfigured",
      reason: "trusted archive signer config not configured",
      details: null,
    };
  }
  if (archiveTrust.kind === "invalid") {
    return {
      status: "config-invalid",
      reason: archiveTrust.reason,
      details: null,
    };
  }

  const blockHeightBig = BigInt(blockHeight);
  if (
    !mrvIsWithinOptionalTrustBounds(
      blockHeightBig,
      archiveTrust.config.validFromHeight,
      archiveTrust.config.validToHeight,
    )
  ) {
    return {
      status: "mismatch",
      reason: `archive trust policy is not valid at block height ${blockHeight}`,
      details: null,
    };
  }

  try {
    const proofForVerification =
      archiveProofForSignatureVerification(archiveProof);
    const trustedSigners = archiveTrust.config.trustedSigners.filter((signer) =>
      mrvIsWithinOptionalTrustBounds(
        blockHeightBig,
        signer.validFromHeight,
        signer.validToHeight,
      ),
    );
    const details = verifyNoEvmArchiveProofSignatures(
      proofForVerification,
      trustedSigners,
      archiveTrust.config.threshold,
    );
    return {
      status: details.verified ? "verified" : "mismatch",
      reason: details.verified
        ? null
        : "archive proof signatures did not verify against configured trusted signers",
      details,
    };
  } catch (e) {
    return {
      status: "malformed",
      reason: `archive proof signature verification failed: ${mrvErrorMessage(e)}`,
      details: null,
    };
  }
}

function archiveProofForSignatureVerification(
  archiveProof: WalletMrvNoEvmArchiveProof,
): WalletMrvNoEvmArchiveProof {
  if (
    archiveProof.signatureDigest !== undefined ||
    archiveProof.signatures.length > 0 ||
    archiveProof.coveringSnapshot === undefined
  ) {
    return archiveProof;
  }
  return {
    ...archiveProof,
    signatureDigest: archiveProof.coveringSnapshot.signatureDigest,
    signatures: archiveProof.coveringSnapshot.signatures,
  };
}

function verifyMrvNoEvmFinalityEvidence(
  finalityEvidence: WalletMrvNoEvmFinalityEvidence | null,
  finalityTrust: WalletMrvNoEvmFinalityTrustResolution,
): WalletMrvNoEvmFinalityVerification | null {
  if (finalityEvidence === null) return null;
  if (finalityTrust.kind === "none") {
    return {
      status: "unverified",
      reason: "trusted round-finality config not configured",
      details: null,
    };
  }
  if (finalityTrust.kind === "invalid") {
    return {
      status: "mismatch",
      reason: finalityTrust.reason,
      details: null,
    };
  }

  if (
    !mrvIsWithinOptionalTrustBounds(
      BigInt(finalityEvidence.round),
      finalityTrust.config.validFromRound,
      finalityTrust.config.validToRound,
    )
  ) {
    return {
      status: "mismatch",
      reason: `round-finality trust policy is not valid at round ${finalityEvidence.round}`,
      details: null,
    };
  }

  try {
    const details = verifyNoEvmFinalityEvidenceThreshold(
      mrvFinalityEvidenceForCurrentSdk(finalityEvidence),
      {
        chainId: finalityTrust.config.chainId,
        clusterPublicKey: finalityTrust.config.clusterPublicKey,
        committeeSize: finalityTrust.config.committeeSize,
        threshold: finalityTrust.config.threshold,
      },
    );
    return {
      status: details.verified ? "verified" : "mismatch",
      reason: details.verified
        ? null
        : "round-finality evidence did not verify against configured trust inputs",
      details,
    };
  } catch (e) {
    return {
      status: "mismatch",
      reason: `round-finality verification failed: ${mrvErrorMessage(e)}`,
      details: null,
    };
  }
}

function mrvFinalityEvidenceForCurrentSdk(
  finalityEvidence: WalletMrvNoEvmFinalityEvidence,
): Parameters<typeof verifyNoEvmFinalityEvidenceThreshold>[0] {
  return {
    ...finalityEvidence,
    source: MRV_LEGACY_ROUND_CERTIFICATE_SOURCE,
  } as Parameters<typeof verifyNoEvmFinalityEvidenceThreshold>[0];
}

function mrvErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message.length > 0) return e.message;
  return typeof e === "string" && e.length > 0 ? e : "unknown error";
}

function verifyMrvNoEvmReceiptProofTranscript(
  proof: WalletMrvNoEvmReceiptProofTranscript,
): WalletMrvNoEvmReceiptProofVerification {
  if (proof.proofKind === "compactInclusion") {
    return verifyMrvNoEvmCompactReceiptProof(proof);
  }

  const receipts = proof.receiptTranscript.map(hexToMrvReceiptBytes);
  const targetReceipt = receipts[proof.txIndex] ?? new Uint8Array();
  const computedReceiptsRoot = computeMrvReceiptsRoot(receipts);
  const computedTargetReceiptHash = mrvKeccakHex(targetReceipt);
  const receiptCountMatches = proof.receiptCount === receipts.length;
  const receiptsRootMatches = sameMrvHash(
    proof.receiptsRoot,
    computedReceiptsRoot,
  );
  const targetReceiptHashMatches = sameMrvHash(
    proof.targetReceiptHash,
    computedTargetReceiptHash,
  );
  const status =
    receiptCountMatches && receiptsRootMatches && targetReceiptHashMatches
      ? "verified"
      : "mismatch";

  return {
    status,
    proofKind: "boundedCacheTranscript",
    receiptCountMatches,
    receiptsRootMatches,
    targetReceiptHashMatches,
    receiptCount: proof.receiptCount,
    transcriptCount: receipts.length,
    computedReceiptsRoot,
    computedTargetReceiptHash,
  };
}

function verifyMrvNoEvmCompactReceiptProof(
  proof: WalletMrvNoEvmCompactReceiptProofTranscript,
): WalletMrvNoEvmReceiptProofVerification {
  const targetReceipt = hexToMrvReceiptBytes(proof.targetReceiptBytes);
  const computedTargetReceiptHash = mrvKeccakHex(targetReceipt);
  const computedLeafHashBytes = computeMrvCompactReceiptLeafHashBytes(
    targetReceipt,
    proof.txIndex,
  );
  const computedCompactLeafHash = mrvHashBytesToHex(computedLeafHashBytes);
  let foldedRoot = computedLeafHashBytes;
  for (let index = 0; index < proof.compactInclusionProof.siblingHashes.length; index += 1) {
    const sibling = mrvHashHexToBytes(
      proof.compactInclusionProof.siblingHashes[index]!,
    );
    foldedRoot = proof.compactInclusionProof.pathSides[index]!
      ? computeMrvCompactReceiptNodeHashBytes(sibling, foldedRoot)
      : computeMrvCompactReceiptNodeHashBytes(foldedRoot, sibling);
  }
  const computedReceiptsRoot = mrvHashBytesToHex(foldedRoot);
  const receiptCountMatches = proof.receiptCount > proof.txIndex;
  const targetReceiptHashMatches = sameMrvHash(
    proof.targetReceiptHash,
    computedTargetReceiptHash,
  );
  const compactLeafHashMatches = sameMrvHash(
    proof.compactInclusionProof.leafHash,
    computedCompactLeafHash,
  );
  const compactPathMatches = sameMrvHash(
    proof.compactInclusionProof.root,
    computedReceiptsRoot,
  );
  const receiptsRootMatches =
    sameMrvHash(proof.receiptsRoot, proof.compactInclusionProof.root) &&
    sameMrvHash(proof.receiptsRoot, computedReceiptsRoot);
  const status =
    receiptCountMatches &&
    receiptsRootMatches &&
    targetReceiptHashMatches &&
    compactLeafHashMatches &&
    compactPathMatches
      ? "verified"
      : "mismatch";

  return {
    status,
    proofKind: "compactInclusion",
    receiptCountMatches,
    receiptsRootMatches,
    targetReceiptHashMatches,
    compactLeafHashMatches,
    compactPathMatches,
    receiptCount: proof.receiptCount,
    transcriptCount: proof.receiptTranscript.length,
    computedReceiptsRoot,
    computedTargetReceiptHash,
    computedCompactLeafHash,
  };
}

function computeMrvReceiptsRoot(receipts: Uint8Array[]): string {
  let totalLength = MRV_RECEIPTS_ROOT_DOMAIN_BYTES.length + 4;
  for (const receipt of receipts) {
    totalLength += 8 + receipt.length;
  }

  const payload = new Uint8Array(totalLength);
  let offset = 0;
  payload.set(MRV_RECEIPTS_ROOT_DOMAIN_BYTES, offset);
  offset += MRV_RECEIPTS_ROOT_DOMAIN_BYTES.length;
  writeU32Le(payload, offset, receipts.length);
  offset += 4;

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    writeU32Le(payload, offset, index);
    offset += 4;
    writeU32Le(payload, offset, receipt.length);
    offset += 4;
    payload.set(receipt, offset);
    offset += receipt.length;
  }

  return mrvKeccakHex(payload);
}

function computeMrvCompactReceiptLeafHashBytes(
  receipt: Uint8Array,
  txIndex: number,
): Uint8Array {
  const payload = new Uint8Array(
    MRV_COMPACT_RECEIPT_LEAF_DOMAIN_BYTES.length + 8 + receipt.length,
  );
  let offset = 0;
  payload.set(MRV_COMPACT_RECEIPT_LEAF_DOMAIN_BYTES, offset);
  offset += MRV_COMPACT_RECEIPT_LEAF_DOMAIN_BYTES.length;
  writeU32Le(payload, offset, txIndex);
  offset += 4;
  writeU32Le(payload, offset, receipt.length);
  offset += 4;
  payload.set(receipt, offset);
  return keccak_256(payload);
}

function computeMrvCompactReceiptNodeHashBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(
    MRV_COMPACT_RECEIPT_NODE_DOMAIN_BYTES.length + left.length + right.length,
  );
  let offset = 0;
  payload.set(MRV_COMPACT_RECEIPT_NODE_DOMAIN_BYTES, offset);
  offset += MRV_COMPACT_RECEIPT_NODE_DOMAIN_BYTES.length;
  payload.set(left, offset);
  offset += left.length;
  payload.set(right, offset);
  return keccak_256(payload);
}

function hexToMrvReceiptBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function writeU32Le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function mrvKeccakHex(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

function mrvHashHexToBytes(hex: string): Uint8Array {
  return hexToMrvReceiptBytes(hex);
}

function mrvHashBytesToHex(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

function sameMrvHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

// ---- internal popup messages ----

interface PopupMessage {
  kind: "popup";
  op: string;
  payload?: unknown;
}

interface SettledRpc<T> {
  value: T | null;
  error: string | null;
}

async function settleTestnetRpc<T>(method: string, params: unknown[]): Promise<SettledRpc<T>> {
  try {
    const { result } = await testnetJsonRpc<T>(method, params);
    return { value: result, error: null };
  } catch (e) {
    return { value: null, error: (e as Error).message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Indexer-snapshot helpers shared by `wallet-indexer-snapshot` and
// `wallet-activity-get`. The first preserves its v3 wire shape verbatim for
// existing consumers (`WalletAddressActivityRow` in popup/bg.ts:313-325);
// the second adds caching, dedupe, and reconciliation on top of the same
// fetch path.
// ──────────────────────────────────────────────────────────────────────────────

/** Cache-staleness threshold for `wallet-activity-get`. A cache fresher
 *  than this returns without hitting the indexer; older than this triggers
 *  a fetch + merge + persist cycle. */
const CACHE_STALENESS_MS = 30 * 1000;

interface IndexerSnapshotRaw {
  tokenBalances: WalletTokenBalance[];
  bridgeRouteDisclosures: WalletBridgeRouteDisclosure[];
  bridgeRouteReadiness: WalletBridgeRouteReadiness | null;
  mrcAccount: MrcAccountLookupResponse | null;
  nativeAgentState: NativeAgentStateResponse | null;
  addressLabel: unknown | null;
  delegationHistory: unknown[];
  addressActivity: unknown[];
  errors: Record<string, string>;
}

const MRC_HOLDER_LOOKUP_ROW_LIMIT = 4;
const MRC_HOLDER_LOOKUP_LIMIT = 3;
const MRC_ACCOUNT_SPEND_LOOKUP_LIMIT = 4;
const NATIVE_AGENT_STATE_LOOKUP_LIMIT = 10;

interface FetchIndexerSnapshotOptions {
  includeMrcAccount: boolean;
}

function readTokenBalanceRows(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const r = input as Record<string, unknown>;
  return Array.isArray(r.tokenBalances) ? r.tokenBalances : [];
}

interface MrcHolderLookup {
  standard: WalletMrcHolderStandard;
  assetId: string;
  tokenId: string | null;
  key: string;
}

function normalizeMrcHolderStandard(
  standard: string | undefined,
): WalletMrcHolderStandard | null {
  const normalized = standard?.toLowerCase().replace(/[-_]/g, "");
  if (
    normalized !== "mrc721" &&
    normalized !== "mrc1155" &&
    normalized !== "mrc4626"
  ) {
    return null;
  }
  return normalized;
}

function mrcHolderLookupForRow(row: WalletTokenBalance): MrcHolderLookup | null {
  const standard = normalizeMrcHolderStandard(row.mrc?.standard);
  const assetId = row.mrc?.assetId;
  if (!standard || !assetId) return null;
  if (standard === "mrc4626") {
    return {
      standard,
      assetId,
      tokenId: null,
      key: `${standard}:${assetId}:`,
    };
  }
  const tokenId = row.mrc?.tokenId;
  if (!tokenId) return null;
  return {
    standard,
    assetId,
    tokenId,
    key: `${standard}:${assetId}:${tokenId}`,
  };
}

function identityMatchesMrcHolders(
  lookup: MrcHolderLookup,
  response: WalletMrcHoldersResponse,
): boolean {
  return (
    response.standard === lookup.standard &&
    response.assetId === lookup.assetId &&
    response.tokenId === lookup.tokenId
  );
}

async function enrichMrcHolderRows(
  tokenBalances: WalletTokenBalance[],
): Promise<{ tokenBalances: WalletTokenBalance[]; error?: string }> {
  const lookups: MrcHolderLookup[] = [];
  const seen = new Set<string>();
  for (const row of tokenBalances) {
    const lookup = mrcHolderLookupForRow(row);
    if (lookup === null || seen.has(lookup.key)) continue;
    seen.add(lookup.key);
    lookups.push(lookup);
    if (lookups.length >= MRC_HOLDER_LOOKUP_ROW_LIMIT) break;
  }
  if (lookups.length === 0) return { tokenBalances };

  const holderRows = new Map<string, WalletMrcHoldersResponse>();
  const errors: string[] = [];
  await Promise.all(
    lookups.map(async (lookup) => {
      const response = await settleTestnetRpc<unknown>("lyth_mrcHolders", [
        lookup.standard,
        lookup.assetId,
        lookup.tokenId,
        MRC_HOLDER_LOOKUP_LIMIT,
      ]);
      if (response.error) {
        errors.push(response.error);
        return;
      }
      const holders = validateWalletMrcHoldersResponse(response.value);
      if (holders === null || !identityMatchesMrcHolders(lookup, holders)) {
        errors.push("malformed lyth_mrcHolders response");
        return;
      }
      holderRows.set(lookup.key, holders);
    }),
  );

  return {
    tokenBalances: tokenBalances.map((row) => {
      const lookup = mrcHolderLookupForRow(row);
      if (lookup === null) return row;
      const holders = holderRows.get(lookup.key);
      return holders ? { ...row, mrcHolders: holders } : row;
    }),
    ...(errors.length > 0 ? { error: errors[0] } : {}),
  };
}

function smartAccountLookupAddress(address: string): string | null {
  try {
    if (address.startsWith("0x") || address.startsWith("0X")) {
      return addressToTypedBech32("smartAccount", address);
    }
    return typedBech32ToAddress(address, "smartAccount").address;
  } catch {
    return null;
  }
}

async function readMrcAccountLookup(
  address: string,
): Promise<{ value: MrcAccountLookupResponse | null; error?: string }> {
  const lookupAccount = smartAccountLookupAddress(address);
  if (lookupAccount === null) {
    return { value: null, error: "invalid MRC account lookup address" };
  }
  const response = await settleTestnetRpc<unknown>("lyth_mrcAccount", [
    lookupAccount,
    MRC_ACCOUNT_SPEND_LOOKUP_LIMIT,
  ]);
  if (response.error) {
    return { value: null, error: response.error };
  }
  const mrcAccount = validateMrcAccountLookupResponse(response.value);
  if (
    mrcAccount === null ||
    mrcAccount.account.toLowerCase() !== lookupAccount.toLowerCase()
  ) {
    return { value: null, error: "malformed lyth_mrcAccount response" };
  }
  return { value: mrcAccount };
}

async function readNativeAgentStateLookup(
  address: string,
): Promise<{ value: NativeAgentStateResponse | null; error?: string }> {
  const outcome = await readNativeAgentState({
    account: address,
    includePolicySpends: true,
    limit: NATIVE_AGENT_STATE_LOOKUP_LIMIT,
  });
  if (outcome.kind === "live") {
    return { value: outcome.data };
  }
  if (outcome.kind === "mock-not-deployed") {
    return { value: null };
  }
  return {
    value: null,
    error: "reason" in outcome ? outcome.reason : "native agent state unavailable",
  };
}

/** Extract the row array from a `lyth_getAddressActivity` response, tolerating
 *  BOTH shapes during the v2 fleet migration: a legacy operator returns a bare
 *  array; a v2 operator wraps it in an envelope `{schemaVersion, …, nextCursor,
 *  activity:[…]}` (commit b676d221). A bare array passes through unchanged; the
 *  envelope yields `.activity`; anything else → `[]` — the same fail-safe the
 *  old `Array.isArray(...) ? ... : []` gave (an unrecognised shape was already
 *  treated as empty). first-page-only by design: `nextCursor`/`schemaVersion`
 *  are intentionally ignored — the wallet consumes only the newest `limit` rows
 *  and fills its render window by MERGING streams (delegation + pending +
 *  local-claims), not by paginating this one.
 *
 *  Also applied to `lyth_getDelegationHistory`, which is still a bare array
 *  today (only `getAddressActivity` was enveloped). On a bare array the helper
 *  is a pure no-op, so it harmlessly future-proofs that stream against a later
 *  envelope migration that follows the same `.activity` shape. */
function extractAddressActivity(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { activity?: unknown }).activity)
  ) {
    return (value as { activity: unknown[] }).activity;
  }
  return [];
}

/** Parallel-fetch the indexer streams used by popup-facing
 *  snapshots. Token balances are validated at the SW boundary because the
 *  popup renders them directly; other streams keep their existing raw shapes
 *  and are validated by the consumers that need typed rows. */
async function fetchIndexerSnapshot(
  address: string,
  _chainIdHex: string,
  options: FetchIndexerSnapshotOptions,
): Promise<IndexerSnapshotRaw> {
  // Chain validates wallet/address params strictly as bech32m
  // on every user-keyed lyth_* read (verified live:
  // lyth_getAddressActivity("0x...") -> -32602 wallet must be mono
  // bech32m). Convert once at the top of the snapshot fetch and reuse
  // for the 4 direct chain calls below. The helper calls
  // (readMrcAccountLookup / readNativeAgentStateLookup) do their own
  // address normalisation internally.
  const addressForChain = userAddressForNativeRpc(address);
  const [
    tokenBalances,
    bridgeRoutes,
    mrcAccount,
    nativeAgentState,
    addressLabel,
    delegationHistory,
    addressActivity,
  ] = await Promise.all([
    settleTestnetRpc<unknown>("lyth_getTokenBalances", [addressForChain]),
    readBridgeRoutes(),
    options.includeMrcAccount
      ? readMrcAccountLookup(address)
      : Promise.resolve<{ value: MrcAccountLookupResponse | null; error?: string }>({
          value: null,
        }),
    readNativeAgentStateLookup(address),
    settleTestnetRpc<unknown | null>("lyth_getAddressLabel", [addressForChain]),
    settleTestnetRpc<unknown>("lyth_getDelegationHistory", [addressForChain, 20]),
    settleTestnetRpc<unknown>("lyth_getAddressActivity", [addressForChain, 30]),
  ]);
  const errors: Record<string, string> = {};
  if (tokenBalances.error) errors.tokenBalances = tokenBalances.error;
  if (bridgeRoutes.kind !== "live" && "reason" in bridgeRoutes) {
    errors.bridgeRoutes = bridgeRoutes.reason;
  }
  if (mrcAccount.error) errors.mrcAccount = mrcAccount.error;
  if (nativeAgentState.error) errors.nativeAgentState = nativeAgentState.error;
  if (addressLabel.error) errors.addressLabel = addressLabel.error;
  if (delegationHistory.error) errors.delegationHistory = delegationHistory.error;
  if (addressActivity.error) errors.addressActivity = addressActivity.error;
  const rawTokenBalances = readTokenBalanceRows(tokenBalances.value);
  const mrcHolderEnrichment = await enrichMrcHolderRows(
    validateWalletTokenBalanceList(rawTokenBalances),
  );
  if (mrcHolderEnrichment.error) errors.mrcHolders = mrcHolderEnrichment.error;
  return {
    tokenBalances: mrcHolderEnrichment.tokenBalances,
    bridgeRouteDisclosures: dedupeWalletBridgeRouteDisclosures([
      ...bridgeRoutes.data.bridgeRouteDisclosures,
      ...collectWalletBridgeRouteDisclosures(tokenBalances.value),
    ]),
    bridgeRouteReadiness: bridgeRoutes.data.readiness,
    mrcAccount: mrcAccount.value,
    nativeAgentState: nativeAgentState.value,
    addressLabel: addressLabel.value ?? null,
    delegationHistory: extractAddressActivity(delegationHistory.value),
    addressActivity: extractAddressActivity(addressActivity.value),
    errors,
  };
}

function dedupeWalletBridgeRouteDisclosures(
  disclosures: readonly WalletBridgeRouteDisclosure[],
): WalletBridgeRouteDisclosure[] {
  const seen = new Set<string>();
  const out: WalletBridgeRouteDisclosure[] = [];
  for (const disclosure of disclosures) {
    const key =
      typeof disclosure.routeId === "string"
        ? `routeId:${disclosure.routeId}`
        : `json:${JSON.stringify(disclosure)}`;
    if (seen.has(key)) {
      const index = out.findIndex((row) => {
        const rowKey =
          typeof row.routeId === "string"
            ? `routeId:${row.routeId}`
            : `json:${JSON.stringify(row)}`;
        return rowKey === key;
      });
      if (index >= 0) {
        out[index] = mergeWalletBridgeRouteDisclosure(out[index]!, disclosure);
      }
      continue;
    }
    seen.add(key);
    out.push(disclosure);
  }
  return out;
}

function mergeWalletBridgeRouteDisclosure(
  primary: WalletBridgeRouteDisclosure,
  secondary: WalletBridgeRouteDisclosure,
): WalletBridgeRouteDisclosure {
  const merged: WalletBridgeRouteDisclosure = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    if (merged[key] === undefined || merged[key] === null) {
      merged[key] = value;
    }
  }
  return merged;
}

// Structural validators for the raw wire shapes. These guard the SW
// boundary — chrome.storage and popup callers downstream see only typed
// rows, so a malformed indexer response can't propagate. Partial-data
// preferred: a single bad entry is dropped, the rest of the array survives.

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateRawAddressActivity(input: unknown): RawAddressActivity | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNum(r.blockHeight)) return null;
  if (!isFiniteNum(r.txIndex)) return null;
  if (!isFiniteNum(r.logIndex)) return null;
  if (typeof r.kind !== "string") return null;
  if (r.direction !== "in" && r.direction !== "out" && r.direction !== null) {
    return null;
  }
  if (r.counterparty !== null && typeof r.counterparty !== "string") return null;
  if (r.tokenId !== null && typeof r.tokenId !== "string") return null;
  if (r.amount !== null && typeof r.amount !== "string") return null;
  if (r.cluster !== null && !isFiniteNum(r.cluster)) return null;
  if (r.weightBps !== null && !isFiniteNum(r.weightBps)) return null;
  if (r.subKind !== null && typeof r.subKind !== "string") return null;
  return {
    blockHeight: r.blockHeight,
    txIndex: r.txIndex,
    logIndex: r.logIndex,
    kind: r.kind,
    direction: r.direction,
    counterparty: r.counterparty,
    tokenId: r.tokenId,
    amount: r.amount,
    cluster: r.cluster,
    weightBps: r.weightBps,
    subKind: r.subKind,
  };
}

function validateRawDelegationHistory(input: unknown): RawDelegationHistory | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNum(r.blockHeight)) return null;
  if (!isFiniteNum(r.txIndex)) return null;
  if (!isFiniteNum(r.logIndex)) return null;
  if (typeof r.wallet !== "string") return null;
  if (!isFiniteNum(r.cluster)) return null;
  if (r.toCluster !== null && !isFiniteNum(r.toCluster)) return null;
  if (typeof r.kind !== "string") return null;
  if (!isFiniteNum(r.weightBps)) return null;
  if (r.walletTotalBps !== null && !isFiniteNum(r.walletTotalBps)) return null;
  return {
    blockHeight: r.blockHeight,
    txIndex: r.txIndex,
    logIndex: r.logIndex,
    wallet: r.wallet,
    cluster: r.cluster,
    toCluster: r.toCluster,
    kind: r.kind,
    weightBps: r.weightBps,
    walletTotalBps: r.walletTotalBps,
  };
}

function validateRawActivityList(input: unknown[]): RawAddressActivity[] {
  const out: RawAddressActivity[] = [];
  for (const raw of input) {
    const v = validateRawAddressActivity(raw);
    if (v) out.push(v);
  }
  return out;
}

function validateRawDelegationList(input: unknown[]): RawDelegationHistory[] {
  const out: RawDelegationHistory[] = [];
  for (const raw of input) {
    const v = validateRawDelegationHistory(raw);
    if (v) out.push(v);
  }
  return out;
}

// Helpers for the operators-health enrichment. The batched
// probe receives lyth_operatorCapabilities + lyth_indexerStatus alongside
// the existing net_version + eth_blockNumber pair; these helpers parse
// each subresult defensively so a single bad operator surface doesn't
// fail the whole row.

/** Extract the surfaces map from a `lyth_operatorCapabilities` response.
 *  SDK shape: `{ schemaVersion, surfaces: Record<string, { status, tracking? }> }`.
 *  Returns `null` when the response is missing or malformed — operators
 *  on pre-uplift binaries return `error` here, which is a perfectly
 *  legitimate "no capability info" signal. */
function parseOperatorCapabilities(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const surfaces = r["surfaces"];
  if (surfaces === null || typeof surfaces !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(surfaces as Record<string, unknown>)) {
    if (typeof raw === "object" && raw !== null) {
      const s = (raw as Record<string, unknown>)["status"];
      if (typeof s === "string") out[k] = s;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Extract { height, latest } from a `lyth_indexerStatus` response, with
 *  `null` for both when the indexer is disabled or the response is
 *  malformed. Bigints arrive as `string | number` on the wire; the
 *  wallet downcasts to `number` for display (block heights fit comfortably). */
function parseIndexerStatus(value: unknown): {
  height: number | null;
  latest: number | null;
} {
  if (value === null || value === undefined || typeof value !== "object") {
    return { height: null, latest: null };
  }
  const r = value as Record<string, unknown>;
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return {
    height: toNum(r["currentHeight"]),
    latest: toNum(r["latestHeight"]),
  };
}

/** Read both per-(addr, chain) cache keys in one chrome.storage.local
 *  round-trip. Returns null/empty for missing or malformed entries; the
 *  caller treats null as "no cache yet". */
async function readActivityStorage(
  cacheKey: string,
  pendingKey: string,
  localClaimsKey: string,
): Promise<{
  cache: ActivityCache | null;
  pending: PendingTxRow[];
  claims: PendingTxRow[];
}> {
  const stored = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(
      [cacheKey, pendingKey, localClaimsKey],
      (res) => resolve(res ?? {}),
    );
  });
  return {
    cache: validateActivityCache(stored[cacheKey]),
    pending: validatePendingActivityCache(stored[pendingKey])?.pending ?? [],
    // Durable reward-claim store — read on EVERY activity-get path so a claim
    // missing from the pending cache is always re-injected from the source of
    // truth (Gap B fix; applyLocalClaims runs on all return paths below).
    claims: validateLocalClaimsCache(stored[localClaimsKey])?.claims ?? [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Name-resolution helpers for `wallet-resolve-names`. Pairs with
// shared/name-resolution.ts: that module owns the storage schema +
// TTL + merge; the SW handler owns the wire shape validation +
// per-chain method-availability gate.
// ──────────────────────────────────────────────────────────────────────────────

// Per-chain method-availability gate. Written when a JSON-RPC call
// returns error -32601 (method not found); read on every subsequent
// call within METHOD_GATE_TTL_MS to skip the RPC. Cached state at
// the consumer (e.g. name cache hits) still serves — only the FETCH
// path is gated. Consumers pass their own storage key so each gated
// method has its own namespace; full `(chainIdHex, methodName)`-keyed
// generalization is deferred until a third consumer arrives. (Rule
// of three.)
const STORAGE_KEY_NAMES_METHOD_GATE = "mono.names.method-gate";
const STORAGE_KEY_INDEXER_STATUS_METHOD_GATE = "mono.indexerStatus.method-gate";
const METHOD_GATE_TTL_MS = 5 * 60 * 1000;

interface MethodGateEntry {
  /** Always false in v1 — the gate only stores known-unsupported. A
   *  successful call clears the entry rather than writing `true`. */
  supported: false;
  checkedAtMs: number;
}

type MethodGateMap = Record<string, MethodGateEntry>;

async function readMethodGate(storageKey: string): Promise<MethodGateMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get([storageKey], (res) => {
      const raw = res?.[storageKey];
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        resolve({});
        return;
      }
      const out: MethodGateMap = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (
          v !== null &&
          typeof v === "object" &&
          (v as { supported?: unknown }).supported === false &&
          typeof (v as { checkedAtMs?: unknown }).checkedAtMs === "number" &&
          Number.isFinite((v as { checkedAtMs: number }).checkedAtMs)
        ) {
          out[k] = {
            supported: false,
            checkedAtMs: (v as { checkedAtMs: number }).checkedAtMs,
          };
        }
      }
      resolve(out);
    });
  });
}

async function setMethodGate(
  storageKey: string,
  chainIdHex: string,
  entry: MethodGateEntry | null,
): Promise<void> {
  const gate = await readMethodGate(storageKey);
  if (entry === null) {
    delete gate[chainIdHex];
  } else {
    gate[chainIdHex] = entry;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [storageKey]: gate }, () => resolve());
  });
}

function methodGateTripped(
  gate: MethodGateMap,
  chainIdHex: string,
  now: number,
): boolean {
  const entry = gate[chainIdHex];
  if (entry === undefined) return false;
  return now - entry.checkedAtMs < METHOD_GATE_TTL_MS;
}

/** Validate the wire shape of `lyth_getAddressLabel`. Returns the
 *  wallet-internal `NameLabelRecord` (number-flavored updatedAtBlock)
 *  or null on any structural failure. The chain returns null for
 *  unlabeled addresses; null is handled at the caller (it's not a
 *  validation failure — it's a valid "checked, no label" result). */
function validateRawNameLabel(input: unknown): NameLabelRecord | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (typeof r.address !== "string" || r.address.length === 0) return null;
  if (typeof r.category !== "string") return null;
  if (r.displayName !== null && typeof r.displayName !== "string") return null;
  if (typeof r.updatedAtBlock !== "number" || !Number.isFinite(r.updatedAtBlock)) {
    return null;
  }
  return {
    address: r.address,
    category: r.category,
    displayName: r.displayName,
    updatedAtBlock: r.updatedAtBlock,
  };
}

// Indexer-staleness threshold for the popup banner. The indexer is
// considered "stale" when latestHeight - currentHeight exceeds this
// many blocks. At the testnet's 3-second cadence, 10 blocks
// is about 30 s of indexer lag: wider than normal ingestion variance,
// narrow enough to flag a real backlog before it becomes user-visible.
const INDEXER_LAG_STALE_THRESHOLD = 10;

// IndexerStatus validator + WALLET_KNOWN_INDEXER_SCHEMA_VERSION
// moved to shared/indexer-status.ts so both the SW (this file) and any
// future popup-side direct consumer share one wire-shape contract.
// `validateIndexerStatus` is now a re-export alias for backward
// compatibility with the existing call site below.
const validateIndexerStatus = validateIndexerStatusWire;

/** Per-address fetch. Returns the resolved label (null = chain has no
 *  entry for this address) or a methodNotFound flag when the operator
 *  returned the method as unavailable — JSON-RPC -32601 (method not found)
 *  or -32045 (METHOD_DISABLED, config-disabled). Other RPC errors map to
 *  `label: null` without setting the flag — they're transient, not chain-wide. */
async function fetchOneAddressLabel(
  addr: string,
): Promise<{ label: NameLabel; methodNotFound: boolean }> {
  try {
    const { result } = await testnetJsonRpc<unknown>(
      "lyth_getAddressLabel",
      [addr],
    );
    if (result === null) return { label: null, methodNotFound: false };
    return { label: validateRawNameLabel(result), methodNotFound: false };
  } catch (e) {
    const err = e as Error & { code?: number };
    if (err.code === -32601 || err.code === -32045) {
      return { label: null, methodNotFound: true };
    }
    return { label: null, methodNotFound: false };
  }
}

/** Fire-and-forget pending-row writer called from wallet-send-tx after
 *  submitPlaintextMlDsaTx resolves. Designed so a failure here CANNOT
 *  affect the broadcast handler — that handler has already returned to
 *  the popup with the tx hash by the time this runs. Two protection
 *  layers:
 *
 *  1. Outer try/catch swallows ALL errors (chrome.storage failures, RPC
 *     timeouts on the eth_blockNumber anchor, validator returning null
 *     on corrupted prior pending list). The caller uses `void` so no
 *     unhandled rejection can ever surface to the MV3 runtime.
 *  2. Inner try/catch around the eth_blockNumber RPC: anchor fetch is
 *     best-effort; on failure we write the row with
 *     broadcastBlockHeight: null, which makes pendingMatchesConfirmed
 *     in shared/activity.ts skip the heuristic match. The PENDING_TTL_MS
 *     backstop still evicts the row after 5 minutes regardless.
 *
 *  The compatibility `valueWeiHex` field carries lythoshi here. Conversion
 *  to decimal LYTH happens inline via lythoshiHexToLythDecimal so the
 *  amountDecimal field is byte-identical to the confirmed side, which converts
 *  the indexer's raw-lythoshi AddressActivityEntry.amount through the same
 *  shared formatter (shared/lyth-units.ts). That exact-string equality is what
 *  lets reconcilePending pair a pending row with its confirmed tx_send. */
async function persistPendingRowBackground(args: {
  address: string;
  chainIdHex: string;
  txHash: string;
  to: string;
  valueWeiHex: string;
  via: string;
  /** Broadcast-time operation tag for the notifications hook.
   *  Pure pending-row metadata; the upstream handler ensures it never
   *  reaches `submitPlaintextMlDsaTx`. */
  opKind?: TxOpKind;
  /** Cluster metadata for delegation sends — same metadata-only invariant. */
  clusterId?: number;
  clusterName?: string;
  toClusterId?: number;
  toClusterName?: string;
  /** Reward-claim metadata (opKind:"claim" only) — captured popup-side at
   *  broadcast. Marks the row source:"local-claim" (TTL-exempt) + mirrors it
   *  into the durable local-claims store. Metadata-only; never reaches the
   *  signer. */
  claimedAmount?: string | null;
  rateAtClaim?: number | null;
  currency?: CurrencyCode;
  delegationWeightBps?: number;
}): Promise<void> {
  try {
    const now = Date.now();
    let broadcastBlockHeight: number | null = null;
    try {
      const { result } = await testnetJsonRpc<unknown>("eth_blockNumber", []);
      if (typeof result === "string" && result.startsWith("0x")) {
        const n = Number.parseInt(result, 16);
        if (Number.isFinite(n)) broadcastBlockHeight = n;
      }
    } catch {
      // Anchor unavailable — fall through with null. TTL is the sole
      // eviction path for null-anchor rows; reconcilePending in
      // shared/activity.ts skips heuristic matching when the anchor
      // is null.
    }
    const amountDecimal = lythoshiHexToLythDecimal(args.valueWeiHex);
    const addrLower = args.address.toLowerCase();
    const pendingKey = activityPendingKey(addrLower, args.chainIdHex);
    const stored = await new Promise<unknown>((resolve) => {
      chrome.storage.local.get([pendingKey], (res) =>
        resolve(res?.[pendingKey]),
      );
    });
    const prev = validatePendingActivityCache(stored)?.pending ?? [];
    // A reward claim is a durable local record (the indexer never emits a claim
    // event): mark it source:"local-claim" so it is TTL-exempt + routes render
    // to claimedAmount, and mirror it into the localclaims store below.
    const isClaim = args.opKind === "claim";
    const row: PendingTxRow = {
      kind: "pending_tx",
      txHash: args.txHash,
      to: args.to.toLowerCase(),
      amountDecimal,
      broadcastedAtMs: now,
      broadcastBlockHeight,
      via: args.via,
      ...(args.opKind !== undefined ? { opKind: args.opKind } : {}),
      ...(args.clusterId !== undefined ? { clusterId: args.clusterId } : {}),
      ...(args.clusterName !== undefined ? { clusterName: args.clusterName } : {}),
      ...(args.toClusterId !== undefined ? { toClusterId: args.toClusterId } : {}),
      ...(args.toClusterName !== undefined ? { toClusterName: args.toClusterName } : {}),
      ...(isClaim ? { source: "local-claim" as const } : {}),
      ...(isClaim ? { claimedAmount: args.claimedAmount ?? null } : {}),
      ...(isClaim ? { rateAtClaim: args.rateAtClaim ?? null } : {}),
      ...(isClaim && args.currency !== undefined ? { currency: args.currency } : {}),
      ...(args.delegationWeightBps !== undefined
        ? { delegationWeightBps: args.delegationWeightBps }
        : {}),
    };
    const evicted = evictExpiredPending(prev, now);
    const next = [row, ...evicted];
    await new Promise<void>((resolve) => {
      chrome.storage.local.set(
        { [pendingKey]: { pending: next } },
        () => resolve(),
      );
    });
    // Mirror the claim into the durable local-claims store (the source of truth
    // that survives a lost pending cache; re-injected each poll by
    // applyLocalClaims). Dedup by txHash (intra-store identity); cap to newest.
    if (isClaim) {
      const claimsKey = activityLocalClaimsKey(addrLower, args.chainIdHex);
      const storedClaims = await new Promise<unknown>((resolve) => {
        chrome.storage.local.get([claimsKey], (res) => resolve(res?.[claimsKey]));
      });
      const prevClaims = validateLocalClaimsCache(storedClaims)?.claims ?? [];
      const deduped = prevClaims.filter((c) => c.txHash !== row.txHash);
      const nextClaims = [row, ...deduped].slice(0, LOCAL_CLAIMS_CAP);
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { [claimsKey]: { claims: nextClaims } },
          () => resolve(),
        );
      });
    }
    // A pending row now exists → arm the headless poll so this tx's
    // terminal transition is observed (toast + badge) even if every wallet
    // surface is closed before it confirms. Idempotent; lock-independent.
    void ensureNotifPollAlarm();
    // CX3 — record the recipient in the durable sent-address log so repeat
    // sends to it aren't re-warned as "first-time" once the pending row's TTL
    // lapses (independent of any indexer refresh). Best-effort.
    const sentKey = sentAddressesKey(addrLower, args.chainIdHex);
    const sentStored = await new Promise<unknown>((resolve) => {
      chrome.storage.local.get([sentKey], (res) => resolve(res?.[sentKey]));
    });
    const nextSent = addToSentList(parseSentAddresses(sentStored), args.to);
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ [sentKey]: { addrs: nextSent } }, () => resolve());
    });
  } catch {
    // Swallow. The broadcast handler has already returned. A
    // pending-write failure is silent UX degradation only — the user
    // already has their tx hash; on the next refresh the confirmed
    // row will surface from the indexer (or not, if the broadcast
    // itself was the issue, but that path is the broadcast handler's
    // catch block, not ours).
  }
}

/** Terminal-state classifier for one pending row — see notifications
 *  plan §P2. Carries the genuine confirmed/failed bit + receipt blockNumber
 *  through to the snapshot hook so notifications can fire honestly (the
 *  MetaMask #5117 hazard: never show a failed tx as confirmed). */
export interface TerminalPendingTx {
  row: PendingTxRow;
  status: "confirmed" | "failed";
  blockNumber: number | null;
  /** Receipt `tx_index` — the tx's position in its block. With blockNumber it
   *  uniquely identifies the inclusion slot, so a bridged confirmed row can be
   *  matched to the indexer's canonical row by exact (block, txIndex)
   *  regardless of kind (tx_send, delegate, undelegate, …). Null when absent. */
  txIndex: number | null;
  /** For a CONFIRMED reward claim (source:"local-claim"): the authoritative
   *  claimed amount decoded from the receipt's `Claimed` log (data word-0),
   *  decimal lythoshi — or null/absent when not a claim or no log. The bridge
   *  converts it to decimal LYTH and writes it onto the row, overriding the
   *  (dropped) submit-time capture. Additive: callers that ignore it (the
   *  notification loops, the Gap A alarm re-bridge) are unaffected. */
  claimedAmountLythoshi?: string | null;
}

/** Parse a testnet receipt's block + tx index. Numeric (the operators' shape)
 *  or hex-string; null when absent/unparseable. */
function parseReceiptBlockTx(result: {
  blockNumber?: unknown;
  block_number?: unknown;
  tx_index?: unknown;
  txIndex?: unknown;
}): { blockNumber: number | null; txIndex: number | null } {
  const num = (raw: unknown): number | null => {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseInt(raw, 16)
          : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    blockNumber: num(result.blockNumber ?? result.block_number),
    txIndex: num(result.tx_index ?? result.txIndex),
  };
}

/** Deterministic pending→terminal classification.
 *  Once a tx carries its canonical hash (`submitPlaintextMlDsaTx` surfaces
 *  `innerTxHashHex`), the chain can be asked directly instead of relying solely
 *  on the counterparty+amount heuristic. Returns:
 *
 *   - `kept`: rows still pending (no explicit terminal answer from the RPC).
 *     `lyth_txStatus`'s `not_found`, a `null` receipt, an unknown/non-1/non-0
 *     status, or any RPC throw all land here. The heuristic reconciler +
 *     PENDING_TTL_MS backstop remain the safety nets, and we never synthesize
 *     a verdict.
 *   - `terminal`: rows that the chain explicitly resolved this round. A
 *     `lyth_txStatus="found"` means INCLUDED (not necessarily successful — a
 *     reverted tx is still "found"), so the receipt's status bit is read to
 *     tag confirmed vs failed; only when no receipt is available does the
 *     indexer's inclusion stand as confirmed (we still never fabricate a
 *     failure). The `eth_getTransactionReceipt` branch reuses the b4d6101 the testnet
 *     normalizer (numeric `status` 0/1 OR hex string; `blockNumber ??
 *     block_number`, numeric OR hex string) — the operators' actual receipt
 *     shape, not the EVM-standard hex-string shape.
 *
 *  Bounded: pending lists are tiny (one entry per outstanding send). */
async function dropConfirmedPendingByHash(
  pending: PendingTxRow[],
  opts?: { timeoutMs?: number },
): Promise<{
  kept: PendingTxRow[];
  terminal: TerminalPendingTx[];
  /** Count of rows whose classification RPC threw (timeout /
   *  transport / all-operators-down). Additive: the popup chokepoint
   *  caller destructures only `{ kept, terminal }` and ignores this, so its
   *  behavior is unchanged. The poll-core uses it to drive the all-fail
   *  back-off. */
  rpcFailures: number;
}> {
  const kept: PendingTxRow[] = [];
  const terminal: TerminalPendingTx[] = [];
  let rpcFailures = 0;
  for (const p of pending) {
    try {
      const { result } = await testnetJsonRpc<{ status?: string } | null>(
        "lyth_txStatus",
        [p.txHash],
        opts,
      );
      if (result != null && result.status === "found") {
        // lyth_txStatus reports INCLUSION, not success — a reverted (failed)
        // tx is still "found". Confirm/fail ONLY on the receipt's actual status
        // bit (1/0x1 → confirmed, 0/0x0 → failed). If the receipt is
        // unavailable/unparseable, keep the row PENDING — it resolves on a
        // later poll once the receipt lands. Don't optimistically confirm a
        // found-but-receiptless tx (F-3.10/#27): a not-yet-available receipt
        // can't reveal a revert, so labeling it confirmed could mislabel a
        // briefly-reverted tx. PENDING_TTL_MS + the heuristic reconciler remain
        // the backstops; we still never fabricate a verdict.
        let resolved: {
          status: "confirmed" | "failed";
          blockNumber: number | null;
          txIndex: number | null;
        } | null = null;
        // Authoritative claimed amount from the receipt's `Claimed` log (decimal
        // lythoshi) — decoded ONLY for a confirmed reward claim, from the receipt
        // already in hand (no extra round-trip). null for non-claims / no log.
        let claimedAmountLythoshi: string | null = null;
        try {
          const receipt = await testnetJsonRpc<{
            status?: number | string;
            blockNumber?: unknown;
            block_number?: unknown;
            tx_index?: unknown;
            txIndex?: unknown;
            logs?: unknown;
          } | null>("eth_getTransactionReceipt", [p.txHash], opts);
          if (receipt.result != null) {
            const anchor = parseReceiptBlockTx(receipt.result);
            const rawStatus = receipt.result.status;
            if (rawStatus === 1 || rawStatus === "0x1") {
              resolved = { status: "confirmed", blockNumber: anchor.blockNumber, txIndex: anchor.txIndex };
              if (p.source === "local-claim") {
                claimedAmountLythoshi = decodeClaimedAmountLythoshi(receipt.result.logs);
              }
            } else if (rawStatus === 0 || rawStatus === "0x0") {
              resolved = { status: "failed", blockNumber: anchor.blockNumber, txIndex: anchor.txIndex };
            }
            // else: receipt present but status bit unreadable → keep pending.
          }
        } catch {
          // Receipt unavailable → keep pending (resolves on a later poll).
        }
        if (resolved) {
          terminal.push({
            row: p,
            status: resolved.status,
            blockNumber: resolved.blockNumber,
            txIndex: resolved.txIndex,
            ...(claimedAmountLythoshi !== null ? { claimedAmountLythoshi } : {}),
          });
        } else {
          kept.push(p);
        }
        continue;
      }
      const receipt = await testnetJsonRpc<{
        status?: number | string;
        blockNumber?: unknown;
        block_number?: unknown;
        tx_index?: unknown;
        txIndex?: unknown;
        logs?: unknown;
      } | null>("eth_getTransactionReceipt", [p.txHash], opts);
      if (receipt.result == null) {
        kept.push(p);
        continue;
      }
      const rawStatus = receipt.result.status;
      const { blockNumber, txIndex } = parseReceiptBlockTx(receipt.result);
      if (rawStatus === 1 || rawStatus === "0x1") {
        const claimedAmountLythoshi =
          p.source === "local-claim"
            ? decodeClaimedAmountLythoshi(receipt.result.logs)
            : null;
        terminal.push({
          row: p,
          status: "confirmed",
          blockNumber,
          txIndex,
          ...(claimedAmountLythoshi !== null ? { claimedAmountLythoshi } : {}),
        });
      } else if (rawStatus === 0 || rawStatus === "0x0") {
        terminal.push({ row: p, status: "failed", blockNumber, txIndex });
      } else {
        kept.push(p);
      }
    } catch {
      // Status RPC unavailable / not_found → keep the row. Never synthesize.
      rpcFailures++;
      kept.push(p);
    }
  }
  return { kept, terminal, rpcFailures };
}

/** Stamp the receipt's inclusion slot (block, txIndex) onto each receipt-
 *  CONFIRMED pending row so it renders confirmed immediately (not "Pending")
 *  and reconcilePending can later retire it by that exact (block, txIndex) slot
 *  — for ANY kind (transfer OR delegate/undelegate/redelegate), not just
 *  tx_send. Falls back to the broadcast anchor for the block; a row with no
 *  known block stays a plain pending row until the indexer surfaces it. FAILED
 *  terminals are NOT bridged (they surface via the failed-row notification
 *  path). Shared by the full path and the indexer-outage path so both bridge
 *  identically. */
function bridgeConfirmedTerminals(
  terminals: TerminalPendingTx[],
): PendingTxRow[] {
  return terminals
    .filter((t) => t.status === "confirmed")
    .map((t) => {
      const block = t.blockNumber ?? t.row.broadcastBlockHeight;
      if (block === null) return t.row;
      const bridged: PendingTxRow = {
        ...t.row,
        confirmedBlockHeight: block,
        ...(t.txIndex !== null ? { confirmedTxIndex: t.txIndex } : {}),
      };
      // Self-heal the claim amount from the receipt's `Claimed` log (decimal
      // lythoshi → decimal LYTH), overriding the dropped submit-time capture.
      // ONLY for a reward claim with a decoded amount; runs each poll so a
      // confirmed claim row that was missing the amount picks it up. Persisted
      // via the durable local-claim store (Gap B) → both surfaces self-heal.
      if (t.row.source === "local-claim" && t.claimedAmountLythoshi != null) {
        bridged.claimedAmount = lythoshiDecimalToLythDecimal(
          t.claimedAmountLythoshi,
        );
      }
      return bridged;
    });
}

/** Best-effort total tx fee (lythoshi decimal string) for a CONFIRMED tx, read
 *  from `lyth_decodeTx.fee.total_lythoshi` — the "comprehensive tx-detail" RPC
 *  whose `fee` the chain COMPUTES for EVERY tx kind ((block base price + signed
 *  priority tip) × execution-units-used). This covers native transfers and
 *  delegation / system-precompile calls, which the previously-used
 *  `lyth_nativeReceipt` does NOT: that method carries a fee only for RISC-V/MRV
 *  (contract) txs and returns `-32090 not found` for native-lane txs — which is
 *  why the fee line was blank for sends + delegations. The eth-compat
 *  `eth_getTransactionReceipt` carries gas_used + status only (no price / no fee
 *  total). Returns the lythoshi string only when it parses + is > 0:
 *   - a not-decodable tx, or an operator that does not advertise `lyth_decodeTx`
 *     (`-32046` / `-32090` / etc.) → undefined (no fee line)
 *   - a zero fee → undefined (display would hide it)
 *  NO-MOCK: the wallet surfaces the chain's `total_lythoshi` verbatim — it never
 *  fabricates a value or locally computes `base × gas` itself; honest absence
 *  (undefined → no fee row) beats an invented number.
 *  READ-ONLY + isolated: wrapped so it can never throw into the notification
 *  path, and it never touches signing / broadcast / nonce / payload. The fee
 *  is lythoshi (1 LYTH = 1e18), NOT a separate wei domain. */
async function fetchConfirmedFeeLythoshi(
  txHash: string,
  opts?: { timeoutMs?: number },
): Promise<string | undefined> {
  try {
    // We read ONLY `fee.total_lythoshi` off the full tx-decode payload.
    const { result } = await testnetJsonRpc<{
      fee?: { total_lythoshi?: unknown } | null;
    } | null>("lyth_decodeTx", [txHash], opts);
    const raw = result?.fee?.total_lythoshi;
    if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return undefined;
    return BigInt(raw) > 0n ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Highest activity anchor among a confirmed-row set (null when empty). */
function maxConfirmedAnchor(confirmed: ConfirmedRow[]): IncomingWatermark | null {
  let max: IncomingWatermark | null = null;
  for (const r of confirmed) {
    const a = { blockHeight: r.blockHeight, txIndex: r.txIndex, logIndex: r.logIndex };
    if (max === null || anchorAfter(a, max)) max = a;
  }
  return max;
}

/** Item 7b — incoming-transfer detection (OPEN-SURFACE / UNLOCKED-ONLY).
 *  Diffs the confirmed `tx_receive` rows (incoming LYTH the indexer already
 *  surfaced) against the per-(addr,chain) watermark; records + toasts the new
 *  ones; advances the watermark. On first run it ONLY establishes a baseline
 *  (the current newest anchor) so a fresh/returning wallet never toasts its
 *  history. Read-only + best-effort — nothing here touches signing/broadcast.
 *  Option (a): no closed/locked poll, so this runs only when an open surface
 *  drove the snapshot fetch (⇒ the wallet is unlocked, address available).
 *  Incoming entries carry no tx hash, so the dedupe id is anchor-derived
 *  (`in:<block>.<txIndex>.<logIndex>`). Returns the count recorded.
 *  Exported for unit tests (driven against the in-memory chrome stub). */
export async function detectAndNotifyIncoming(
  addressLower: string,
  chainIdHex: string,
  confirmed: ConfirmedRow[],
  surfaceOpen: boolean,
  unlocked: boolean,
): Promise<number> {
  try {
    const wm = await getIncomingWatermark(addressLower, chainIdHex);
    if (wm === null) {
      // Baseline — everything currently in view is history; no toasts. A
      // negative sentinel when there's nothing yet so the first-ever incoming
      // still notifies next cycle.
      const baseline =
        maxConfirmedAnchor(confirmed) ??
        { blockHeight: -1, txIndex: -1, logIndex: -1 };
      await setIncomingWatermark(addressLower, chainIdHex, baseline);
      return 0;
    }
    // Item 7c — the incoming-transfer TOAST is gated by its own toggle (default
    // on); the in-app record is always written regardless (§0.4).
    const incomingToastEnabled = await getIncomingEnabled();
    let added = 0;
    let maxSeen = wm;
    for (const r of confirmed) {
      if (r.kind !== "tx_receive") continue;
      if (!anchorAfter(r, wm)) continue;
      const result = await recordNotification({
        addressLower,
        chainIdHex,
        txHash: `in:${r.blockHeight}.${r.txIndex}.${r.logIndex}`,
        status: "confirmed",
        blockNumber: r.blockHeight,
        kind: "receive",
        amountDecimal: r.amountDecimal ?? "0",
        counterparty: r.counterparty ?? "",
        read: surfaceOpen,
      });
      if (result.added && result.record !== null) {
        added++;
        if (incomingToastEnabled) {
          await fireOsNotification(result.record, { unlocked });
        }
      }
      const anchor = {
        blockHeight: r.blockHeight,
        txIndex: r.txIndex,
        logIndex: r.logIndex,
      };
      if (anchorAfter(anchor, maxSeen)) maxSeen = anchor;
    }
    if (anchorAfter(maxSeen, wm)) {
      await setIncomingWatermark(addressLower, chainIdHex, maxSeen);
    }
    return added;
  } catch {
    return 0;
  }
}

/** Headless background poll core. Enumerates every
 *  `mono.activity.pending.*` scope, asks the chain whether each KNOWN
 *  pending tx has reached a terminal state, and runs the SAME
 *  detect→record→toast→badge sequence the popup chokepoint runs — but
 *  with no surface open. READ-AND-NOTIFY ONLY: it reads public receipts
 *  for hashes already in plaintext storage and writes only the
 *  notification store + OS toast + badge. It NEVER touches signing /
 *  broadcast / fee / nonce / encrypted payload.
 *
 *  Returns `{ remaining, allFailed }`: `remaining` = pending rows still
 *  outstanding across all scopes after this tick (the alarm caller self-
 *  clears at 0); `allFailed` = there were rows to check and EVERY
 *  classification RPC failed with nothing terminal (the alarm caller backs
 *  off so a total outage doesn't wake the SW every minute).
 *  Exported for unit tests (driven directly against the in-memory chrome
 *  stub); production calls it from the ALARM_NOTIF_POLL onAlarm branch.
 *  Best-effort: never throws out of the alarm. */
export async function pollPendingAndNotify(): Promise<{
  remaining: number;
  allFailed: boolean;
}> {
  let remaining = 0;
  let checkedTotal = 0;
  let failedTotal = 0;
  let terminalTotal = 0;
  try {
    const all = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(null, (res) => resolve(res ?? {}));
    });
    const now = Date.now();
    // C3 — presence at observe-time, computed ONCE per tick: a surface open
    // now ⇒ the user is present ⇒ record read (no badge bump); closed ⇒
    // accumulate unread. Defaults false (closed) on any error.
    const surfaceOpen = await isWalletSurfaceOpen();
    // Lock state for the toast/badge gates (orthogonal to presence): gate-only,
    // no decryption. Computed once per tick.
    const unlocked = isUnlockedV4();
    for (const key of Object.keys(all)) {
      if (!key.startsWith("mono.activity.pending.")) continue;
      // key = mono.activity.pending.<addrLower>.<chainIdHex>; addresses and
      // chainIdHex never contain a dot, so the LAST dot splits them.
      const rest = key.slice("mono.activity.pending.".length);
      const dot = rest.lastIndexOf(".");
      if (dot <= 0) continue;
      const addressLower = rest.slice(0, dot);
      const chainIdHex = rest.slice(dot + 1);
      const pending = validatePendingActivityCache(all[key])?.pending ?? [];
      if (pending.length === 0) continue;
      // testnet-only: the receipt RPC + indexer are testnet-shaped.
      // Non-testnet rows still count toward `remaining` (don't strand the
      // alarm) but aren't polled.
      if (!chainRequiresMlDsa(chainIdHex)) {
        remaining += pending.length;
        continue;
      }
      // TTL-evict FIRST so an expired row is neither notified nor re-polled.
      const live = evictExpiredPending(pending, now);
      const { kept, terminal, rpcFailures } = await dropConfirmedPendingByHash(
        live,
        { timeoutMs: NOTIF_POLL_RPC_TIMEOUT_MS },
      );
      checkedTotal += live.length;
      failedTotal += rpcFailures;
      terminalTotal += terminal.length;
      for (const t of terminal) {
        // Same shape the popup terminal-by-hash loop builds. The status is
        // receipt-derived (confirmed/failed) — #5117 preserved.
        // Capture the LYTH fee for confirmed self-paid txs (native receipt);
        // best-effort — failed/zero-fee leaves it unset.
        const feeLythoshi =
          t.status === "confirmed"
            ? await fetchConfirmedFeeLythoshi(t.row.txHash, {
                timeoutMs: NOTIF_POLL_RPC_TIMEOUT_MS,
              })
            : undefined;
        const result = await recordNotification({
          addressLower,
          chainIdHex,
          txHash: t.row.txHash,
          status: t.status,
          blockNumber: t.blockNumber,
          kind: t.row.opKind ?? "contract_call",
          amountDecimal: t.row.amountDecimal,
          counterparty: t.row.to,
          read: surfaceOpen,
          ...(feeLythoshi !== undefined ? { feeLythoshi } : {}),
          ...(t.row.clusterId !== undefined ? { clusterId: t.row.clusterId } : {}),
          ...(t.row.clusterName !== undefined
            ? { clusterName: t.row.clusterName }
            : {}),
          ...(t.row.toClusterId !== undefined ? { toClusterId: t.row.toClusterId } : {}),
          ...(t.row.toClusterName !== undefined
            ? { toClusterName: t.row.toClusterName }
            : {}),
          ...(t.claimedAmountLythoshi != null
            ? { claimedAmount: lythoshiDecimalToLythDecimal(t.claimedAmountLythoshi) }
            : {}),
          ...(t.row.delegationWeightBps !== undefined
            ? { delegationWeightBps: t.row.delegationWeightBps }
            : {}),
        });
        if (result.added && result.record !== null) {
          await fireOsNotification(result.record, { unlocked });
        }
      }
      // Write back the still-pending rows. A reward CLAIM (source:"local-claim")
      // is a DURABLE local record — the indexer emits no claim event, so the
      // alarm must NOT delete a confirmed claim from the pending cache (that
      // would vanish it from an open popup via onChanged). Re-bridge a
      // terminal-confirmed claim back into the written list (stamp the receipt
      // inclusion slot, mirroring the activity-get bridge); ordinary terminal
      // rows still drop (they re-surface from the indexer). Order + object refs
      // are preserved so a settled claim never fires a spurious onChanged.
      const confirmedClaims = new Map(
        terminal
          .filter((t) => t.status === "confirmed" && t.row.source === "local-claim")
          .map((t) => [t.row.txHash, t] as const),
      );
      let writtenPending: PendingTxRow[];
      if (confirmedClaims.size === 0) {
        writtenPending = kept;
      } else {
        const keptHashes = new Set(kept.map((r) => r.txHash));
        writtenPending = live
          .filter((r) => keptHashes.has(r.txHash) || confirmedClaims.has(r.txHash))
          .map((r) => {
            const tc = confirmedClaims.get(r.txHash);
            if (tc === undefined || r.confirmedBlockHeight !== undefined) return r;
            const block = tc.blockNumber ?? r.broadcastBlockHeight;
            return block !== null
              ? {
                  ...r,
                  confirmedBlockHeight: block,
                  ...(tc.txIndex !== null ? { confirmedTxIndex: tc.txIndex } : {}),
                }
              : r;
          });
      }
      const writtenChanged =
        writtenPending.length !== pending.length ||
        writtenPending.some((row, i) => row !== pending[i]);
      if (writtenChanged) {
        await new Promise<void>((resolve) => {
          chrome.storage.local.set(
            { [key]: { pending: writtenPending } },
            () => resolve(),
          );
        });
      }
      // A confirmed claim is a settled record, NOT in-flight — exclude it from
      // `remaining` so it never keeps the alarm armed (kept rows still do).
      remaining += kept.length;
    }
    await refreshUnreadBadge({
      unlocked,
      activeAddrLower: getUnlockedAddressV4()?.toLowerCase() ?? null,
    });
  } catch {
    // Best-effort — a poll failure must never escape the alarm.
  }
  const allFailed =
    checkedTotal > 0 && failedTotal === checkedTotal && terminalTotal === 0;
  return { remaining, allFailed };
}

/** Persist the merged cache. Pending key only writes when its contents
 *  changed, so chrome.storage.onChanged doesn't fire spuriously on
 *  no-op reconciliations. */
async function writeActivityStorage(
  cacheKey: string,
  pendingKey: string,
  nextCache: ActivityCache,
  prevPending: PendingTxRow[],
  nextPending: PendingTxRow[],
): Promise<void> {
  return new Promise((resolve) => {
    const writes: Record<string, unknown> = { [cacheKey]: nextCache };
    const pendingChanged =
      nextPending.length !== prevPending.length ||
      nextPending.some((row, i) => row !== prevPending[i]);
    if (pendingChanged) {
      writes[pendingKey] = { pending: nextPending };
    }
    chrome.storage.local.set(writes, () => resolve());
  });
}

async function handlePopup(message: PopupMessage): Promise<unknown> {
  switch (message.op) {
    case "list-pending":
      return listPending();
    case "resolve": {
      const p = message.payload as { id: string; decision: ApprovalDecision };
      const found = resolveApproval(p.id, p.decision);
      return { found };
    }
    case "focus-approval": {
      const id = (message.payload as { id?: string } | undefined)?.id;
      if (!id) return { focused: false };
      return await focusApproval(id);
    }
    case "revoke-origin": {
      const p = message.payload as { origin?: string } | undefined;
      if (!p?.origin) return { ok: false };
      await removeConnectedSite(p.origin);
      session.connectedOrigins.delete(p.origin);
      // T2-03 — tell the dApp it lost access (EIP-1193 accountsChanged:[]).
      broadcastDisconnect(p.origin);
      return { ok: true };
    }
    case "revoke-all-origins": {
      const revoked = [...session.connectedOrigins];
      await clearAllConnectedSites();
      session.connectedOrigins.clear();
      // T2-03 — disconnect every previously-connected dApp.
      for (const origin of revoked) broadcastDisconnect(origin);
      return { ok: true };
    }
    case "keystore-status": {
      // If the SW just woke from hibernation, restore the unlocked session
      // (within the auto-lock deadline) BEFORE answering so a status query
      // racing SW boot doesn't report a false "locked" the popup can't
      // recover from. See ensureUnlockRestored.
      await ensureUnlockRestored();
      // v4 (ML-DSA-65) is the only vault format. A populated multi-vault
      // container (mono.vaults.v4) means "wallet present"; its absence means
      // "no wallet" → the popup routes to Welcome. The v2/v1 "vault format
      // upgraded — re-import your seed" banner was retired with the legacy
      // keystore (no popup surface consumed `legacyVault`).
      const v4Exists = await hasContainerV4();
      if (v4Exists) {
        return {
          hasVault: true,
          legacyVault: false,
          unlocked: isUnlockedV4(),
          address: getUnlockedAddressV4(),
          custody: "sw" as const,
          algo: "mldsa" as const,
        };
      }
      return {
        hasVault: false,
        legacyVault: false,
        unlocked: false,
        address: null,
        custody: "sw" as const,
        algo: "mldsa" as const,
      };
    }
    case "chain-list": {
      return Object.entries(chainRegistry()).map(([id, n]) => ({
        chainId: id,
        name: n.name,
        rpc: n.rpc,
        chainIdNum: n.chainIdNum,
        builtin: !!n.builtin,
        official: !!n.official,
        active: id === session.chainId,
        ...(n.blockExplorer ? { blockExplorer: n.blockExplorer } : {}),
        ...(n.nativeCurrency ? { nativeCurrency: n.nativeCurrency } : {}),
      }));
    }
    case "wallet-active-chain": {
      return { ok: true, chainId: session.chainId };
    }
    case "wallet-set-active-chain": {
      // Popup-side chain switch. Mirrors `wallet_switchEthereumChain`'s
      // contract (validate against the known set, persist, broadcast
      // chainChanged) but is invoked through the popup IPC channel
      // rather than the dApp RPC channel.
      const p = message.payload as { chainId?: string };
      if (typeof p?.chainId !== "string") {
        return { ok: false, reason: "missing chainId" };
      }
      if (!lookupChain(p.chainId)) {
        return { ok: false, reason: "unknown chainId" };
      }
      session.chainId = canonicalChainKey(p.chainId);
      await persistActiveChainId(session.chainId);
      broadcastEvent("chainChanged", session.chainId);
      return { ok: true, chainId: session.chainId };
    }
    case "chain-add-manual": {
      // In-popup manual add. Skips `gatedEnqueue` because the user is
      // already in the wallet UI clicking Apply — routing through the
      // approval window would surface a redundant dialog. The dApp
      // wallet_addEthereumChain path keeps its gate for cross-origin trust.
      const p = message.payload as
        | {
            chain?: {
              chainId?: string;
              name?: string;
              rpc?: string;
              blockExplorer?: string;
              nativeCurrency?: { name: string; symbol: string; decimals: number };
            };
          }
        | undefined;
      const c = p?.chain;
      if (!c || typeof c.chainId !== "string" || typeof c.name !== "string" || typeof c.rpc !== "string") {
        return { ok: false, reason: "missing chainId, name, or rpc" };
      }
      if (!/^0x[0-9a-fA-F]+$/.test(c.chainId)) {
        return { ok: false, reason: "chainId must be 0x-prefixed hex" };
      }
      const chainIdNum = parseHexQuantity(c.chainId);
      if (chainIdNum <= 0) {
        return { ok: false, reason: "chainId must be a positive integer" };
      }
      const key = canonicalChainKey(c.chainId);
      if (lookupChain(key)) {
        return { ok: false, reason: "chain id already exists" };
      }
      const trimmedName = c.name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 64) {
        return { ok: false, reason: "name must be 1-64 chars" };
      }
      try {
        // eslint-disable-next-line no-new
        new URL(c.rpc);
      } catch {
        return { ok: false, reason: "rpc must be a valid URL" };
      }
      if (c.blockExplorer) {
        try {
          // eslint-disable-next-line no-new
          new URL(c.blockExplorer);
        } catch {
          return { ok: false, reason: "blockExplorer must be a valid URL" };
        }
      }
      userChains[key] = {
        name: trimmedName,
        rpc: c.rpc,
        chainIdNum,
        ...(c.blockExplorer ? { blockExplorer: c.blockExplorer } : {}),
        ...(c.nativeCurrency ? { nativeCurrency: c.nativeCurrency } : {}),
      };
      await persistUserChains();
      return { ok: true, chainId: key };
    }
    case "chain-edit": {
      // Mutate a user-added chain. Builtin keys are rejected. No
      // chainChanged broadcast — even when the active chain's RPC is
      // edited, the chainId itself doesn't change, so EIP-1193
      // chainChanged would be incorrect. Downstream RPC calls pick up
      // the new RPC on the next probe.
      const p = message.payload as
        | {
            chainId?: string;
            patch?: {
              name?: string;
              rpc?: string;
              blockExplorer?: string | null;
              nativeCurrency?: { name: string; symbol: string; decimals: number } | null;
            };
          }
        | undefined;
      if (!p || typeof p.chainId !== "string" || !p.patch) {
        return { ok: false, reason: "missing chainId or patch" };
      }
      const key = canonicalChainKey(p.chainId);
      if (BUILTIN_CHAINS[key]) {
        return { ok: false, reason: "cannot edit builtin chain" };
      }
      const existing = userChains[key];
      if (!existing) {
        return { ok: false, reason: "unknown chain" };
      }
      const patch = p.patch;
      if (patch.name !== undefined) {
        const t = patch.name.trim();
        if (t.length === 0 || t.length > 64) {
          return { ok: false, reason: "name must be 1-64 chars" };
        }
      }
      if (patch.rpc !== undefined) {
        try {
          // eslint-disable-next-line no-new
          new URL(patch.rpc);
        } catch {
          return { ok: false, reason: "rpc must be a valid URL" };
        }
      }
      if (typeof patch.blockExplorer === "string" && patch.blockExplorer.length > 0) {
        try {
          // eslint-disable-next-line no-new
          new URL(patch.blockExplorer);
        } catch {
          return { ok: false, reason: "blockExplorer must be a valid URL" };
        }
      }
      const next: NetInfo = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.rpc !== undefined ? { rpc: patch.rpc } : {}),
      };
      // blockExplorer / nativeCurrency are explicitly nullable in the patch:
      // null → remove the field; string/object → set it; undefined → keep.
      if (patch.blockExplorer === null) {
        delete next.blockExplorer;
      } else if (typeof patch.blockExplorer === "string" && patch.blockExplorer.length > 0) {
        next.blockExplorer = patch.blockExplorer;
      }
      if (patch.nativeCurrency === null) {
        delete next.nativeCurrency;
      } else if (patch.nativeCurrency) {
        next.nativeCurrency = patch.nativeCurrency;
      }
      userChains[key] = next;
      await persistUserChains();
      return { ok: true };
    }
    case "chain-delete": {
      // Remove a user-added chain. If it was the active chain, reset to
      // the testnet and broadcast chainChanged so connected dApps learn the
      // chain they think the wallet is on no longer exists.
      const p = message.payload as { chainId?: string } | undefined;
      if (!p || typeof p.chainId !== "string") {
        return { ok: false, reason: "missing chainId" };
      }
      const key = canonicalChainKey(p.chainId);
      if (BUILTIN_CHAINS[key]) {
        return { ok: false, reason: "cannot delete builtin chain" };
      }
      if (!userChains[key]) {
        return { ok: false, reason: "unknown chain" };
      }
      delete userChains[key];
      await persistUserChains();
      if (session.chainId === key) {
        session.chainId = TESTNET_CHAIN_ID_HEX;
        await persistActiveChainId(session.chainId);
        broadcastEvent("chainChanged", session.chainId);
      }
      return { ok: true };
    }
    case "testnet-operators-get": {
      const override = await readOperatorOverride();
      return {
        ok: true,
        override,
        defaults: getDefaultOperators().map((d) => ({ ...d })),
        effective: getActiveOperators().map((d) => ({ ...d })),
      };
    }
    case "testnet-operators-health": {
      // About-page operator-table source. Probes every active operator
      // in parallel (net_version + eth_blockNumber) and surfaces the
      // genesis-hash verification result. The inner
      // verifyOperatorGenesis call uses its own forever-cache, so
      // repeated About-page opens don't re-probe chain identity; this
      // handler itself isn't cached because the latency / block-tip
      // numbers should be fresh on every screen open.
      const ops = getActiveOperators();
      const PROBE_BUDGET_MS = 1_500;
      const results = await Promise.all(
        ops.map(async (op) => {
          // Force the genesis check into the cache and snapshot the
          // observed value so the row can render both ok + observed.
          await verifyOperatorGenesis(op.rpc, PROBE_BUDGET_MS);
          const genesisEntry = snapshotGenesisCache().get(op.rpc);
          const trustedGenesis = genesisEntry?.ok ?? false;
          const observedGenesis = genesisEntry?.observed ?? null;
          // -32047 "chain quarantined" verdict from the genesis probe (same
          // chain, self-quarantined on a checkpoint state-root mismatch). The
          // op still answers net_version, so the row is ok:true — this flag is
          // what lets the UI label it "Quarantined" rather than "Untrusted".
          const quarantined = genesisEntry?.quarantined ?? false;

          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PROBE_BUDGET_MS);
          try {
            const startedAt = Date.now();
            // Batched probe extended with capability + indexer
            // surfaces (SDK commits 0f483b8 + service-probe helpers). The
            // capability/indexer responses may be missing on operators
            // running pre-uplift binaries; the parse below treats their
            // absence as "no capability info" rather than failing the row.
            const body = JSON.stringify([
              { jsonrpc: "2.0", id: 1, method: "net_version", params: [] },
              { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
              { jsonrpc: "2.0", id: 3, method: "lyth_operatorCapabilities", params: [] },
              { jsonrpc: "2.0", id: 4, method: "lyth_indexerStatus", params: [] },
            ]);
            const res = await fetch(op.rpc, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
              return {
                name: op.name,
                region: op.region,
                rpc: op.rpc,
                ok: false as const,
                reason: `HTTP ${res.status}`,
                trustedGenesis,
                observedGenesis,
                quarantined,
                capabilities: null,
                indexerHeight: null,
                indexerLatest: null,
              };
            }
            const parsed = (await res.json()) as unknown;
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            const findRow = (id: number) =>
              arr.find(
                (r): r is { id: number; result?: unknown } =>
                  typeof r === "object" &&
                  r !== null &&
                  (r as { id?: unknown }).id === id,
              );
            const netRow = findRow(1) as
              | { id: number; result?: string }
              | undefined;
            const blockRow = findRow(2) as
              | { id: number; result?: string }
              | undefined;
            const capsRow = findRow(3);
            const indexerRow = findRow(4);
            const chainIdDec =
              typeof netRow?.result === "string" ? Number(netRow.result) : null;
            const blockHex =
              typeof blockRow?.result === "string" ? blockRow.result : null;
            // Parse capabilities defensively — operator may not support
            // the method (pre-uplift binary), in which case capsRow has
            // `error` instead of `result`.
            const capabilities = parseOperatorCapabilities(capsRow?.result);
            const indexerSnapshot = parseIndexerStatus(indexerRow?.result);
            return {
              name: op.name,
              region: op.region,
              rpc: op.rpc,
              ok: true as const,
              chainIdDec,
              blockHex,
              latencyMs: Date.now() - startedAt,
              trustedGenesis,
              observedGenesis,
              quarantined,
              capabilities,
              indexerHeight: indexerSnapshot.height,
              indexerLatest: indexerSnapshot.latest,
            };
          } catch (e) {
            clearTimeout(timer);
            return {
              name: op.name,
              region: op.region,
              rpc: op.rpc,
              ok: false as const,
              reason: (e as Error)?.name === "AbortError" ? "timeout" : "unreachable",
              trustedGenesis,
              observedGenesis,
              quarantined,
              capabilities: null,
              indexerHeight: null,
              indexerLatest: null,
            };
          }
        }),
      );
      return { ok: true, operators: results };
    }
    case "testnet-runtime-provenance": {
      // About-page runtime card. Calls `lyth_runtimeProvenance`
      // (SDK commit f67cf0e) via the existing operator-iteration path so
      // the genesis-pin trust check still applies. Returns a
      // subset of `RuntimeProvenanceResponse` — only fields the About
      // card renders. On chain-offline returns `{ ok: false, reason }`;
      // the About page falls back to a placeholder.
      try {
        const { result, via } = await testnetJsonRpc<{
          schemaVersion?: number;
          chainId?: number;
          latestHeight?: number;
          runtime?: {
            clientName?: string;
            version?: string;
            gitCommit?: string;
            gitDirty?: boolean;
            features?: string;
            p2pProtocolVersion?: number;
            buildTimestampUtc?: number;
          };
        }>("lyth_runtimeProvenance", []);
        const rt = result?.runtime;
        if (!rt || typeof rt !== "object") {
          return { ok: false, reason: "malformed lyth_runtimeProvenance response" };
        }
        return {
          ok: true,
          via,
          provenance: {
            clientName: typeof rt.clientName === "string" ? rt.clientName : "unknown",
            version: typeof rt.version === "string" ? rt.version : "unknown",
            gitCommit: typeof rt.gitCommit === "string" ? rt.gitCommit : "unknown",
            gitDirty: rt.gitDirty === true,
            features: typeof rt.features === "string" ? rt.features : "",
            p2pProtocolVersion:
              typeof rt.p2pProtocolVersion === "number" ? rt.p2pProtocolVersion : null,
            buildTimestampUtc:
              typeof rt.buildTimestampUtc === "number" ? rt.buildTimestampUtc : null,
            latestHeight:
              typeof result?.latestHeight === "number" ? result.latestHeight : null,
          },
        };
      } catch (e) {
        return {
          ok: false,
          reason: (e as Error)?.message ?? "lyth_runtimeProvenance unreachable",
        };
      }
    }
    case "testnet-operators-set": {
      // Payload: { operators: OperatorEntry[] | null }. Null clears the
      // override and reverts to defaults; non-null persists the override.
      // The chrome.storage.onChanged listener echoes the write and
      // invalidates cachedOperator so the next probe picks up the new
      // list immediately. Validation is run twice (here + onChanged
      // listener via loadOperatorOverride) so a malformed payload from
      // either path falls back to defaults rather than bricking RPC.
      const p = message.payload as { operators?: unknown } | undefined;
      const raw = p?.operators;
      if (raw === null) {
        await setOperatorOverride(null);
        cachedOperator = null;
        clearGenesisCache();
        return { ok: true };
      }
      const validated = validateOperatorList(raw);
      if (validated === null) {
        return { ok: false, reason: "invalid operator list" };
      }
      await setOperatorOverride(validated);
      cachedOperator = null;
      clearGenesisCache();
      return { ok: true };
    }
    case "probe-operator": {
      // Single-operator usability probe for the "Use this operator" button.
      // Forces a FRESH genesis verification for just this RPC (clears any
      // cached verdict so the user gets a current answer), then reports whether
      // it is reachable AND serving the pinned genesis — i.e. whether the RPC
      // dispatch loop would actually use it. Read-only: it writes NO override
      // (the popup reorders + saves only on a usable result), so it cannot
      // strand the user, and the genesis-pin orphan-fork defense is unchanged.
      const probe = message.payload as { rpc?: unknown } | undefined;
      const probeRpc = typeof probe?.rpc === "string" ? probe.rpc : "";
      if (probeRpc.length === 0) return { ok: false, usable: false };
      clearGenesisCache(probeRpc);
      const usable = await verifyOperatorGenesis(probeRpc, 2_500);
      return { ok: true, usable };
    }
    case "keystore-unlock": {
      const p = message.payload as { password: string };
      // v4 multi-vault container unlock. Rate limiting counts every
      // wrong-password attempt against the shared SESSION_KEY_UNLOCK_FAIL_COUNT.
      if (await hasContainerV4()) {
        const ses = await chrome.storage.session.get([
          SESSION_KEY_UNLOCK_FAIL_COUNT,
          SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
        ]);
        let failCount =
          typeof ses[SESSION_KEY_UNLOCK_FAIL_COUNT] === "number"
            ? (ses[SESSION_KEY_UNLOCK_FAIL_COUNT] as number)
            : 0;
        let lockoutUntil =
          typeof ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] === "number"
            ? (ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] as number)
            : 0;
        const now = Date.now();
        if (lockoutUntil > now) {
          return {
            ok: false,
            reason: "rate_limited",
            secondsRemaining: Math.ceil((lockoutUntil - now) / 1000),
            failCount,
          };
        }
        try {
          const r = await unlockContainerV4(p.password);
          await chrome.storage.session.remove([
            SESSION_KEY_UNLOCK_FAIL_COUNT,
            SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
          ]);
          await resetAutoLock();
          // Surface any unread that was HELD while locked
          // ("Unread badge while locked" off) now that the user unlocked.
          void refreshUnreadBadge({
            unlocked: true,
            activeAddrLower: getUnlockedAddressV4()?.toLowerCase() ?? null,
          });
          // CT-4 — tabs that loaded while the wallet was locked synced
          // accounts: [] (the announce state reply mirrors the eth_accounts
          // arm's locked behavior); tell connected origins the account is
          // available again. broadcastEvent scopes account-carrying events
          // to connected origins (T2-01). The lock direction is deliberately
          // NOT mirrored — locking has never emitted, and a dApp holding the
          // address of a now-locked wallet learns nothing new; revoke remains
          // the only path that retracts an address (T2-03).
          broadcastEvent("accountsChanged", [r.address]);
          return { ok: true, address: r.address };
        } catch {
          failCount += 1;
          const ms = lockoutMsFor(failCount);
          if (ms > 0) lockoutUntil = Date.now() + ms;
          await chrome.storage.session.set({
            [SESSION_KEY_UNLOCK_FAIL_COUNT]: failCount,
            [SESSION_KEY_UNLOCK_LOCKOUT_UNTIL]: lockoutUntil,
          });
          return {
            ok: false,
            reason: "wrong_password",
            failCount,
            secondsRemaining: ms > 0 ? Math.ceil(ms / 1000) : 0,
          };
        }
      }
      return { ok: false, reason: "no v4 vault — run onboarding first" };
    }
    case "keystore-lock": {
      await triggerAutoLock();
      return { ok: true };
    }
    case "keystore-create-from-mnemonic": {
      const p = message.payload as { password: string; mnemonic: string };
      // Defense-in-depth (#41): same SW-boundary password-floor re-validation
      // as keystore-create-new (see note there).
      if (typeof p?.password !== "string" || !isPasswordValid(p.password)) {
        return { ok: false, reason: "weak_password" };
      }
      try {
        const r = await createVaultFromMnemonic(p.password, p.mnemonic);
        await resetAutoLock();
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-export-seed": {
      // Re-auth path that returns the 24-word PQM-1 mnemonic for the
      // Settings → Show recovery phrase flow. Shares the unlock-attempt
      // session counters with keystore-unlock so wrong-password attempts
      // here count against the same brute-force lockout thresholds. v4
      // strict guarantees the mnemonic is always present, so there is
      // no "no_mnemonic_stored" branch — wrong password is the only
      // failure case beyond the rate limit.
      const p = message.payload as { password: string };
      const ses = await chrome.storage.session.get([
        SESSION_KEY_UNLOCK_FAIL_COUNT,
        SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
      ]);
      let failCount =
        typeof ses[SESSION_KEY_UNLOCK_FAIL_COUNT] === "number"
          ? (ses[SESSION_KEY_UNLOCK_FAIL_COUNT] as number)
          : 0;
      let lockoutUntil =
        typeof ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] === "number"
          ? (ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] as number)
          : 0;
      const now = Date.now();
      if (lockoutUntil > now) {
        return {
          ok: false,
          reason: "rate_limited",
          secondsRemaining: Math.ceil((lockoutUntil - now) / 1000),
          failCount,
        };
      }
      try {
        const r = await exportMnemonicV4(p.password);
        await chrome.storage.session.remove([
          SESSION_KEY_UNLOCK_FAIL_COUNT,
          SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
        ]);
        await resetAutoLock();
        return { ok: true, mnemonic: r.mnemonic };
      } catch {
        failCount += 1;
        const ms = lockoutMsFor(failCount);
        if (ms > 0) lockoutUntil = Date.now() + ms;
        await chrome.storage.session.set({
          [SESSION_KEY_UNLOCK_FAIL_COUNT]: failCount,
          [SESSION_KEY_UNLOCK_LOCKOUT_UNTIL]: lockoutUntil,
        });
        return {
          ok: false,
          reason: "wrong_password",
          failCount,
          secondsRemaining: ms > 0 ? Math.ceil(ms / 1000) : 0,
        };
      }
    }
    case "keystore-reset": {
      // Re-auth + destructive wipe path used by Settings → Reset wallet.
      // Same SESSION_KEY_UNLOCK_FAIL_COUNT/_UNTIL counters as
      // keystore-unlock — wrong-password attempts here count toward the
      // shared brute-force lockout window.
      const p = message.payload as { password: string };
      const ses = await chrome.storage.session.get([
        SESSION_KEY_UNLOCK_FAIL_COUNT,
        SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
      ]);
      let failCount =
        typeof ses[SESSION_KEY_UNLOCK_FAIL_COUNT] === "number"
          ? (ses[SESSION_KEY_UNLOCK_FAIL_COUNT] as number)
          : 0;
      let lockoutUntil =
        typeof ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] === "number"
          ? (ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] as number)
          : 0;
      const now = Date.now();
      if (lockoutUntil > now) {
        return {
          ok: false,
          reason: "rate_limited",
          secondsRemaining: Math.ceil((lockoutUntil - now) / 1000),
          failCount,
        };
      }
      try {
        await unlockContainerV4(p.password);
      } catch {
        failCount += 1;
        const ms = lockoutMsFor(failCount);
        if (ms > 0) lockoutUntil = Date.now() + ms;
        await chrome.storage.session.set({
          [SESSION_KEY_UNLOCK_FAIL_COUNT]: failCount,
          [SESSION_KEY_UNLOCK_LOCKOUT_UNTIL]: lockoutUntil,
        });
        return {
          ok: false,
          reason: "wrong_password",
          failCount,
          secondsRemaining: ms > 0 ? Math.ceil(ms / 1000) : 0,
        };
      }
      // Password verified — default-deny wipe of ALL persisted wallet state
      // (vault + container + every PII family + settings; S6 #43 B2), then
      // broadcast lock. Removing every mono.* local key — not just the two
      // vault entries — leaves no residue (address book, dApp grant graph,
      // tx-history caches) for the next profile user; clearing the in-session
      // grant set closes the connected-sites carryover.
      // Drop the connection graph first (belt-and-braces / codebase idiom),
      // THEN the default-deny scan removes its mono.connected-sites={} so no
      // empty-object residue survives the wipe.
      // F-B2V-1: run the in-memory teardown in a finally so a rejection of any
      // session/alarm await in this sequence can't skip it and leave the
      // decrypted ML-DSA backend + cached MEK live in the SW heap after the disk
      // is already wiped — restoring the rejection-proof guarantee pre-B2's
      // wipeVaultV4 gave for free (it ran lockV4 after a non-rejectable
      // callback-form remove). lockV4 is sync + idempotent, so triggerAutoLock's
      // own tail lockV4 stays a harmless no-op on the happy path.
      try {
        await clearAllConnectedSites();
        await wipeAllLocalWalletState();
        session.connectedOrigins.clear();
        await chrome.storage.session.remove([
          SESSION_KEY_UNLOCK_FAIL_COUNT,
          SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
        ]);
        await triggerAutoLock();
      } finally {
        lockV4();
      }
      // S6 closeout C2: clear the toolbar pip so a prior owner's unread COUNT
      // doesn't linger after the store is wiped (device-handoff #43). Best-
      // effort + guarded; the now-empty store resolves to an empty badge.
      void refreshUnreadBadge({ unlocked: false, activeAddrLower: null });
      return { ok: true };
    }
    case "keystore-wipe-unauth": {
      // No-re-auth wipe used by the Welcome → Forgot password? path: the
      // user has no password to enter, so the security boundary is the
      // 24-word recovery phrase (which is what restores funds elsewhere).
      // Throttled to one call per 5 s to make accidental rapid-fire harmless.
      const ses = await chrome.storage.session.get(
        SESSION_KEY_LAST_WIPE_UNAUTH_AT,
      );
      const last =
        typeof ses[SESSION_KEY_LAST_WIPE_UNAUTH_AT] === "number"
          ? (ses[SESSION_KEY_LAST_WIPE_UNAUTH_AT] as number)
          : 0;
      const now = Date.now();
      if (now - last < WIPE_UNAUTH_RATE_LIMIT_MS) {
        return { ok: false, reason: "rate_limited" };
      }
      await chrome.storage.session.set({
        [SESSION_KEY_LAST_WIPE_UNAUTH_AT]: now,
      });
      // Same default-deny wipe as keystore-reset (S6 #43 B2): every mono.*
      // local key + the in-session grant set. Forgot-password is the
      // lost-control path, so it must wipe at least as much as the re-auth
      // path — identical scope; no recoverable key material or PII residue.
      // Drop the connection graph first (belt-and-braces / codebase idiom),
      // THEN the default-deny scan removes its mono.connected-sites={} so no
      // empty-object residue survives the wipe.
      // F-B2V-1: run the in-memory teardown in a finally so a rejection of any
      // session/alarm await in this sequence can't skip it and leave the
      // decrypted ML-DSA backend + cached MEK live in the SW heap after the disk
      // is already wiped — restoring the rejection-proof guarantee pre-B2's
      // wipeVaultV4 gave for free (it ran lockV4 after a non-rejectable
      // callback-form remove). lockV4 is sync + idempotent, so triggerAutoLock's
      // own tail lockV4 stays a harmless no-op on the happy path.
      try {
        await clearAllConnectedSites();
        await wipeAllLocalWalletState();
        session.connectedOrigins.clear();
        await chrome.storage.session.remove([
          SESSION_KEY_UNLOCK_FAIL_COUNT,
          SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
        ]);
        await triggerAutoLock();
      } finally {
        lockV4();
      }
      // S6 closeout C2: clear the toolbar pip so a prior owner's unread COUNT
      // doesn't linger after the store is wiped (device-handoff #43). Best-
      // effort + guarded; the now-empty store resolves to an empty badge.
      void refreshUnreadBadge({ unlocked: false, activeAddrLower: null });
      return { ok: true };
    }
    case "vault-list": {
      // No unlock required — labels and addresses are non-sensitive
      // metadata (the encrypted seed lives in each vault's per-vault
      // envelope, not in the summary surface). Returns an empty array
      // (NOT null) when no container exists yet so the popup can
      // render "no vaults" uniformly without a null branch.
      try {
        const vaults = await listVaultsV4();
        return { ok: true, vaults: vaults ?? [] };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-select": {
      const p = message.payload as { vaultId?: string };
      if (typeof p?.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const r = await selectActiveVaultV4(p.vaultId);
        await resetAutoLock();
        // EIP-1193 contract: accountsChanged broadcast on active-
        // account change. Connected dApps re-fetch state with the
        // new address; unconnected tabs receive the event and drop it
        // (same pattern as the eth_requestAccounts broadcast).
        broadcastEvent("accountsChanged", [r.address]);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-rename": {
      const p = message.payload as { vaultId?: string; label?: string };
      if (typeof p?.vaultId !== "string" || typeof p?.label !== "string") {
        return { ok: false, reason: "missing vaultId or label" };
      }
      try {
        await renameVaultV4(p.vaultId, p.label);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-add-fresh": {
      // Requires an unlocked container (MEK cached). Generates a fresh
      // PQM-1 mnemonic and appends a new VaultRecordV4. Auto-switches
      // the active vault to the newly-created one (the
      // previous design left active unchanged and required a separate
      // `vault-select`; the popup didn't, so users saw the old vault's
      // address persist after creating a new one). `accountsChanged`
      // broadcast below refreshes dApps + popup state.
      //
      // `label` is optional; the keystore helper validates 1-32 chars
      // when supplied and falls back to its own "Vault N" auto-label
      // otherwise. VaultAddModal threads a
      // user-edited label through this slot.
      const p = (message.payload ?? {}) as { label?: string };
      const label = typeof p.label === "string" ? p.label : undefined;
      try {
        const r = await addVaultFreshV4(label);
        await resetAutoLock();
        broadcastEvent("accountsChanged", [r.address]);
        return {
          ok: true,
          vaultId: r.vaultId,
          mnemonic: r.mnemonic,
          address: r.address,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-generate-fresh-mnemonic": {
      // Ephemeral mnemonic generation for the in-app
      // multi-step new-wallet flow. Returns the mnemonic WITHOUT
      // persisting any vault; the popup holds it in React state for
      // the show-phrase + verify-phrase steps and commits via
      // `vault-add-import` only after the user verifies the phrase.
      // Cancellation in the popup discards the mnemonic with no
      // chain-storage side-effects.
      try {
        const mnemonic = generateFreshMnemonicV4();
        return { ok: true, mnemonic };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-add-import": {
      const p = message.payload as { mnemonic?: string; label?: string };
      if (typeof p?.mnemonic !== "string") {
        return { ok: false, reason: "missing mnemonic" };
      }
      const label = typeof p.label === "string" ? p.label : undefined;
      try {
        const r = await addVaultImportV4(p.mnemonic, label);
        await resetAutoLock();
        broadcastEvent("accountsChanged", [r.address]);
        return { ok: true, vaultId: r.vaultId, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-add-multisig": {
      // Create a multisig vault inside the
      // container. Requires an unlocked container (MEK cached). The
      // caller passes the N signer pubkeys + threshold + optional
      // label; the keystore helper validates the roster + threshold,
      // generates the multisig vault's own ML-DSA-65 keypair, and
      // returns the new vault id + executor mnemonic + address.
      //
      // The mnemonic returned is the recovery secret for the
      // *multisig vault itself* (the keypair that submits executed
      // proposals on-chain) — NOT for any of the signers. Treat it
      // like a single-vault mnemonic; the popup surfaces it in the
      // same backup-checkbox reveal step.
      const p = (message.payload ?? {}) as {
        signers?: unknown;
        threshold?: unknown;
        label?: unknown;
      };
      if (!Array.isArray(p.signers)) {
        return { ok: false, reason: "missing signers array" };
      }
      if (typeof p.threshold !== "number") {
        return { ok: false, reason: "missing threshold" };
      }
      const label = typeof p.label === "string" ? p.label : undefined;
      try {
        const r = await addVaultMultisigV4({
          signers: p.signers as Parameters<typeof addVaultMultisigV4>[0]["signers"],
          threshold: p.threshold,
          ...(label !== undefined ? { label } : {}),
        });
        await resetAutoLock();
        broadcastEvent("accountsChanged", [r.address]);
        return {
          ok: true,
          vaultId: r.vaultId,
          mnemonic: r.mnemonic,
          address: r.address,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-pubkey": {
      // Read a vault's 1952-byte ML-DSA-65 pubkey
      // as 0x-prefixed hex. Requires unlocked container; used by the
      // MultisigCreateModal to populate self-signer entries without
      // forcing the user to switch the active vault.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const pubkey = await getVaultPubkeyV4(p.vaultId);
        return { ok: true, pubkey };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-multisig-meta": {
      // Read the multisig meta (signer roster + threshold + queues)
      // for a specific vault. Returns `meta: null` when the target is
      // a single-key vault or unknown — the popup branches on that
      // signal rather than treating absence as an error. No unlock
      // required: signer pubkeys + proposal payloads are intentionally
      // non-secret (only the multisig vault's seed lives in the
      // encrypted envelope).
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        return { ok: true, meta };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-propose": {
      // Create a tx proposal inside a multisig
      // vault's meta. The proposer is the first self-signer in the
      // roster (a picker is shown when multiple self-signers
      // exist). The proposer's vault key signs the canonical
      // proposal hash; the signature lands in `approvals[0]` so the
      // M-of-N count is honest from creation.
      //
      // Container must be unlocked (cached MEK). Returns the new
      // proposal id + the proposer's signer id (so the popup can
      // mark the row as "you approved" immediately).
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        action?: ProposalAction;
      };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      if (!p.action || typeof p.action !== "object") {
        return { ok: false, reason: "missing action" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposer = pickFirstSelfSigner(meta.signers);
        if (!proposer) {
          return {
            ok: false,
            reason:
              "no local signer available to propose — at least one " +
              "self-signer must live in this container",
          };
        }
        // Resolve the multisig vault's address — used as the
        // vaultAddress field on the proposal record so hashes bind
        // to the right vault.
        const summaries = (await listVaultsV4()) ?? [];
        const target = summaries.find((v) => v.id === p.vaultId);
        if (!target) {
          return { ok: false, reason: "unknown vault id" };
        }
        const now = Date.now();
        const proposal: PendingProposal = {
          id: crypto.randomUUID(),
          proposedBy: proposer.id,
          createdAt: now,
          expiresAt: now + DEFAULT_TX_PROPOSAL_TTL_MS,
          vaultAddress: target.addr,
          action: p.action,
          approvals: [],
          rejections: [],
          status: "pending",
          txHash: null,
        };
        const digest = hashTxProposal(proposal);
        const sigBytes = await signWithVaultV4(proposer.vaultId!, digest);
        const approval: ProposalSignature = {
          signerId: proposer.id,
          signature: "0x" + bytesToHex(sigBytes),
          signedAt: now,
        };
        proposal.approvals.push(approval);
        meta.proposals = [proposal, ...meta.proposals];
        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          proposalId: proposal.id,
          proposerId: proposer.id,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-sign":
    case "multisig-reject": {
      // Add this wallet's signature to a pending
      // proposal as either approval (`multisig-sign`) or rejection
      // (`multisig-reject`). The signer is the first local self-
      // signer who has NOT already voted on this proposal; v1
      // assumes a one-vote-per-self-signer model. Requires unlocked
      // container.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        proposalId?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.proposalId !== "string") {
        return { ok: false, reason: "missing vaultId or proposalId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposal = meta.proposals.find((pp) => pp.id === p.proposalId);
        if (!proposal) {
          return { ok: false, reason: "unknown proposal" };
        }
        const now = Date.now();
        const status = reconcileProposalStatus(proposal, meta.threshold, now);
        if (status !== "pending") {
          return {
            ok: false,
            reason: `proposal is ${status}; cannot vote`,
          };
        }
        const approvedIds = new Set(proposal.approvals.map((a) => a.signerId));
        const rejectedIds = new Set(proposal.rejections.map((a) => a.signerId));
        const voter = pickNextLocalVoter(
          meta.signers,
          approvedIds,
          rejectedIds,
        );
        if (!voter) {
          return {
            ok: false,
            reason:
              "no local signer is eligible to vote — either every " +
              "local signer has already voted, or this vault has no " +
              "self-signers in the container",
          };
        }
        const digest = hashTxProposal(proposal);
        const sigBytes = await signWithVaultV4(voter.vaultId!, digest);
        const signature: ProposalSignature = {
          signerId: voter.id,
          signature: "0x" + bytesToHex(sigBytes),
          signedAt: now,
        };
        if (message.op === "multisig-sign") {
          proposal.approvals.push(signature);
        } else {
          proposal.rejections.push(signature);
          // Re-derive status post-rejection — may flip the proposal
          // to "rejected" if this vote crosses the threshold.
          proposal.status = reconcileProposalStatus(
            proposal,
            meta.threshold,
            now,
          );
        }
        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          signerId: voter.id,
          status: proposal.status,
          approvals: proposal.approvals.length,
          rejections: proposal.rejections.length,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-execute": {
      // Broadcast a proposal that has collected
      // its threshold of approvals. The submitter is the multisig
      // vault's own keypair (the "executor"). The proposal's
      // approvals[] array is the off-chain audit trail; the chain
      // only verifies the single executor signature today
      // (chain GAP — see shared/multisig.ts).
      //
      // Side effect: temporarily switches the active vault to the
      // multisig vault for the duration of the submit, then restores
      // the previous active vault. The wallet broadcasts
      // `accountsChanged` twice as a side effect; connected dApps
      // observe a flip-back to the same address they had before, so
      // the visible state is unchanged.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        proposalId?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.proposalId !== "string") {
        return { ok: false, reason: "missing vaultId or proposalId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposal = meta.proposals.find((pp) => pp.id === p.proposalId);
        if (!proposal) {
          return { ok: false, reason: "unknown proposal" };
        }
        const now = Date.now();
        if (!isExecutable(proposal, meta.threshold, now)) {
          return {
            ok: false,
            reason:
              `proposal not executable: status=${proposal.status}, ` +
              `${proposal.approvals.length}/${meta.threshold} approvals, ` +
              `${proposal.rejections.length} rejections, ` +
              `expires ${new Date(proposal.expiresAt).toISOString()}`,
          };
        }
        // T3-03 — re-verify the collected approval SIGNATURES against the LIVE
        // action digest before executing — not just the approvals[] COUNT.
        // isExecutable only checks length; a local executor who edited
        // proposal.action after collecting approvals would pass it, but the
        // stored signatures (over the original action's digest) no longer cover
        // the tampered action. verifyProposalApprovals re-hashes the live action
        // and counts only signatures that still verify. Fail closed.
        const { validApprovals } = verifyProposalApprovals(proposal, meta.signers);
        if (validApprovals.size < meta.threshold) {
          return {
            ok: false,
            reason:
              `approval signatures do not verify against the action: ` +
              `${validApprovals.size}/${meta.threshold} valid ` +
              `(of ${proposal.approvals.length} recorded)`,
          };
        }
        // Capture the current active vault so we can restore it
        // after broadcasting via the multisig's keypair. Skipping
        // the restore would silently change which vault the popup
        // is "looking at" — confusing UX.
        const before = (await listVaultsV4()) ?? [];
        const previouslyActive = before.find((v) => v.isActive);

        // Switch to the multisig vault so submitPlaintextMlDsaTx
        // uses the multisig's keypair as the "from" account; then
        // restore the prior active vault on exit. accountsChanged
        // broadcasts cover both transitions so connected dApps see
        // the round-trip.
        await selectActiveVaultV4(p.vaultId);
        broadcastEvent("accountsChanged", [
          before.find((v) => v.id === p.vaultId)?.addr ?? "",
        ]);
        const action = proposal.action;
        const fromAddr = getUnlockedAddressV4();
        if (!fromAddr) {
          if (previouslyActive && previouslyActive.id !== p.vaultId) {
            await selectActiveVaultV4(previouslyActive.id);
            broadcastEvent("accountsChanged", [previouslyActive.addr]);
          }
          return { ok: false, reason: "multisig vault has no unlocked address" };
        }
        let txHash: string | null = null;
        let broadcastError: string | null = null;
        try {
          const nonceHex = await testnetTransactionCountHex(fromAddr);
          const fee = await suggestFee(action.chainIdHex);
          const gasHex =
            action.gasLimitHex ?? fee.gasLimit ?? TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX;
          const valueWeiHex =
            action.kind === "send"
              ? action.valueWeiHex
              : action.valueWeiHex ?? "0x0";
          const data = action.kind === "contract" ? action.data : action.data;
          // T4-04 (Item D) parity: clamp the operator-quoted per-execution-unit
          // price to the sane de-trust ceiling before signing, exactly like the
          // four other fee-bearing send paths (eth_sendTransaction, the two MRV
          // rails, and wallet-send-tx :8806). The multisig-execute fee is fetched
          // fresh from the first-responding operator at execute time with no
          // human-in-the-loop review, so a malicious/MITM operator could otherwise
          // inflate the signed maxFeePerGas without bound. The 1e15 ceiling is a
          // no-op for legitimate fees (~1e9-1e10/unit) so there is no stuck-tx
          // risk; the tip is re-clamped to <= max so the two stay consistent (a
          // tip above the cap is rejected chain-side).
          const maxFeePerGas =
            "0x" +
            clampToSaneBound(
              BigInt(fee.maxFeePerGas),
              MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
            ).toString(16);
          const maxPriorityFeePerGas = clampPriorityTipToMaxFee(
            fee.maxPriorityFeePerGas,
            maxFeePerGas,
          );
          // NN-01: bind to the INTENDED multisig target (p.vaultId). The
          // handler did selectActiveVaultV4(p.vaultId) above, so active ==
          // p.vaultId and the assert passes on the sanctioned path; an
          // UNINTENDED swap during the nonce/fee awaits aborts (caught below,
          // finally restores the prior vault).
          const r = await submitMlDsaTx({
            to: action.to,
            value: valueWeiHex,
            ...(data !== undefined ? { data } : {}),
            gas: gasHex,
            nonce: nonceHex,
            maxFeePerGas,
            maxPriorityFeePerGas,
            chainIdHex: action.chainIdHex,
          }, p.vaultId);
          txHash = r.txHash;
        } catch (e) {
          broadcastError = (e as Error).message ?? "send failed";
        } finally {
          if (previouslyActive && previouslyActive.id !== p.vaultId) {
            await selectActiveVaultV4(previouslyActive.id);
            broadcastEvent("accountsChanged", [previouslyActive.addr]);
          }
        }
        if (broadcastError) {
          return { ok: false, reason: broadcastError };
        }
        if (txHash) {
          // Re-read meta in case the active-vault swap raced with
          // another mutation; defensive but cheap.
          const freshMeta = await readMultisigMetaV4(p.vaultId);
          if (freshMeta) {
            const target = freshMeta.proposals.find(
              (pp) => pp.id === p.proposalId,
            );
            if (target) {
              target.status = "executed";
              target.txHash = txHash;
              await writeMultisigMetaV4(p.vaultId, freshMeta);
            }
          }
        }
        await resetAutoLock();
        return { ok: true, txHash };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-propose-governance": {
      // Propose a signer-set change (add /
      // remove / replace) or a threshold change. Same M-of-current-
      // signers approval rule as tx proposals, but lives in a
      // separate queue (meta.governance) with a longer TTL and
      // distinct hash domain. The first local self-signer signs as
      // proposer; their signature lands in approvals[0].
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        action?: GovernanceAction;
      };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      if (!p.action || typeof p.action !== "object") {
        return { ok: false, reason: "missing action" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        // Dry-run the action against current state — surfaces "would
        // leave roster below threshold", "unknown signerId", etc.
        // BEFORE the proposal is persisted, so the user sees the
        // rejection inline rather than discovering it at execute time.
        applyGovernance(
          meta.signers,
          meta.threshold,
          p.action,
          () => "dry-run",
        );
        const proposer = pickFirstSelfSigner(meta.signers);
        if (!proposer) {
          return {
            ok: false,
            reason:
              "no local signer available to propose — at least one " +
              "self-signer must live in this container",
          };
        }
        const summaries = (await listVaultsV4()) ?? [];
        const target = summaries.find((v) => v.id === p.vaultId);
        if (!target) {
          return { ok: false, reason: "unknown vault id" };
        }
        const now = Date.now();
        const proposal: GovernanceProposal = {
          id: crypto.randomUUID(),
          proposedBy: proposer.id,
          createdAt: now,
          expiresAt: now + DEFAULT_GOV_PROPOSAL_TTL_MS,
          vaultAddress: target.addr,
          action: p.action,
          approvals: [],
          rejections: [],
          status: "pending",
        };
        const digest = hashGovernanceProposal(proposal);
        const sigBytes = await signWithVaultV4(proposer.vaultId!, digest);
        proposal.approvals.push({
          signerId: proposer.id,
          signature: "0x" + bytesToHex(sigBytes),
          signedAt: now,
        });
        meta.governance = [proposal, ...meta.governance];
        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          proposalId: proposal.id,
          proposerId: proposer.id,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-sign-governance":
    case "multisig-reject-governance": {
      // Approve/reject a governance proposal. Same shape as the tx
      // sign/reject path but operates on meta.governance + the
      // governance hash domain. Body intentionally mirrors the tx
      // sign/reject handler so future extensions (e.g. multi-signer
      // picker) can be lifted once.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        proposalId?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.proposalId !== "string") {
        return { ok: false, reason: "missing vaultId or proposalId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposal = meta.governance.find((g) => g.id === p.proposalId);
        if (!proposal) {
          return { ok: false, reason: "unknown governance proposal" };
        }
        const now = Date.now();
        const status = reconcileGovernanceStatus(
          proposal,
          meta.threshold,
          now,
        );
        if (status !== "pending") {
          return {
            ok: false,
            reason: `proposal is ${status}; cannot vote`,
          };
        }
        const approvedIds = new Set(proposal.approvals.map((a) => a.signerId));
        const rejectedIds = new Set(proposal.rejections.map((a) => a.signerId));
        const voter = pickNextLocalVoter(
          meta.signers,
          approvedIds,
          rejectedIds,
        );
        if (!voter) {
          return {
            ok: false,
            reason:
              "no local signer is eligible to vote — either every " +
              "local signer has already voted, or this vault has no " +
              "self-signers in the container",
          };
        }
        const digest = hashGovernanceProposal(proposal);
        const sigBytes = await signWithVaultV4(voter.vaultId!, digest);
        const signature: ProposalSignature = {
          signerId: voter.id,
          signature: "0x" + bytesToHex(sigBytes),
          signedAt: now,
        };
        if (message.op === "multisig-sign-governance") {
          proposal.approvals.push(signature);
        } else {
          proposal.rejections.push(signature);
          proposal.status = reconcileGovernanceStatus(
            proposal,
            meta.threshold,
            now,
          );
        }
        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          signerId: voter.id,
          status: proposal.status,
          approvals: proposal.approvals.length,
          rejections: proposal.rejections.length,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-export-proposal": {
      // Serialize a proposal (tx or governance)
      // into a base64-encoded JSON blob suitable for out-of-band
      // sharing (paste into chat / email / QR code). The blob carries
      // the full proposal record including current approvals/
      // rejections so the recipient can merge without losing
      // signatures already collected.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        proposalId?: string;
        kind?: "tx" | "gov";
      };
      if (
        typeof p.vaultId !== "string" ||
        typeof p.proposalId !== "string" ||
        (p.kind !== "tx" && p.kind !== "gov")
      ) {
        return {
          ok: false,
          reason: "missing vaultId / proposalId / kind",
        };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposal =
          p.kind === "tx"
            ? meta.proposals.find((pp) => pp.id === p.proposalId)
            : meta.governance.find((g) => g.id === p.proposalId);
        if (!proposal) {
          return { ok: false, reason: "unknown proposal" };
        }
        const blob = serializeProposalForShare(proposal, p.kind);
        return { ok: true, blob };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-import-proposal": {
      // Accept a base64 blob from another signer's
      // wallet. Verifies every signature in the incoming proposal
      // against the local signer roster (pubkeys + hashTxProposal /
      // hashGovernanceProposal). If the proposal id already exists
      // locally, merge approvals/rejections (dedupe by signerId,
      // first-wins). If new, append after running the same signature
      // verification + structural check.
      //
      // Returns the merged proposal id + status; the popup refreshes
      // its meta-read and the UI updates uniformly.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        blob?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.blob !== "string") {
        return { ok: false, reason: "missing vaultId or blob" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const envelope = deserializeSharedProposal(p.blob);

        if (envelope.kind === "tx") {
          const incoming = envelope.proposal as PendingProposal;
          // Vault binding: the incoming proposal must reference this
          // multisig vault. Otherwise an attacker could craft a
          // proposal for a different vault that this signer hasn't
          // opted into.
          if (
            incoming.vaultAddress.toLowerCase() !==
            (await listVaultsV4())
              ?.find((v) => v.id === p.vaultId)
              ?.addr.toLowerCase()
          ) {
            return {
              ok: false,
              reason: "imported proposal targets a different vault address",
            };
          }
          const existing = meta.proposals.find((pp) => pp.id === incoming.id);
          if (existing) {
            const merged = mergeProposalSignatures(
              existing,
              incoming,
              meta.signers,
            );
            meta.proposals = meta.proposals.map((pp) =>
              pp.id === merged.id ? merged : pp,
            );
          } else {
            // Brand-new proposal — drop any signatures whose pubkeys
            // don't match the local roster (defense-in-depth; the
            // merge path applies the same filter).
            const verified = verifyProposalApprovals(incoming, meta.signers);
            const sanitized: PendingProposal = {
              ...incoming,
              approvals: incoming.approvals.filter((a) =>
                verified.validApprovals.has(a.signerId),
              ),
              rejections: incoming.rejections.filter((r) =>
                verified.validRejections.has(r.signerId),
              ),
            };
            meta.proposals = [sanitized, ...meta.proposals];
          }
        } else {
          const incoming = envelope.proposal as GovernanceProposal;
          if (
            incoming.vaultAddress.toLowerCase() !==
            (await listVaultsV4())
              ?.find((v) => v.id === p.vaultId)
              ?.addr.toLowerCase()
          ) {
            return {
              ok: false,
              reason: "imported proposal targets a different vault address",
            };
          }
          const existing = meta.governance.find((g) => g.id === incoming.id);
          if (existing) {
            const merged = mergeGovernanceSignatures(
              existing,
              incoming,
              meta.signers,
            );
            meta.governance = meta.governance.map((g) =>
              g.id === merged.id ? merged : g,
            );
          } else {
            const verified = verifyGovernanceApprovals(
              incoming,
              meta.signers,
            );
            const sanitized: GovernanceProposal = {
              ...incoming,
              approvals: incoming.approvals.filter((a) =>
                verified.validApprovals.has(a.signerId),
              ),
              rejections: incoming.rejections.filter((r) =>
                verified.validRejections.has(r.signerId),
              ),
            };
            meta.governance = [sanitized, ...meta.governance];
          }
        }

        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          kind: envelope.kind,
          proposalId: envelope.proposal.id,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-execute-governance": {
      // Apply the governance action atomically: re-run applyGovernance
      // against the current (signers, threshold), persist the result,
      // mark the proposal as "applied". No on-chain interaction —
      // governance lives entirely in the wallet's meta block.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        proposalId?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.proposalId !== "string") {
        return { ok: false, reason: "missing vaultId or proposalId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        if (!meta) {
          return {
            ok: false,
            reason: "target vault is not a multisig vault",
          };
        }
        const proposal = meta.governance.find((g) => g.id === p.proposalId);
        if (!proposal) {
          return { ok: false, reason: "unknown governance proposal" };
        }
        const now = Date.now();
        if (!isGovernanceExecutable(proposal, meta.threshold, now)) {
          return {
            ok: false,
            reason:
              `governance proposal not executable: status=${proposal.status}, ` +
              `${proposal.approvals.length}/${meta.threshold} approvals, ` +
              `${proposal.rejections.length} rejections`,
          };
        }
        const next = applyGovernance(
          meta.signers,
          meta.threshold,
          proposal.action,
          () => crypto.randomUUID(),
        );
        meta.signers = next.signers;
        meta.threshold = next.threshold;
        proposal.status = "applied";
        await writeMultisigMetaV4(p.vaultId, meta);
        await resetAutoLock();
        return {
          ok: true,
          signers: meta.signers.length,
          threshold: meta.threshold,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    // ────────────────────────────────────────────────────────────────
    // Passkey IPCs (§28.5 Q30 + Q31)
    // ────────────────────────────────────────────────────────────────
    case "passkey-get-state": {
      // Read the per-vault passkey state — credentials + policy.
      // No unlock required: the popup uses this to render Settings →
      // Security and the Send-flow signing-mode badge whether or not
      // the user is currently unlocked. The credential IDs are public
      // (the actual secret lives in the browser's authenticator), and
      // the policy thresholds aren't sensitive.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const state = await readPasskeyStateV4(p.vaultId);
        return {
          ok: true,
          state: serializePasskeyState(state),
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "passkey-add-credential": {
      // Persist a freshly-registered credential. The popup ran the
      // WebAuthn `.create()` call (only possible in the popup window
      // context per MV3 rules) and forwards the resulting credentialId
      // + user-edited name + authenticator kind here. The wallet never
      // sees the private key material — that lives inside the
      // browser's authenticator.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        credential?: unknown;
      };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      const cred = parsePasskeyCredential(p.credential);
      if (!cred) {
        return { ok: false, reason: "invalid credential shape" };
      }
      if (!validateCredentialName(cred.name)) {
        return { ok: false, reason: "invalid credential name" };
      }
      try {
        const state = await addPasskeyCredentialV4(p.vaultId, cred);
        return { ok: true, state: serializePasskeyState(state) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "passkey-remove-credential": {
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        credentialId?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.credentialId !== "string") {
        return { ok: false, reason: "missing vaultId or credentialId" };
      }
      try {
        const state = await removePasskeyCredentialV4(
          p.vaultId,
          p.credentialId,
        );
        return { ok: true, state: serializePasskeyState(state) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "passkey-evaluate": {
      // Send-flow consults this before showing the preview screen.
      // Returns a decision the popup uses to pick the unlock-mode
      // badge + whether to run a passkey ceremony before submit.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        valueWeiHex?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.valueWeiHex !== "string") {
        return { ok: false, reason: "missing vaultId or valueWeiHex" };
      }
      let valueLythoshi: bigint;
      try {
        valueLythoshi = BigInt(p.valueWeiHex);
      } catch {
        return { ok: false, reason: "valueWeiHex is not a hex bigint" };
      }
      try {
        const state = await readPasskeyStateV4(p.vaultId);
        const usage = await readPasskeyUsageEntries(p.vaultId);
        const decision = evaluatePasskeyPolicy({
          state,
          valueWei: valueLythoshi,
          recentUsage: usage,
          now: Date.now(),
        });
        // Encode the decision for the wire — `bigint` doesn't survive
        // structured-clone serialisation across the runtime.sendMessage
        // boundary in some browser builds.
        if (decision.kind === "over-limit") {
          return {
            ok: true,
            decision: {
              kind: "over-limit" as const,
              mode: decision.mode,
              thresholdWeiHex: "0x" + decision.threshold.toString(16),
              attemptedWeiHex: "0x" + decision.attempted.toString(16),
            },
          };
        }
        if (decision.kind === "passkey-ok") {
          // Surface the active credentials so the popup can build the
          // `allowCredentials[]` list for `navigator.credentials.get()`
          // without a second round-trip.
          return {
            ok: true,
            decision: {
              kind: "passkey-ok" as const,
              credentials: state.credentials.map((c) => ({ ...c })),
            },
          };
        }
        return {
          ok: true,
          decision: {
            kind: "password-required" as const,
            reason: decision.reason,
          },
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "passkey-record-usage": {
      // Append a compatibility-shaped `{at, valueWei}` entry containing
      // lythoshi to the in-memory daily-cap ledger. Popup calls this after
      // a successful passkey-unlocked tx submit. Prune-on-read keeps the
      // list bounded — no explicit GC required.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        valueWeiHex?: string;
      };
      if (typeof p.vaultId !== "string" || typeof p.valueWeiHex !== "string") {
        return { ok: false, reason: "missing vaultId or valueWeiHex" };
      }
      let valueLythoshi: bigint;
      try {
        valueLythoshi = BigInt(p.valueWeiHex);
      } catch {
        return { ok: false, reason: "valueWeiHex is not a hex bigint" };
      }
      await recordPasskeyUsageEntry(p.vaultId, valueLythoshi);
      return { ok: true };
    }
    case "passkey-set-policy": {
      // Replace the policy atomically. The wallet now enforces the
      // resulting per-tx/daily cap LOCALLY at the SW signing boundary
      // (wallet-send-tx) for value-only transfers as defense-in-depth: an
      // over-limit send requires an SW-VERIFIED password re-auth. This is
      // NOT cryptographic passkey authorization, and there is NO chain-side
      // enforcement until the chain ships a passkey precompile — see the
      // chain-GAP note in shared/passkey.ts. The validator inside the shared
      // module rejects bogus inputs; bad payloads round-trip a typed reason.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        policy?: unknown;
      };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      const policy = parsePasskeyPolicy(p.policy);
      if (!policy) {
        return { ok: false, reason: "invalid policy shape" };
      }
      const validationError = validatePasskeyPolicy(policy);
      if (validationError) {
        return { ok: false, reason: `invalid policy: ${validationError}` };
      }
      try {
        const state = await setPasskeyPolicyV4(p.vaultId, policy);
        return { ok: true, state: serializePasskeyState(state) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    // ────────────────────────────────────────────────────────────────
    // Two-tier UX feature toggle IPCs (§28.5 Q29)
    // ────────────────────────────────────────────────────────────────
    case "two-tier-get-state": {
      try {
        const state = await loadTwoTierState();
        return { ok: true, state };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    // (The two-tier feature WRITE is applied popup-side now — see bg.ts
    // `bgTwoTierSetFeature`. It writes chrome.storage.local directly so a
    // toggle flips instantly without an MV3 cold-wake; the SW had no side
    // effect on a flag change, so no IPC is needed. The read above stays.)
    // ────────────────────────────────────────────────────────────────
    // SLH-DSA emergency-backup IPCs (§30.1)
    // ────────────────────────────────────────────────────────────────
    case "slh-dsa-backup-get": {
      // Returns the persisted backup record for the target vault, or
      // `null` if no backup is configured. The record is plain JSON
      // (no BigInt, no Uint8Array), so it round-trips through
      // chrome.runtime.sendMessage natively.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const backup = await readSlhDsaBackupV4(p.vaultId);
        return { ok: true, backup };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-generate": {
      // Generates a fresh SLH-DSA backup keypair, persists the
      // record (with `coldStorageConfirmed: false`), and returns
      // the 24-word mnemonic for the popup's reveal modal. The
      // mnemonic is the ONLY field the popup needs that isn't
      // recoverable from chrome.storage — it surfaces once for
      // the user to write down, and the popup holds it in memory
      // only for the duration of the reveal flow.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const { mnemonic, backup } = await generateSlhDsaBackupV4(p.vaultId);
        await resetAutoLock();
        return { ok: true, mnemonic, backup };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-recover-mnemonic": {
      // Re-export flow. Requires the container to
      // be unlocked. Decrypts the stored entropy slot + re-derives
      // the 24-word mnemonic. The wallet does not regenerate the
      // keypair — the same pubkey + secret + chain-registration
      // status are preserved.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const mnemonic = await recoverSlhDsaMnemonicV4(p.vaultId);
        await resetAutoLock();
        return { ok: true, mnemonic };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-confirm-cold-storage": {
      // Flips `coldStorageConfirmed` to `true` after the user
      // attests via the reveal modal's checkbox. Idempotent —
      // calling on an already-confirmed record is a no-op.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const backup = await confirmSlhDsaColdStorageV4(p.vaultId);
        return { ok: true, backup };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-set-registration-status": {
      // Update a backup record's chain-registration lifecycle
      // atomically. The popup orchestrates the actual tx
      // submission via the existing `wallet-send-tx` IPC + this
      // status update IPC, so the SW doesn't need to know about
      // the calldata-building seam.
      const p = (message.payload ?? {}) as {
        vaultId?: string;
        status?: string;
        txHash?: string | null;
        block?: number | null;
        error?: string | null;
      };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      const validStatuses = new Set([
        "not-registered",
        "pending",
        "registered",
        "registration-failed",
      ]);
      if (typeof p.status !== "string" || !validStatuses.has(p.status)) {
        return { ok: false, reason: "invalid status" };
      }
      try {
        const backup = await setSlhDsaRegistrationStatusV4(p.vaultId, {
          status: p.status as
            | "not-registered"
            | "pending"
            | "registered"
            | "registration-failed",
          ...(p.txHash !== undefined ? { txHash: p.txHash } : {}),
          ...(p.block !== undefined ? { block: p.block } : {}),
          ...(p.error !== undefined ? { error: p.error } : {}),
        });
        await resetAutoLock();
        return { ok: true, backup };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-poll-receipt": {
      // Light wrapper around `eth_getTransactionReceipt` used by the
      // Settings → Security page to flip a `pending`
      // backup to `registered` (status=0x1) or `registration-failed`
      // (status=0x0) once a registration tx lands. Returns the
      // receipt's `status` + `blockNumber` if available, or `null`
      // if the tx is still pending. The caller flips the backup
      // record itself via `slh-dsa-backup-set-registration-status`
      // — this IPC is read-only.
      const p = (message.payload ?? {}) as { txHash?: string };
      if (typeof p.txHash !== "string" || !p.txHash.startsWith("0x")) {
        return { ok: false, reason: "missing/invalid txHash" };
      }
      try {
        const { result } = await testnetJsonRpc<{
          status?: unknown;
          blockNumber?: unknown;
          block_number?: unknown;
        } | null>("eth_getTransactionReceipt", [p.txHash]);
        if (!result) {
          return { ok: true, receipt: null };
        }
        // The testnet operators emit receipts with a numeric `status` (0/1) +
        // snake_case `block_number`, not the EVM-standard hex-string `status`
        // + camelCase `blockNumber`. Accept both shapes and normalize to the
        // hex-string form the UI's `parseInt(value, 16)` expects, so an
        // included receipt is recognised instead of looking "still pending".
        const rawStatus = result.status;
        const status =
          typeof rawStatus === "string"
            ? rawStatus
            : typeof rawStatus === "number"
              ? "0x" + rawStatus.toString(16)
              : null;
        const rawBlockNumber = result.blockNumber ?? result.block_number;
        const blockNumber =
          typeof rawBlockNumber === "string"
            ? rawBlockNumber
            : typeof rawBlockNumber === "number"
              ? "0x" + rawBlockNumber.toString(16)
              : null;
        return { ok: true, receipt: { status, blockNumber } };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-clear": {
      // Escape hatch for users who want to abandon the local
      // record and regenerate. Surfaces an explicit warning UX in
      // because a prior on-chain registration becomes
      // irrecoverable for this vault address (the precompile is
      // one-time-per-address).
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const cleared = await clearSlhDsaBackupV4(p.vaultId);
        return { ok: true, cleared };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "set-auto-lock-minutes": {
      const p = message.payload as { minutes?: unknown };
      const minutes = typeof p?.minutes === "number" ? p.minutes : NaN;
      if (!(AUTO_LOCK_OPTIONS as readonly number[]).includes(minutes)) {
        return { ok: false, reason: "invalid minutes" };
      }
      await chrome.storage.local.set({ [STORAGE_KEY_AUTO_LOCK_MINUTES]: minutes });
      session.autoLockMinutes = minutes;
      await resetAutoLock();
      return { ok: true, autoLockMinutes: minutes };
    }
    case "get-auto-lock-minutes": {
      return {
        autoLockMinutes: await readAutoLockMinutes(),
        options: AUTO_LOCK_OPTIONS,
      };
    }
    case "get-ui-open-mode": {
      const mode = await readStoredUiOpenMode();
      return { ok: true, mode, options: UI_OPEN_MODE_VALUES };
    }
    case "set-ui-open-mode": {
      const p = (message.payload ?? {}) as { mode?: unknown };
      if (
        typeof p.mode !== "string" ||
        !(UI_OPEN_MODE_VALUES as readonly string[]).includes(p.mode)
      ) {
        return { ok: false, reason: "invalid ui open mode" };
      }
      await chrome.storage.local.set({
        [STORAGE_KEY_UI_OPEN_MODE]: p.mode,
      });
      // applyUiOpenMode also runs from the storage.onChanged listener
      // below, but we call it directly so the IPC reply can wait for
      // the chrome.sidePanel / chrome.action calls to settle before
      // the popup tells the user "restart the wallet."
      await applyUiOpenMode(p.mode as UiOpenMode);
      return { ok: true, mode: p.mode };
    }
    // Contacts CRUD (add / remove / rename). These are USER ACTIONS and are
    // NOT in AUTO_LOCK_EXEMPT_OPS — labelling counts as activity. The popup
    // reads the contact list reactively from chrome.storage via useContacts.
    case "contacts-add": {
      const p = (message.payload ?? {}) as {
        address?: unknown;
        bech32m?: unknown;
        name?: unknown;
        notes?: unknown;
      };
      if (typeof p.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.address)) {
        return { ok: false, reason: "invalid address" };
      }
      if (typeof p.name !== "string") {
        return { ok: false, reason: "missing name" };
      }
      const nameTrimmed = p.name.trim();
      if (nameTrimmed.length === 0) {
        return { ok: false, reason: "name is empty" };
      }
      if (nameTrimmed.length > 64) {
        return { ok: false, reason: "name too long" };
      }
      const bech32m =
        typeof p.bech32m === "string" && p.bech32m.length > 0
          ? p.bech32m
          : addressToBech32m(p.address);
      const notesTrimmed =
        typeof p.notes === "string" ? p.notes.trim().slice(0, 256) : undefined;
      await addContact({
        address: p.address.toLowerCase(),
        bech32m,
        name: nameTrimmed,
        addedAt: Date.now(),
        ...(notesTrimmed ? { notes: notesTrimmed } : {}),
      });
      return { ok: true };
    }
    case "contacts-remove": {
      const p = (message.payload ?? {}) as { address?: unknown };
      if (typeof p.address !== "string") {
        return { ok: false, reason: "missing address" };
      }
      await removeContact(p.address);
      return { ok: true };
    }
    case "contacts-rename": {
      const p = (message.payload ?? {}) as {
        address?: unknown;
        name?: unknown;
      };
      if (typeof p.address !== "string" || typeof p.name !== "string") {
        return { ok: false, reason: "invalid input" };
      }
      const nameTrimmed = p.name.trim();
      if (nameTrimmed.length === 0 || nameTrimmed.length > 64) {
        return { ok: false, reason: "invalid name" };
      }
      await renameContact(p.address, nameTrimmed);
      return { ok: true };
    }
    case "wallet-operator-status": {
      // Liveness probe for the popup's chain-status banner. We iterate
      // TESTNET_OPERATOR_RPCS and return the first that answers
      // `net_version` with the expected chain id (within a 1-second
      // per-host budget). Result is cached for 10s so a banner that
      // re-renders on every screen change doesn't hammer the chain.
      //
      // Same cold-wake boot race as wallet-chain-block-number: seed the
      // persisted operator hint before reading the cache so a reopen reuses it
      // (and so the concurrent chain-block tick sees a populated cachedOperator
      // too). The hint seeds stale, so the TTL check still re-validates below.
      if (cachedOperator === null) await rehydrateCachedOperator();
      const now = Date.now();
      if (
        cachedOperator !== null &&
        now - cachedOperator.checkedAt < OPERATOR_CACHE_TTL_MS
      ) {
        return { ok: true, name: cachedOperator.name };
      }
      // About to probe — load persisted genesis verdicts so the probe's genesis
      // check hits cache instead of re-paying its round-trip.
      await rehydrateGenesisCache();
      try {
        const hit = await probeFirstAliveOperator(undefined, 1_000);
        setCachedOperator({
          name: hit?.name ?? null,
          rpc: hit?.rpc ?? null,
          checkedAt: now,
        });
        return { ok: true, name: hit?.name ?? null };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "get-block-tx-value": {
      // On-demand resolve a transaction's `value` (lythoshi) AND canonical
      // `hash` at (blockHeight, txIndex). The activity-detail popup uses the
      // value to surface a delegate tx's LYTH principal (the indexer carries
      // none) and the hash to render a "View on Monoscan" button on a
      // confirmed row. Read-only; returns valueHex/txHash | null, never throws
      // to the popup (honest-absence on any failure).
      const p = message.payload as { blockHeight?: number; txIndex?: number };
      if (typeof p?.blockHeight !== "number" || typeof p?.txIndex !== "number") {
        return { ok: false, reason: "missing blockHeight/txIndex" };
      }
      try {
        const heightHex = "0x" + Math.trunc(p.blockHeight).toString(16);
        const { result } = await testnetJsonRpc<
          { transactions?: Array<{ value?: string; hash?: string }> } | null
        >("eth_getBlockByNumber", [heightHex, true]);
        const tx = result?.transactions?.[p.txIndex];
        const valueHex = typeof tx?.value === "string" ? tx.value : null;
        const txHash = typeof tx?.hash === "string" ? tx.hash : null;
        return { ok: true, valueHex, txHash };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-tx-fee": {
      // On-demand LYTH fee for a confirmed self-paid tx, read from the native
      // receipt (the indexer activity stream carries no fee, and the eth-compat
      // receipt has no price). Used by the activity-detail popup, whose rows are
      // indexer-sourced and have no persisted fee field. Read-only; returns the
      // lythoshi string or null (zero fee / failed / reverted / pruned), never
      // throws to the popup (honest-absence).
      const p = message.payload as { txHash?: unknown };
      if (typeof p?.txHash !== "string" || p.txHash.length === 0) {
        return { ok: false, reason: "missing txHash" };
      }
      const feeLythoshi = await fetchConfirmedFeeLythoshi(p.txHash);
      return { ok: true, feeLythoshi: feeLythoshi ?? null };
    }
    case "wallet-chain-block-number": {
      // Real chain-liveness probe for the popup's status-bar health
      // indicator. Calls `eth_blockNumber` on the active testnet
      // operator and returns the hex result; the popup tracks block-
      // advance freshness client-side at an 8-second cadence to drive
      // the LIVE / STALLED / OFFLINE state machine.
      //
      // Reuses `cachedOperator` (shared with `wallet-operator-status`) to avoid
      // re-running the operator probe loop on every health tick. On a cold
      // reopen the cache is seeded from the persisted hint (checkedAt: 0 =
      // stale) — so the block read below is tried against it FIRST, skipping
      // the probe RTT. A stale candidate that fails falls through to a fresh
      // probe in the SAME tick (so a dead persisted operator self-heals now,
      // not at the next 8 s poll); a genuinely-fresh operator that fails means
      // the fleet is unhealthy and surfaces as-is.
      //
      // Close the cold-wake boot race: the popup message dispatch does NOT
      // await bootHydrated, so on a reopen after SW hibernation this handler
      // runs before boot's own rehydrateCachedOperator() seeds the hint. Await
      // it HERE so the very first health tick takes the readChainBlock fast
      // path instead of paying the full probe (net_version + genesis) — that
      // probe was the bulk of the "stuck on CONNECTING…" on every reopen.
      // rehydrateCachedOperator no-ops once populated; one session read cold.
      if (cachedOperator === null) await rehydrateCachedOperator();
      // Load the persisted genesis verdicts BEFORE the fast path so the cached
      // operator can be gated on POSITIVE genesis trust (below). Cheap session
      // read; no-ops once loaded.
      await rehydrateGenesisCache();

      const now = Date.now();
      const cacheFresh =
        cachedOperator !== null &&
        cachedOperator.rpc !== null &&
        now - cachedOperator.checkedAt < OPERATOR_CACHE_TTL_MS;

      // C7 (Caveat B) + fail-closed liveness: the fast path may ONLY read a
      // block from a POSITIVELY genesis-trusted operator (cache ok===true). Both
      // a re-genesis'd / wrong-chain op (definitively untrusted) AND a fake /
      // partial endpoint with no genesis proof (observed:null, ok:false — which
      // still answers eth_blockNumber) fail this check and fall through to the
      // gated fresh probe, so the banner shows the real OFFLINE / QUARANTINED /
      // regenesis state instead of a FALSE LIVE (and stops flapping LIVE↔OFFLINE
      // as such an op intermittently answers). Pure cache read — no genesis RTT.
      const cachedGenesisTrusted =
        cachedOperator?.rpc != null &&
        snapshotGenesisCache().get(cachedOperator.rpc)?.ok === true;
      if (cachedOperator?.rpc && cachedGenesisTrusted) {
        const r = await readChainBlock(cachedOperator.rpc, cachedOperator.name);
        if (r.ok) {
          // Promote a successful stale/rehydrated candidate to a fresh hit so
          // the next ticks reuse it within the TTL.
          if (!cacheFresh) {
            setCachedOperator({
              name: cachedOperator.name,
              rpc: cachedOperator.rpc,
              checkedAt: now,
            });
          }
          return r;
        }
        // A quarantined cached op must NOT short-circuit here — fall through to
        // the fresh probe so a healthy failover resolves to LIVE (no banner).
        // Only when NO healthy operator remains does the all-quarantined cause
        // surface (rpc===null branch → classifyNoOperatorReason → "quarantined").
        if (cacheFresh && r.cause !== "quarantined") return r;
        // stale (or quarantined) candidate failed → fall through to a fresh probe
      }

      let rpc: string | null;
      let operatorName: string | null;
      // (Genesis verdicts were rehydrated above, so the probe's genesis check
      // hits cache instead of re-paying its round-trip.)
      try {
        const hit = await probeFirstAliveOperator(undefined, 1_000);
        setCachedOperator({
          name: hit?.name ?? null,
          rpc: hit?.rpc ?? null,
          checkedAt: now,
        });
        rpc = hit?.rpc ?? null;
        operatorName = hit?.name ?? null;
      } catch (e) {
        return {
          ok: false,
          reason: (e as Error).message,
          cause: classifyNoOperatorReason(),
        };
      }
      if (rpc === null) {
        return {
          ok: false,
          reason: "no operator",
          cause: classifyNoOperatorReason(),
        };
      }
      return await readChainBlock(rpc, operatorName);
    }
    case "wallet-active-account": {
      // Surface the unlocked v3 keypair to the popup so Home can render
      // the real ML-DSA-65 address instead of the static demo fixture.
      // Stays scoped to v3 — the legacy v2 keystore goes through the
      // existing demo-data path until the Networks list switch lands.
      //
      // Either a legacy single envelope OR a container counts;
      // unlockContainerV4 sets `unlocked` to the active vault's backend
      // either way, so getUnlockedAddressV4() returns the right address.
      if (!(await hasContainerV4())) {
        return { ok: false, reason: "no v3 vault" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "locked" };
      }
      const address = getUnlockedAddressV4();
      if (!address) {
        return { ok: false, reason: "v3 vault has no stored address" };
      }
      return {
        ok: true,
        address,
        algo: "mldsa" as const,
        custody: "sw" as const,
      };
    }
    case "wallet-balance": {
      // Read-only `eth_getBalance` for the popup Home balance pill.
      // The testnet uses MAX-consensus across all active operators (see
      // `testnetMaxBalanceConsensus`): a lagging operator can only
      // under-report balance, so taking the max across responding
      // operators is the safe resilience strategy. Other testnet RPC
      // methods (eth_call, nonce, fee, indexer) keep the single-
      // operator-with-failover path in `testnetJsonRpc`, where max()
      // would not be meaningful.
      //
      // Every other chain id flows through `rpcClientFor` so user-added
      // chains via wallet_addEthereumChain just work; those use the
      // standard `eth_getBalance` hex-string return.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      try {
        if (chainRequiresMlDsa(p.chainIdHex)) {
          const consensus = await testnetMaxBalanceConsensus(p.address);
          const total = consensus.contributing.length + consensus.failing.length;
          const failSummary =
            consensus.failing.length > 0
              ? ` (failing: ${consensus.failing
                  .map((f) => `${f.name}: ${f.reason}`)
                  .join(", ")})`
              : "";
          // The testnet operators now run the lythoshi-native binary
          // `dc919df8`: `eth_getBalance` is reported directly
          // in canonical lythoshi, which is exactly what the wallet's
          // display path (`formatNativeLythAmount`) expects. The boundary
          // helper below is therefore an identity passthrough — it is
          // retained only as the single flag-aware chokepoint so the
          // wallet can be re-pointed at a legacy-wei operator line by
          // flipping `CHAIN_RETURNS_LEGACY_WEI` back to `true` in
          // shared/chain-units.ts, with no change here. (Under the prior
          // V4-LIVE-0008 wei-on-wire line this divided by WEI_PER_LYTHOSHI;
          // with CHAIN_RETURNS_LEGACY_WEI=false it is now a no-op identity
          // passthrough.)
          const balanceHex = legacyChainBalanceHexToLythoshiHex(consensus.balanceHex);
          // T4-03 (Item C): the spend-gate value (lowest contributing balance).
          const spendGuardHex = legacyChainBalanceHexToLythoshiHex(
            consensus.spendGuardHex,
          );
          console.log(
            `[wallet] balance consensus: max=${consensus.balanceHex} (lythoshi=${balanceHex}) spendGuard=${consensus.spendGuardHex} from ${consensus.contributing.length}/${total} operators${failSummary}`,
          );
          return { ok: true, balanceHex, spendGuardHex };
        }
        const client = rpcClientFor(p.chainIdHex);
        const balanceHex = await rpcSend<string>(client, "eth_getBalance", [
          p.address,
          "latest",
        ]);
        // Single-source chain: the spend guard is the same value.
        return { ok: true, balanceHex, spendGuardHex: balanceHex };
      } catch (e) {
        // C5: thread the typed cause so Home can label a re-genesis ("network
        // may have reset — paused") distinctly from an unreachable chain and
        // suppress a misleading bare 0.00. Pure cache read, no new RPC.
        return {
          ok: false,
          reason: (e as Error).message,
          cause: classifyNoOperatorReason(),
        };
      }
    }
    case "wallet-indexer-snapshot": {
      // Existing consumer (popup Home) shape: passes `unknown[]` through
      // verbatim, no caching. `wallet-activity-get` layers caching + dedupe on top of the same fetch path; this case is preserved bit-for-bit for backward compatibility.
      // layers caching + dedupe on top of the same fetch path. This case
      // is preserved bit-for-bit for backward compatibility until commit
      // 13 swaps Home over to the new pipeline.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "indexer snapshot is only wired for Monolythium Testnet today" };
      }
      const fresh = await fetchIndexerSnapshot(p.address, p.chainIdHex, {
        includeMrcAccount: true,
      });
      return {
        ok: true,
        snapshot: {
          tokenBalances: fresh.tokenBalances,
          bridgeRouteDisclosures: fresh.bridgeRouteDisclosures,
          bridgeRouteReadiness: fresh.bridgeRouteReadiness,
          mrcAccount: fresh.mrcAccount,
          nativeAgentState: fresh.nativeAgentState,
          addressLabel: fresh.addressLabel,
          delegationHistory: fresh.delegationHistory,
          addressActivity: fresh.addressActivity,
          errors: fresh.errors,
        },
      };
    }
    case "wallet-activity-get": {
      // Read-through cache. Hits chrome.storage.local first;
      // if the cache is fresher than CACHE_STALENESS_MS, returns it
      // without an RPC round-trip. Otherwise re-fetches via
      // fetchIndexerSnapshot, validates raw RPC shapes against the
      // wallet-internal Raw* types, merges with delegation-stream priority
      // dedupe per shared/activity.ts, reconciles outstanding pending
      // rows against the freshly merged confirmed list, evicts by TTL,
      // and persists. Returns the merged cache + reconciled pending list
      // + errors-by-key bundle from the four indexer streams.
      //
      // Failure handling: when BOTH activity and delegation streams fail,
      // the previous cache is preserved (no overwrite with empty data)
      // and the errors map is surfaced so the popup can show a partial-
      // data indicator. When at least one stream succeeds the new merge
      // is written — losing rows for a momentarily-failed stream is
      // acceptable; the next refresh recovers.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "activity-get is only wired for Monolythium Testnet today" };
      }
      // Defense in depth: refuse activity fetches for popup
      // demo-data sentinel addresses so no cache row lands keyed by
      // them even if a caller (legacy code path, dapp, future bug) tries
      // to ask. Popup useActivity hook also guards at the call site.
      if (isDemoAddrSentinel(p.address)) {
        return { ok: false, reason: "demo placeholder address — no chain query" };
      }
      const addressLower = p.address.toLowerCase();
      const cacheKey = activityCacheKey(addressLower, p.chainIdHex);
      const pendingKey = activityPendingKey(addressLower, p.chainIdHex);
      const localClaimsKey = activityLocalClaimsKey(addressLower, p.chainIdHex);
      const now = Date.now();
      const {
        cache: prevCache,
        pending: prevPending,
        claims: prevClaims,
      } = await readActivityStorage(cacheKey, pendingKey, localClaimsKey);
      // Bug A F1 — bypass the staleness short-circuit when pending rows exist
      // so a refocus/nav refresh (and the F2 ~4s re-poll in useActivity) falls
      // through to the authoritative reconcile (dropConfirmedPendingByHash
      // below) instead of returning the cached pending row unchanged. Without
      // this, a tx that confirms in ~3-5s lingers as "pending" for up to the
      // full 30s cache window. NARROW: only when prevPending.length > 0 — a
      // non-pending refresh keeps the 30s cache benefit for the common case.
      // Reconcile only flips a confirmed/failed verdict off the receipt
      // (#5117 preserved); it never invents a confirmation.
      // Durable local-claim rows are TTL-exempt + persistent, so they would keep
      // prevPending non-empty forever and defeat the 30s cache. Gate freshness on
      // the NON-claim pending rows only; claim rows still ride through the fresh
      // path (evictExpiredPending exempts them).
      const nonClaimPending = prevPending.filter((p) => p.source !== "local-claim");
      const isFresh =
        prevCache !== null &&
        now - prevCache.lastFetchedAtMs < CACHE_STALENESS_MS &&
        nonClaimPending.length === 0;
      if (isFresh) {
        // Re-inject durable claims even on the fast path (Gap B): if the alarm
        // or any writer dropped a claim from the pending cache, the durable
        // store re-surfaces it here. applyLocalClaims dedups by txHash + cross-
        // stream-suppresses by anchor; belt-2 (claims don't gate isFresh) intact.
        const pending = applyLocalClaims(
          evictExpiredPending(prevPending, now),
          prevClaims,
          prevCache.confirmed,
        );
        if (
          pending.length !== prevPending.length ||
          pending.some((row, i) => row !== prevPending[i])
        ) {
          await new Promise<void>((resolve) => {
            chrome.storage.local.set(
              { [pendingKey]: { pending } },
              () => resolve(),
            );
          });
        }
        return { ok: true, cache: prevCache, pending, errors: {} };
      }
      // Receipt classification is indexer-independent — it asks the chain
      // directly (lyth_txStatus + eth_getTransactionReceipt on the pending
      // txHashes), so run it CONCURRENTLY with the ~6-7 RPC indexer snapshot
      // instead of after it. Sequencing the receipt pass after the snapshot
      // delayed the spinner flip by a full receipt round-trip (~1-3s) behind
      // the single-RPC balance pill — the visible "balance updated but still
      // pending" beat. The indexer anchor match (reconcilePending) still runs
      // AFTER the fetch (it needs the freshly indexed confirmed rows); the
      // early receipt pass only feeds the indexer-lag bridge below.
      const [fresh, receiptPass] = await Promise.all([
        fetchIndexerSnapshot(p.address, p.chainIdHex, {
          includeMrcAccount: false,
        }),
        dropConfirmedPendingByHash(prevPending),
      ]);
      const { kept: receiptKept, terminal: terminalByHash } = receiptPass;
      const activityOk = fresh.errors.addressActivity === undefined;
      const delegationOk = fresh.errors.delegationHistory === undefined;
      if (!activityOk && !delegationOk && prevCache !== null) {
        // Total indexer outage with a usable prev cache — preserve and surface.
        // The receipt pass (above) is indexer-INDEPENDENT, so even with BOTH
        // indexer streams down we still clear a tx that confirmed via its
        // receipt instead of stranding it until the 30s alarm: bridge the
        // receipt-confirmed rows (stamp confirmedBlockHeight) and keep the
        // still-pending ones. There's no indexer snapshot to anchor-swap against
        // here, so bridged rows render confirmed until a later (recovered) poll's
        // reconcilePending retires them. TTL backstop still runs; re-inject
        // durable claims too (Gap B) so an outage never drops a claim.
        const pending = applyLocalClaims(
          evictExpiredPending(
            [...receiptKept, ...bridgeConfirmedTerminals(terminalByHash)],
            now,
          ),
          prevClaims,
          prevCache.confirmed,
        );
        if (
          pending.length !== prevPending.length ||
          pending.some((row, i) => row !== prevPending[i])
        ) {
          await new Promise<void>((resolve) => {
            chrome.storage.local.set(
              { [pendingKey]: { pending } },
              () => resolve(),
            );
          });
        }
        return { ok: true, cache: prevCache, pending, errors: fresh.errors };
      }
      const activity = validateRawActivityList(fresh.addressActivity);
      const delegation = validateRawDelegationList(fresh.delegationHistory);
      // Pass the prior pending + confirmed rows so a delegation's send-time
      // cluster name is threaded onto its confirmed row (the indexer stream
      // carries only the numeric id, §C). prevConfirmed keeps the name sticky
      // across the rebuild once reconcilePending drops the pending row.
      const nextCache = mergeIndexerSnapshot({ activity, delegation }, now, {
        pending: prevPending,
        confirmed: prevCache?.confirmed ?? [],
      });
      const reconciled = reconcilePending(prevPending, nextCache.confirmed);
      const reconciledHashes = new Set(reconciled.map((r) => r.txHash));
      // Indexer-lag bridge (open-surface display path). A tx confirmed via the
      // real-time receipt is dropped from `receiptKept`, but the indexer's
      // success stream usually hasn't surfaced its canonical row in THIS snapshot
      // yet — the chain includes the tx a beat before the indexer writes the
      // activity row, and reconcilePending (run over the raw prevPending, which
      // carries no confirmedBlockHeight on a first-confirm tick) can't match it,
      // so the confirmed row is NOT in nextCache. Dropping it now would make the tx
      // VANISH (pending gone, confirmed not yet indexed) until a much later
      // refresh — exactly the "sent but not shown in Activity" report. Keep
      // confirmed rows in the pending list so the tx stays visible AND the
      // App-level poll keeps running; a later tick's reconcilePending drops the
      // row the instant the indexer surfaces the canonical confirmed row (which
      // then renders — no duplicate, no gap). Failed rows are never in the
      // success-only indexer stream, so they are NOT bridged: they drop here and
      // surface via the notification-history failed-row path.
      const bridgedConfirmed = bridgeConfirmedTerminals(terminalByHash);
      // Final pending = the receipt survivors (still-pending + bridged-confirmed)
      // that the indexer ALSO hasn't surfaced yet. The receipt pass ran over ALL
      // prevPending (it raced the fetch), so restrict it to reconciledHashes —
      // this keeps the result identical to the previous "receipt over indexer-
      // survivors" ordering: a row the indexer matched THIS tick is dropped (its
      // canonical confirmed row renders); an unmatched bridged row stays visible
      // until a later tick's reconcilePending retires it by (block,txIndex).
      const survivors = [...receiptKept, ...bridgedConfirmed].filter((r) =>
        reconciledHashes.has(r.txHash),
      );
      const evictedPending = evictExpiredPending(survivors, now);
      // Re-inject the durable local-claim rows (the local-claim bridges the
      // pre-confirm window + carries the receipt-decoded amount). applyLocalClaims
      // dedups by txHash (the receipt-bridged pending copy wins) and CROSS-STREAM
      // suppresses a claim once a confirmed row appears at its (block,txIndex)
      // anchor (C2 — confirmed rows carry no txHash). LIVE since 2026-06-24: the
      // indexer now ships claim events WITH the amount, so this retire is active;
      // mergeIndexerSnapshot keeps the amount sticky (applyStickyClaimAmount) so
      // a null-amount confirmed row never erases the decoded amount.
      // `prevClaims` was read up-front by readActivityStorage (Gap B) so every
      // return path shares the same durable read.
      const nextPending = applyLocalClaims(
        evictedPending,
        prevClaims,
        nextCache.confirmed,
      );
      await writeActivityStorage(cacheKey, pendingKey, nextCache, prevPending, nextPending);
      // Keep the durable store in sync with the merged survivors (anchored copies
      // + cross-stream-retired claims dropped). Only write when it changed.
      const liveClaims = nextPending.filter((p) => p.source === "local-claim");
      const claimsChanged =
        liveClaims.length !== prevClaims.length ||
        liveClaims.some((c, i) => c !== prevClaims[i]);
      if (claimsChanged) {
        await new Promise<void>((resolve) => {
          chrome.storage.local.set(
            { [localClaimsKey]: { claims: liveClaims } },
            () => resolve(),
          );
        });
      }
      // Notifications hook — post-write microtask. The hook records
      // one notification per row that just reached a TERMINAL state (the
      // confirmed/failed bit from the indexer reconcile or the receipt-RPC
      // classifier above) and explicitly DOES NOT record TTL-evicted rows.
      // Scheduled as a microtask so the snapshot response returns before any
      // notification I/O — a slow/failed notification write must never delay
      // or break activity persistence. See plan §P6.
      {
        // reconciledHashes is computed once in the main body above (the indexer
        // anchor survivors); reuse it so the heuristic notification set stays
        // exactly "rows the indexer matched" — unchanged by the receipt reorder.
        const heuristicallyMatched = prevPending.filter(
          (r) => !reconciledHashes.has(r.txHash),
        );
        const addressLower = p.address.toLowerCase();
        const chainIdHex = p.chainIdHex;
        queueMicrotask(() => {
          void (async () => {
            try {
              // C3 — presence at observe-time, computed ONCE per batch and
              // threaded into both record loops. A surface open now ⇒ record
              // read (no badge bump); closed ⇒ accumulate unread. Defaults
              // false on any error. (On the popup path a surface is typically
              // open, so this is usually read:true; the poll path supplies
              // the closed→unread case.)
              const surfaceOpen = await isWalletSurfaceOpen();
              // Lock state for the toast/badge gates (orthogonal to presence).
              const unlocked = isUnlockedV4();
              let anyAdded = false;
              for (const row of heuristicallyMatched) {
                // The matched confirmed row's blockHeight is the most
                // precise block we have. Falls back to null when no exact
                // match is found (defensive — should be rare).
                const match = nextCache.confirmed.find(
                  (c) =>
                    c.kind === "tx_send" &&
                    c.counterparty != null &&
                    c.counterparty.toLowerCase() === row.to.toLowerCase() &&
                    c.amountDecimal === row.amountDecimal,
                );
                // Heuristic match = a confirmed self-paid tx_send → capture
                // the native-receipt LYTH fee (best-effort).
                const feeLythoshi = await fetchConfirmedFeeLythoshi(row.txHash);
                const result = await recordNotification({
                  addressLower,
                  chainIdHex,
                  txHash: row.txHash,
                  status: "confirmed",
                  blockNumber: match ? match.blockHeight : null,
                  // Prefer the broadcast-time tag if the
                  // popup supplied one; otherwise fall back to the
                  // coarse "send" (Phase-1 behavior — the heuristic
                  // match path is by definition a tx_send).
                  kind: row.opKind ?? "send",
                  amountDecimal: row.amountDecimal,
                  counterparty: row.to,
                  read: surfaceOpen,
                  ...(feeLythoshi !== undefined ? { feeLythoshi } : {}),
                  ...(row.clusterId !== undefined ? { clusterId: row.clusterId } : {}),
                  ...(row.clusterName !== undefined
                    ? { clusterName: row.clusterName }
                    : {}),
                  ...(row.toClusterId !== undefined ? { toClusterId: row.toClusterId } : {}),
                  ...(row.toClusterName !== undefined
                    ? { toClusterName: row.toClusterName }
                    : {}),
                });
                // Fire OS toast ONLY when this snapshot produced
                // a NEW record (the dedupe set blocks already-notified
                // txs). §0.4 honored: every toast derives from a
                // wallet-own tracked-tx transition.
                if (result.added && result.record !== null) {
                  anyAdded = true;
                  await fireOsNotification(result.record, { unlocked });
                }
              }
              for (const t of terminalByHash) {
                // Capture the LYTH fee for confirmed self-paid txs (native
                // receipt); best-effort — failed/zero-fee leaves it unset.
                const feeLythoshi =
                  t.status === "confirmed"
                    ? await fetchConfirmedFeeLythoshi(t.row.txHash)
                    : undefined;
                const result = await recordNotification({
                  addressLower,
                  chainIdHex,
                  txHash: t.row.txHash,
                  status: t.status,
                  blockNumber: t.blockNumber,
                  // Prefer the broadcast-time tag; otherwise
                  // fall back to the coarse "contract_call" (Phase-1
                  // behavior — the status-RPC path catches every
                  // non-tx_send tracked tx).
                  kind: t.row.opKind ?? "contract_call",
                  amountDecimal: t.row.amountDecimal,
                  counterparty: t.row.to,
                  read: surfaceOpen,
                  ...(feeLythoshi !== undefined ? { feeLythoshi } : {}),
                  ...(t.row.clusterId !== undefined
                    ? { clusterId: t.row.clusterId }
                    : {}),
                  ...(t.row.clusterName !== undefined
                    ? { clusterName: t.row.clusterName }
                    : {}),
                  ...(t.row.toClusterId !== undefined
                    ? { toClusterId: t.row.toClusterId }
                    : {}),
                  ...(t.row.toClusterName !== undefined
                    ? { toClusterName: t.row.toClusterName }
                    : {}),
                  ...(t.claimedAmountLythoshi != null
                    ? { claimedAmount: lythoshiDecimalToLythDecimal(t.claimedAmountLythoshi) }
                    : {}),
                  ...(t.row.delegationWeightBps !== undefined
                    ? { delegationWeightBps: t.row.delegationWeightBps }
                    : {}),
                });
                if (result.added && result.record !== null) {
                  anyAdded = true;
                  await fireOsNotification(result.record, { unlocked });
                }
              }
              // Item 7b — incoming-transfer detection (open-surface ⇒ unlocked).
              // The snapshot is already fetched; diff its confirmed tx_receive
              // rows against the per-scope watermark → record + toast new ones.
              // Read-only; nothing here touches the signer. Option (a): no
              // closed/locked poll.
              const incomingAdded = await detectAndNotifyIncoming(
                addressLower,
                chainIdHex,
                nextCache.confirmed,
                surfaceOpen,
                unlocked,
              );
              if (incomingAdded > 0) anyAdded = true;
              // Single badge refresh per batch. getUnread reads
              // chrome.storage so it sees every record this loop wrote;
              // one call covers both heuristic + status-RPC paths.
              if (anyAdded) {
                await refreshUnreadBadge({
        unlocked,
        activeAddrLower: getUnlockedAddressV4()?.toLowerCase() ?? null,
      });
              }
            } catch {
              // Best-effort; never break the snapshot response.
            }
          })();
        });
      }
      return { ok: true, cache: nextCache, pending: nextPending, errors: fresh.errors };
    }
    case "wallet-activity-failed": {
      // Failed txs are NOT in the success-only indexer activity stream, so the
      // Activity list sources them from the notification history — already
      // persisted, capped, and deduped by recordNotification on every failed
      // terminal transition (poll + on-open paths). Scope to the active
      // (address, chain) and return only the status:"failed" records.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: true, failed: [] };
      }
      try {
        const records = await listNotifications(
          p.address.toLowerCase(),
          p.chainIdHex,
        );
        return {
          ok: true,
          failed: records.filter((r) => r.status === "failed"),
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-activity-kind": {
      // Typed AddressActivityKind probe (chain
      // commit d77e4fc).
      //
      // The popup uses this to pick the right empty-state UX:
      // not_found vs indexer_disabled vs pruned vs private all have
      // distinct copy and CTAs. Previously P4.4 used a heuristic
      // ("no rows → 'no activity yet'") which conflated all four into
      // the same message.
      //
      // Graceful fallback: on transport error or chain-side method-
      // not-found, returns DEFAULT_ACTIVITY_KIND_ENVELOPE (kind:
      // not_found) so the popup degrades to the historical UX. The
      // popup never sees an error from this IPC.
      const p = message.payload as { address?: string };
      if (typeof p?.address !== "string") {
        return {
          ok: true,
          envelope: DEFAULT_ACTIVITY_KIND_ENVELOPE,
        };
      }
      try {
        const { result } = await testnetJsonRpc<unknown>(
          "lyth_addressActivityKind",
          [p.address],
        );
        const envelope = normaliseActivityKind(p.address, result);
        return {
          ok: true,
          envelope: envelope ?? {
            ...DEFAULT_ACTIVITY_KIND_ENVELOPE,
            address: p.address.toLowerCase(),
          },
        };
      } catch (e) {
        const err = e as Error & { code?: number };
        // method-unavailable (-32601 not-found or -32045 disabled) → emit
        // "indexer_disabled" rather than "not_found" so the user sees the
        // right copy. Other transport errors get the not_found defensive default.
        if (err.code === -32601 || err.code === -32045) {
          return {
            ok: true,
            envelope: {
              schemaVersion: 0,
              address: p.address.toLowerCase(),
              kind: "indexer_disabled" as const,
              retention: null,
            },
          };
        }
        return {
          ok: true,
          envelope: {
            ...DEFAULT_ACTIVITY_KIND_ENVELOPE,
            address: p.address.toLowerCase(),
          },
        };
      }
    }
    case "wallet-resolve-name": {
      // §22.8 FORWARD resolution (name → address) against the AUTHORITATIVE
      // on-chain hierarchical name registry (0x110E) via lyth_resolveName.
      // SECURITY (P5-002): the result feeds the SIGNED recipient, so it is
      // QUORUM cross-checked across genesis-trusted operators
      // (testnetResolveNameConsensus) — a single rogue/MITM'd operator that
      // returns a different address than the quorum is outvoted (disagreement
      // → never signed). FAIL-CLOSED: a miss, a disagreement, insufficient
      // responders, or any error returns no address (the popup tells the user
      // to paste it); we NEVER fall back to the operator-echoed label cache for
      // a signed send.
      const p = message.payload as { name?: unknown; chainIdHex?: unknown };
      if (typeof p?.name !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing name or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "name resolution is only wired for Monolythium Testnet today" };
      }
      try {
        const consensus = await testnetResolveNameConsensus(p.name);
        if (consensus.status === "confirmed-hit") {
          return { ok: true, addr0x: consensus.addr0x };
        }
        if (consensus.status === "confirmed-miss") {
          return { ok: true, addr0x: null };
        }
        // disagreement (a rogue/MITM'd operator differs from the quorum) or
        // insufficient responders — FAIL-CLOSED, never sign an unverified name.
        return {
          ok: false,
          reason:
            consensus.status === "disagreement"
              ? "operators disagreed on this name — paste the address"
              : "not enough operators agreed to verify this name — paste the address",
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message ?? "resolve failed" };
      }
    }
    case "wallet-resolve-names": {
      // Batched name resolution. The de facto naming source on
      // The testnet is `lyth_getAddressLabel` (per the §22.8 GAP-OPEN
      // decision); resolveName-style hierarchical names land later
      // without a wallet code change.
      //
      // Flow:
      //   1. Validate input. Dedupe + lowercase defensively (the popup
      //      hook should pre-process, but the SW boundary doesn't trust).
      //   2. Read the name cache, evict TTL-expired entries.
      //   3. Read the per-chain method-gate. If the chain is marked
      //      "lyth_getAddressLabel unsupported" within the last 5 minutes,
      //      skip the fetch entirely — cached hits still serve, misses
      //      return absent. Prevents operator hammering on a chain that
      //      doesn't have the method.
      //   4. Otherwise, parallel-fetch every miss via Promise.all.
      //   5. If ANY per-address call returned the method as unavailable
      //      (JSON-RPC -32601 not-found or -32045 disabled), mark the
      //      chain unsupported and skip writing those entries into the
      //      cache (they'd just expire as nulls). If a previously-tripped
      //      chain succeeds, clear the marker.
      //   6. Merge fresh resolutions (including `null` for "checked, no
      //      label") into the cache, persist, return resolved bundle.
      const p = message.payload as { addresses?: unknown; chainIdHex?: unknown };
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      if (!Array.isArray(p.addresses)) {
        return { ok: false, reason: "addresses must be an array" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "resolve-names is only wired for Monolythium Testnet today" };
      }
      const requested: string[] = [];
      const seen = new Set<string>();
      for (const a of p.addresses) {
        if (typeof a !== "string") continue;
        const lower = a.toLowerCase();
        if (seen.has(lower)) continue;
        if (!lower.startsWith("0x")) continue;
        seen.add(lower);
        requested.push(lower);
      }
      if (requested.length === 0) {
        return { ok: true, resolved: {} };
      }
      const now = Date.now();
      // Cache read + TTL eviction.
      const storedRaw = await new Promise<unknown>((resolve) => {
        chrome.storage.local.get([STORAGE_KEY_NAME_CACHE], (res) =>
          resolve(res?.[STORAGE_KEY_NAME_CACHE]),
        );
      });
      const prevCache: NameCache = validateNameCache(storedRaw) ?? {};
      const liveCache = evictExpiredNames(prevCache, now);
      // Build resolved-from-cache and the miss list.
      const resolved: Record<string, NameLabel> = {};
      const misses: string[] = [];
      for (const addr of requested) {
        const hit = liveCache[addr];
        if (hit !== undefined) {
          resolved[addr] = hit.label;
        } else {
          misses.push(addr);
        }
      }
      // Method-gate check. If tripped, return whatever cache had and
      // skip RPC for the misses entirely.
      const methodGate = await readMethodGate(STORAGE_KEY_NAMES_METHOD_GATE);
      const gated = methodGateTripped(methodGate, p.chainIdHex, now);
      if (gated || misses.length === 0) {
        // Persist the post-eviction cache only if eviction actually
        // removed entries (avoids spurious onChanged fires).
        const evictionShrank =
          Object.keys(liveCache).length < Object.keys(prevCache).length;
        if (evictionShrank) {
          await new Promise<void>((resolve) => {
            chrome.storage.local.set(
              { [STORAGE_KEY_NAME_CACHE]: liveCache },
              () => resolve(),
            );
          });
        }
        return { ok: true, resolved };
      }
      // Fetch misses in parallel.
      const fetched = await Promise.all(misses.map(fetchOneAddressLabel));
      const anyMethodNotFound = fetched.some((r) => r.methodNotFound);
      const fresh: Record<string, NameLabel> = {};
      for (let i = 0; i < misses.length; i++) {
        const addr = misses[i]!;
        const r = fetched[i]!;
        if (r.methodNotFound) {
          // Don't cache anything for this address — the chain doesn't
          // support the method, no point storing null entries that
          // would just expire.
          continue;
        }
        fresh[addr] = r.label;
        resolved[addr] = r.label;
      }
      // Method-gate write: trip if any call returned the method unavailable
      // (-32601/-32045), clear if
      // we got at least one successful response while the gate was
      // previously set.
      if (anyMethodNotFound) {
        await setMethodGate(
          STORAGE_KEY_NAMES_METHOD_GATE,
          p.chainIdHex,
          { supported: false, checkedAtMs: now },
        );
      } else if (methodGate[p.chainIdHex] !== undefined) {
        await setMethodGate(STORAGE_KEY_NAMES_METHOD_GATE, p.chainIdHex, null);
      }
      // Merge + persist. mergeNameCache is pure; we're writing the new
      // cache atomically.
      const nextCache = mergeNameCache(liveCache, fresh, now);
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          { [STORAGE_KEY_NAME_CACHE]: nextCache },
          () => resolve(),
        );
      });
      return { ok: true, resolved };
    }
    case "wallet-indexer-status": {
      // Drives the §28.2.1 indexer-staleness banner.
      // Calls `lyth_indexerStatus`, validates the wire shape, returns
      // { stale, lagBlocks, currentHeight, latestHeight }. Stale is
      // true when the lag exceeds INDEXER_LAG_STALE_THRESHOLD.
      //
      // Defensive posture on every failure path (method-not-found,
      // RPC transient error, malformed response): return
      // { ok: true, stale: false, lagBlocks: null, ... }. "Stale: true"
      // would surface a false-positive banner that misleads the user
      // when the real issue is "method missing" or "operator down."
      // The wallet stays useful when the indicator is unavailable.
      //
      // Method-gate (mono.indexerStatus.method-gate) uses the same
      // helpers as wallet-resolve-names but a distinct storage key.
      const p = message.payload as { chainIdHex?: string };
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "indexer-status is only wired for Monolythium Testnet today" };
      }
      const now = Date.now();
      const gate = await readMethodGate(STORAGE_KEY_INDEXER_STATUS_METHOD_GATE);
      if (methodGateTripped(gate, p.chainIdHex, now)) {
        return {
          ok: true,
          stale: false,
          lagBlocks: null,
          currentHeight: null,
          latestHeight: null,
          schemaVersion: null,
          schemaDrift: false,
          retention: null,
        };
      }
      try {
        const { result } = await testnetJsonRpc<unknown>("lyth_indexerStatus", []);
        const validated = validateIndexerStatus(result);
        if (validated === null) {
          // Malformed response — defensive default, no gate trip
          // (the method is responding, just with garbage; transient).
          return {
            ok: true,
            stale: false,
            lagBlocks: null,
            currentHeight: null,
            latestHeight: null,
            schemaVersion: null,
            schemaDrift: false,
            retention: null,
          };
        }
        // Recovery: clear the gate if it was previously tripped.
        if (gate[p.chainIdHex] !== undefined) {
          await setMethodGate(
            STORAGE_KEY_INDEXER_STATUS_METHOD_GATE,
            p.chainIdHex,
            null,
          );
        }
        const lagBlocks =
          validated.latestHeight === null
            ? 0
            : Math.max(0, validated.latestHeight - validated.currentHeight);
        const stale = lagBlocks > INDEXER_LAG_STALE_THRESHOLD;
        // Schema drift detection. Chain reports a
        // higher schemaVersion than the wallet build was tested against;
        // surface a hint so users know their parsers may miss new fields.
        // Doesn't break anything — strict additive parsers (which the
        // wallet uses) silently drop unknown fields.
        const schemaDrift =
          validated.schemaVersion > WALLET_KNOWN_INDEXER_SCHEMA_VERSION;
        return {
          ok: true,
          stale,
          lagBlocks,
          currentHeight: validated.currentHeight,
          latestHeight: validated.latestHeight,
          schemaVersion: validated.schemaVersion,
          schemaDrift,
          retention: validated.retention,
        };
      } catch (e) {
        const err = e as Error & { code?: number };
        if (err.code === -32601 || err.code === -32045) {
          await setMethodGate(
            STORAGE_KEY_INDEXER_STATUS_METHOD_GATE,
            p.chainIdHex,
            { supported: false, checkedAtMs: now },
          );
        }
        return {
          ok: true,
          stale: false,
          lagBlocks: null,
          currentHeight: null,
          latestHeight: null,
          schemaVersion: null,
          schemaDrift: false,
          retention: null,
        };
      }
    }
    case "wallet-fee-suggestion": {
      const p = message.payload as { chainIdHex?: string };
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      try {
        const fee = await suggestFee(p.chainIdHex);
        return { ok: true, ...fee };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-mrv-build-deploy-plan": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      const p = message.payload as {
        artifactBytes?: string;
        artifactHash?: string;
        chainIdHex?: string;
        executionUnitLimitHex?: string;
        maxExecutionFeeLythoshiHex?: string;
        priorityTipLythoshiHex?: string;
        valueWeiHex?: string;
      };
      if (typeof p?.artifactBytes !== "string") {
        return { ok: false, reason: "missing artifactBytes" };
      }
      if (typeof p?.executionUnitLimitHex !== "string") {
        return { ok: false, reason: "missing executionUnitLimitHex" };
      }
      const chainIdHex = p.chainIdHex ?? session.chainId;
      if (!chainRequiresMlDsa(chainIdHex)) {
        return { ok: false, reason: "MRV planning is only wired for Monolythium Testnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddress = getUnlockedAddressV4();
      if (!fromAddress) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const nonceHex = await testnetTransactionCountHex(fromAddress);
        const fee =
          p.maxExecutionFeeLythoshiHex === undefined ||
          p.priorityTipLythoshiHex === undefined
            ? await suggestFee(chainIdHex)
            : null;
        const input: WalletMrvDeployNativePlanInput = {
          fromAddress,
          chainIdHex,
          nonceHex,
          executionUnitLimitHex: p.executionUnitLimitHex,
          maxExecutionFeeLythoshiHex:
            p.maxExecutionFeeLythoshiHex ?? fee?.maxFeePerGas ?? "0x0",
          artifactBytes: p.artifactBytes,
        };
        if (p.priorityTipLythoshiHex !== undefined) {
          input.priorityTipLythoshiHex = p.priorityTipLythoshiHex;
        } else if (fee !== null) {
          input.priorityTipLythoshiHex = fee.maxPriorityFeePerGas;
        }
        if (p.valueWeiHex !== undefined) input.valueWeiHex = p.valueWeiHex;
        if (p.artifactHash !== undefined) input.artifactHash = p.artifactHash;
        return { ok: true, plan: buildWalletMrvDeployNativePlan(input) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-mrv-build-call-plan": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      const p = message.payload as {
        contractAddress?: string;
        input?: string;
        chainIdHex?: string;
        executionUnitLimitHex?: string;
        maxExecutionFeeLythoshiHex?: string;
        priorityTipLythoshiHex?: string;
        valueWeiHex?: string;
      };
      if (typeof p?.contractAddress !== "string") {
        return { ok: false, reason: "missing contractAddress" };
      }
      if (typeof p?.input !== "string") {
        return { ok: false, reason: "missing input" };
      }
      if (typeof p?.executionUnitLimitHex !== "string") {
        return { ok: false, reason: "missing executionUnitLimitHex" };
      }
      const chainIdHex = p.chainIdHex ?? session.chainId;
      if (!chainRequiresMlDsa(chainIdHex)) {
        return { ok: false, reason: "MRV planning is only wired for Monolythium Testnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddress = getUnlockedAddressV4();
      if (!fromAddress) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const contractAddress = requireTypedMrvContractAddress(p.contractAddress).typed;
        const nonceHex = await testnetTransactionCountHex(fromAddress);
        const fee =
          p.maxExecutionFeeLythoshiHex === undefined ||
          p.priorityTipLythoshiHex === undefined
            ? await suggestFee(chainIdHex)
            : null;
        const input: WalletMrvCallNativePlanInput = {
          fromAddress,
          chainIdHex,
          nonceHex,
          executionUnitLimitHex: p.executionUnitLimitHex,
          maxExecutionFeeLythoshiHex:
            p.maxExecutionFeeLythoshiHex ?? fee?.maxFeePerGas ?? "0x0",
          contractAddress,
          input: p.input,
        };
        if (p.priorityTipLythoshiHex !== undefined) {
          input.priorityTipLythoshiHex = p.priorityTipLythoshiHex;
        } else if (fee !== null) {
          input.priorityTipLythoshiHex = fee.maxPriorityFeePerGas;
        }
        if (p.valueWeiHex !== undefined) input.valueWeiHex = p.valueWeiHex;
        return { ok: true, plan: buildWalletMrvCallNativePlan(input) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-mrv-submit-plan": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      const p = message.payload as {
        plan?: WalletMrvNativeSubmissionPlan;
        chainIdHex?: string;
      };
      if (p?.plan === null || typeof p?.plan !== "object") {
        return { ok: false, reason: "missing MRV native submission plan" };
      }
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "MRV submission is only wired for Monolythium Testnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      // NN-01: bind to the active vault at handler entry.
      const boundVaultId = getActiveVaultIdV4();
      if (boundVaultId === null) {
        return { ok: false, reason: "wallet locked" };
      }
      // S6 #45 B1: a multisig active vault must use the propose/approve flow.
      if (await activeVaultIsMultisig()) {
        return { ok: false, reason: MULTISIG_SEND_REFUSAL };
      }
      try {
        // T4-04 (Item D, a1): clamp the popup-supplied plan fee before signing
        // (this wallet-UI path builds + signs directly, bypassing the
        // wallet-send-tx clamp). Defends against a tampered popup the same way
        // the dApp paths defend against a malicious operator.
        const txReq = clampMrvSubmitTxFee(
          walletMrvNativePlanToSubmitTx(p.plan, {
            chainIdHex: p.chainIdHex,
            fromAddress: fromAddr,
          }),
        );
        const { txHash, via } = await submitMlDsaTx(txReq, boundVaultId);
        return { ok: true, txHash, via };
      } catch (e) {
        const err = e as Error & {
          code?: number;
          via?: string;
          method?: string;
        };
        const code = typeof err.code === "number" ? err.code : undefined;
        const method = typeof err.method === "string" ? err.method : undefined;
        const via = typeof err.via === "string" ? err.via : undefined;
        const reason = err.message ?? "MRV native submission failed";
        return {
          ok: false,
          reason,
          ...(code !== undefined && { code }),
          ...(method !== undefined && { method }),
          ...(via !== undefined && { via }),
        };
      }
    }
    case "wallet-mrv-receipt-status": {
      const p = message.payload as {
        txHash?: string;
        chainIdHex?: string;
        finalityTrust?: unknown;
      };
      if (
        typeof p?.txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(p.txHash)
      ) {
        return { ok: false, reason: "missing/invalid txHash" };
      }
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      const requestChainIdHex = p.chainIdHex;
      if (!chainRequiresMlDsa(requestChainIdHex)) {
        return {
          ok: false,
          reason: "MRV receipt polling is only wired for Monolythium Testnet today",
        };
      }
      let registryTrust:
        | WalletMrvNoEvmRegistryTrustPolicyResolution
        | undefined;
      const readRegistryTrust = (): WalletMrvNoEvmRegistryTrustPolicyResolution => {
        registryTrust ??= resolveMrvNoEvmRegistryReceiptTrustPolicy(
          requestChainIdHex,
        );
        return registryTrust;
      };
      const finalityTrust = resolveMrvNoEvmFinalityTrustConfig(
        p.finalityTrust,
        requestChainIdHex,
        readRegistryTrust,
      );
      const archiveTrust = resolveMrvNoEvmArchiveTrustConfig(
        requestChainIdHex,
        readRegistryTrust,
      );
      try {
        const { result, via } = await testnetJsonRpc<{
          transactionHash?: string;
          status?: string;
          blockNumber?: string;
          contractAddress?: string | null;
        } | null>("eth_getTransactionReceipt", [p.txHash]);
        if (!result) {
          return { ok: true, receipt: null, via };
        }
        let nativeReceipt: WalletMrvNativeReceiptEvidence | null = null;
        let nativeReceiptError: WalletMrvNativeReceiptEvidenceError | undefined;
        try {
          const native = await testnetJsonRpc<unknown>("lyth_nativeReceipt", [
            p.txHash,
          ]);
          nativeReceipt = parseMrvNativeReceiptEvidence(
            native.result,
            finalityTrust,
            archiveTrust,
          );
          if (nativeReceipt === null) {
            nativeReceiptError = {
              reason: "lyth_nativeReceipt returned malformed native receipt",
              method: "lyth_nativeReceipt",
              ...(typeof native.via === "string" ? { via: native.via } : {}),
            };
          }
        } catch (e) {
          const err = e as Error & {
            code?: number;
            via?: string;
            method?: string;
          };
          nativeReceiptError = {
            reason: err.message ?? "MRV native receipt unavailable",
            method:
              typeof err.method === "string" ? err.method : "lyth_nativeReceipt",
            ...(typeof err.code === "number" ? { code: err.code } : {}),
            ...(typeof err.via === "string" ? { via: err.via } : {}),
          };
        }
        return {
          ok: true,
          receipt: {
            txHash:
              typeof result.transactionHash === "string"
                ? result.transactionHash
                : p.txHash,
            status: typeof result.status === "string" ? result.status : null,
            blockNumber:
              typeof result.blockNumber === "string" ? result.blockNumber : null,
            contractAddress:
              typeof result.contractAddress === "string"
                ? result.contractAddress
                : null,
            nativeReceipt,
            ...(nativeReceiptError !== undefined ? { nativeReceiptError } : {}),
          },
          via,
        };
      } catch (e) {
        const err = e as Error & {
          code?: number;
          via?: string;
          method?: string;
        };
        const code = typeof err.code === "number" ? err.code : undefined;
        const method =
          typeof err.method === "string"
            ? err.method
            : "eth_getTransactionReceipt";
        const via = typeof err.via === "string" ? err.via : undefined;
        const reason = err.message ?? "MRV native receipt polling failed";
        return {
          ok: false,
          reason,
          method,
          ...(code !== undefined && { code }),
          ...(via !== undefined && { via }),
        };
      }
    }
    case "wallet-preview-transaction-hooks": {
      // Call lyth_previewTransactionHooks
      // (MS-CORE-0009) so the Send preview can show "Hooks that
      // will run" before the user signs. Falls back to mock-not-
      // deployed on -32601, in which case the popup hides the
      // section entirely (no UI regression on older operators).
      const p = message.payload as {
        from?: string;
        to?: string;
        valueWeiHex?: string;
        data?: string;
      } | undefined;
      if (typeof p?.to !== "string") {
        return { ok: false, reason: "missing to" };
      }
      const input: {
        from?: string;
        to: string;
        valueWeiHex?: string;
        data?: string;
      } = { to: p.to };
      if (typeof p.from === "string") input.from = p.from;
      if (typeof p.valueWeiHex === "string") input.valueWeiHex = p.valueWeiHex;
      if (typeof p.data === "string") input.data = p.data;
      const outcome = await previewTransactionHooks(input);
      return { ok: true, outcome };
    }
    case "wallet-native-market-state": {
      const p = message.payload as
        | {
            marketId?: string;
            orderId?: string;
            listingId?: string;
            collectionId?: string;
            includeSpotOrders?: boolean;
            limit?: number;
          }
        | undefined;
      const filter = {
        ...(typeof p?.marketId === "string" ? { marketId: p.marketId } : {}),
        ...(typeof p?.orderId === "string" ? { orderId: p.orderId } : {}),
        ...(typeof p?.listingId === "string" ? { listingId: p.listingId } : {}),
        ...(typeof p?.collectionId === "string"
          ? { collectionId: p.collectionId }
          : {}),
        ...(typeof p?.includeSpotOrders === "boolean"
          ? { includeSpotOrders: p.includeSpotOrders }
          : {}),
        ...(typeof p?.limit === "number" ? { limit: p.limit } : {}),
      };
      const outcome = await readNativeMarketState(filter);
      return { ok: true, outcome };
    }
    case "wallet-native-market-orderbook-deltas": {
      const p = message.payload as
        | {
            fromBlock?: number;
            toBlock?: number;
            limit?: number;
            cursor?: string;
            marketId?: string;
            eventName?: string;
            primaryId?: string;
            relatedId?: string;
            tokenId?: string;
            account?: string;
            counterparty?: string;
          }
        | undefined;
      if (
        typeof p?.fromBlock !== "number" ||
        typeof p?.toBlock !== "number"
      ) {
        return { ok: false, reason: "missing block range" };
      }
      const filter = {
        fromBlock: p.fromBlock,
        toBlock: p.toBlock,
        ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        ...(typeof p.cursor === "string" ? { cursor: p.cursor } : {}),
        ...(typeof p.marketId === "string" ? { marketId: p.marketId } : {}),
        ...(typeof p.eventName === "string" ? { eventName: p.eventName } : {}),
        ...(typeof p.primaryId === "string" ? { primaryId: p.primaryId } : {}),
        ...(typeof p.relatedId === "string" ? { relatedId: p.relatedId } : {}),
        ...(typeof p.tokenId === "string" ? { tokenId: p.tokenId } : {}),
        ...(typeof p.account === "string" ? { account: p.account } : {}),
        ...(typeof p.counterparty === "string" ? { counterparty: p.counterparty } : {}),
      };
      const outcome = await readNativeMarketOrderBookDeltas(filter);
      return { ok: true, outcome };
    }
    case "wallet-native-agent-state": {
      const p = message.payload as
        | {
            policyId?: string;
            escrowId?: string;
            account?: string;
            includePolicySpends?: boolean;
            limit?: number;
          }
        | undefined;
      const filter = {
        ...(typeof p?.policyId === "string" ? { policyId: p.policyId } : {}),
        ...(typeof p?.escrowId === "string" ? { escrowId: p.escrowId } : {}),
        ...(typeof p?.account === "string" ? { account: p.account } : {}),
        ...(typeof p?.includePolicySpends === "boolean"
          ? { includePolicySpends: p.includePolicySpends }
          : {}),
        ...(typeof p?.limit === "number" ? { limit: p.limit } : {}),
      };
      const outcome = await readNativeAgentState(filter);
      return { ok: true, outcome };
    }
    case "chain-signing-activity": {
      // Call lyth_signingActivity (MD-CORE-0004)
      // for a sampled authority. Returns ChainOutcome<OperatorSigningActivity>.
      // Defaults: authorityIndex 0, limit 20. Falls back to mock-not-deployed
      // on -32601 so older operators don't break the Operators page.
      const p = message.payload as
        | { authorityIndex?: number; limit?: number }
        | undefined;
      const args: { authorityIndex?: number; limit?: number } = {};
      if (typeof p?.authorityIndex === "number") args.authorityIndex = p.authorityIndex;
      if (typeof p?.limit === "number") args.limit = p.limit;
      const outcome = await readSigningActivity(args);
      return { ok: true, outcome };
    }
    case "chain-operator-risk": {
      // Call lyth_operatorRisk (MD-CORE-0006)
      // for a sampled authority. Returns ChainOutcome<OperatorRiskWire>
      // with miss-rate / headroom / jail status. Defaults:
      // authorityIndex 0, windowRounds 200 (chain clamps at 1000).
      // Mock-not-deployed on -32601 so the popup hides the card.
      const p = message.payload as
        | { authorityIndex?: number; windowRounds?: number }
        | undefined;
      const args: { authorityIndex?: number; windowRounds?: number } = {};
      if (typeof p?.authorityIndex === "number") args.authorityIndex = p.authorityIndex;
      if (typeof p?.windowRounds === "number") args.windowRounds = p.windowRounds;
      const outcome = await readOperatorRisk(args);
      return { ok: true, outcome };
    }
    case "chain-upcoming-duties": {
      // Call lyth_upcomingDuties (MD-CORE-0005)
      // for a sampled authority. Returns ChainOutcome<UpcomingDuties>
      // with attestation window + committee context + keyRotation
      // boundary. Block-production + sync surfaces are typed-null on
      // Starfish-C (leader election unpredictable). Defaults:
      // authorityIndex 0, horizonRounds 1000 (chain max).
      const p = message.payload as
        | { authorityIndex?: number; horizonRounds?: number }
        | undefined;
      const args: { authorityIndex?: number; horizonRounds?: number } = {};
      if (typeof p?.authorityIndex === "number") args.authorityIndex = p.authorityIndex;
      if (typeof p?.horizonRounds === "number") args.horizonRounds = p.horizonRounds;
      const outcome = await readUpcomingDuties(args);
      return { ok: true, outcome };
    }
    // Staking + delegation reads.
    case "staking-cluster-directory": {
      const p = message.payload as { page?: number; limit?: number } | undefined;
      const page = typeof p?.page === "number" ? p.page : 0;
      const limit = typeof p?.limit === "number" ? p.limit : 25;
      return readClusterDirectory(page, limit);
    }
    case "staking-cluster-status": {
      const p = message.payload as { clusterId?: number } | undefined;
      if (typeof p?.clusterId !== "number") {
        return { ok: false, reason: "missing clusterId" };
      }
      return readClusterStatus(p.clusterId);
    }
    case "staking-operator-info": {
      const p = message.payload as { operatorId?: string } | undefined;
      if (typeof p?.operatorId !== "string") {
        return { ok: false, reason: "missing operatorId" };
      }
      return readOperatorInfo(p.operatorId);
    }
    case "staking-cluster-service-tiers": {
      const p = message.payload as { operatorIds?: ReadonlyArray<string> } | undefined;
      if (!Array.isArray(p?.operatorIds)) {
        return { ok: false, reason: "missing operatorIds" };
      }
      const valid = p.operatorIds.filter((id): id is string => typeof id === "string");
      return readClusterServiceTiers(valid);
    }
    case "staking-delegations": {
      const p = message.payload as { wallet?: string } | undefined;
      if (typeof p?.wallet !== "string") {
        return { ok: false, reason: "missing wallet" };
      }
      return readDelegations(p.wallet);
    }
    case "staking-delegation-cap": {
      return readDelegationCap();
    }
    case "staking-pending-rewards": {
      // The wallet reads `lyth_pendingRewards` first; delegation rows are
      // passed through only for the offline/absent-method mock fallback.
      const p = message.payload as {
        wallet?: string;
        delegations?: Array<{ cluster?: number; weightBps?: number }>;
      } | undefined;
      if (typeof p?.wallet !== "string") {
        return { ok: false, reason: "missing wallet" };
      }
      const delegations = Array.isArray(p.delegations)
        ? p.delegations
            .filter(
              (d): d is { cluster: number; weightBps: number } =>
                typeof d?.cluster === "number" && typeof d?.weightBps === "number",
            )
            .map((d) => ({ cluster: d.cluster, weightBps: d.weightBps }))
        : [];
      return readPendingRewards(p.wallet, delegations);
    }
    case "staking-redemption-queue": {
      const p = message.payload as { wallet?: string } | undefined;
      if (typeof p?.wallet !== "string") {
        return { ok: false, reason: "missing wallet" };
      }
      return readRedemptionQueue(p.wallet);
    }
    case "staking-delegation-history": {
      // Per-wallet delegation event timeline. Distinct from
      // the wallet-wide activity feed: the activity feed merges every
      // event kind for the user's address; this reader is delegation-
      // only for the Delegations page's "Recent activity" surface.
      const p = message.payload as {
        wallet?: string;
        limit?: number;
        cursor?: string;
      } | undefined;
      if (typeof p?.wallet !== "string") {
        return { ok: false, reason: "missing wallet" };
      }
      const limit = typeof p.limit === "number" ? p.limit : 50;
      return readDelegationHistory(p.wallet, limit, p.cursor);
    }
    case "staking-cluster-delegators": {
      // Co-delegator surface for a single cluster. Used by
      // the cluster-detail expand panel to render "n wallets delegate
      // here" without inferring from indirect signals.
      const p = message.payload as { clusterId?: number } | undefined;
      if (typeof p?.clusterId !== "number") {
        return { ok: false, reason: "missing clusterId" };
      }
      return readClusterDelegators(p.clusterId);
    }
    case "staking-autovote-seed": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      // Per-user entropy: derive a 32-byte seed from the unlocked
      // ML-DSA-65 public key + a domain tag. The public key is already
      // public state, so this leaks no secret material; different users
      // produce different seed material from different pubkeys. Locked
      // wallets get a typed error and the popup falls back to a "please
      // unlock to use autovote" branch.
      const pubkey = getUnlockedPublicKeyV4();
      if (pubkey === null) {
        return { ok: false, reason: "wallet locked" };
      }
      const domain = new TextEncoder().encode("monolythium.autovote.v1");
      const combined = new Uint8Array(pubkey.length + domain.length);
      combined.set(pubkey, 0);
      combined.set(domain, pubkey.length);
      const seed = shake256(combined, { dkLen: 32 });
      let hex = "0x";
      for (let i = 0; i < seed.length; i++) {
        hex += seed[i]!.toString(16).padStart(2, "0");
      }
      return { ok: true, seedHex: hex };
    }
    case "staking-cluster-diversity": {
      // §25.1 read-only diversity score for one cluster. Powers both the
      // ClusterDetail diversity card and the autovote Max-Diversity /
      // Max-Decentralization scorers. Returns the StakingResult envelope
      // verbatim; the popup renders `—` on `ok: false`.
      const p = message.payload as { clusterId?: number } | undefined;
      if (typeof p?.clusterId !== "number") {
        return { ok: false, reason: "missing clusterId" };
      }
      return readClusterDiversity(p.clusterId);
    }
    case "bridge-health": {
      // §20/§25.2 — live circuit-breaker / pause posture page (MB-2).
      // Disclosure-only: the bridge has no live quote/submit path.
      const p = message.payload as
        | { cursor?: string | null; limit?: number }
        | undefined;
      const cursor = typeof p?.cursor === "string" ? p.cursor : null;
      const outcome =
        typeof p?.limit === "number"
          ? await readBridgeHealth(cursor, p.limit)
          : await readBridgeHealth(cursor);
      return { ok: true, outcome };
    }
    case "bridge-drain-status": {
      // §20/§25.2 — live per-route drain bucket (MB-2) for one
      // (bridgeId, wrappedAsset). Disclosure-only.
      const p = message.payload as
        | { bridgeId?: string; wrappedAsset?: string }
        | undefined;
      if (typeof p?.bridgeId !== "string" || typeof p?.wrappedAsset !== "string") {
        return { ok: false, reason: "missing bridgeId or wrappedAsset" };
      }
      const outcome = await readBridgeDrainStatus(p.bridgeId, p.wrappedAsset);
      return { ok: true, outcome };
    }
    case "spending-policy-get": {
      // §18.8 — live spending-policy summary for one controlled
      // sub-account. Returns the StakingResult envelope verbatim; the
      // AgentPolicy page renders the SpendingPolicyView card or `—` on
      // `ok: false`. Read-only — no unlock required.
      const p = message.payload as { subAccount?: string } | undefined;
      if (typeof p?.subAccount !== "string" || p.subAccount.length === 0) {
        return { ok: false, reason: "missing subAccount" };
      }
      return readSpendingPolicy(p.subAccount);
    }
    case "spending-policy-build-claim": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      // §18.8 fresh-claim path. Derives a brand-new agent sub-account
      // ML-DSA-65 keypair, signs the chain-id-bound claim message with
      // it, and returns the setPolicyClaim calldata + the sub-account
      // address + its one-time recovery phrase. The PRINCIPAL (active
      // wallet) then funds the sub-account (native transfer via
      // "wallet-send-tx") and submits the claim (also "wallet-send-tx",
      // to = 0x110C). The two-key dance: the sub-account signs the bound
      // message here; the principal signs + submits the outer tx.
      //
      // Requires the principal wallet to be unlocked so the follow-up
      // submit (which the popup fires through "wallet-send-tx") has a
      // signer — and so a claim can never be staged against a locked
      // wallet that would then fail at submit time.
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const principal = getUnlockedAddressV4();
      if (!principal) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      const p = message.payload as Partial<BuildClaimRequest> | undefined;
      if (
        typeof p?.chainId !== "string" &&
        typeof p?.chainId !== "number"
      ) {
        return { ok: false, reason: "missing chainId" };
      }
      if (
        typeof p?.perTxCapLyth !== "string" ||
        typeof p?.dailyCapLyth !== "string" ||
        typeof p?.weeklyCapLyth !== "string" ||
        typeof p?.monthlyCapLyth !== "string"
      ) {
        return { ok: false, reason: "missing cap fields" };
      }
      return buildSpendingPolicyClaim({
        principal,
        chainId: p.chainId,
        perTxCapLyth: p.perTxCapLyth,
        dailyCapLyth: p.dailyCapLyth,
        weeklyCapLyth: p.weeklyCapLyth,
        monthlyCapLyth: p.monthlyCapLyth,
        ...(typeof p.allowRoot === "string" ? { allowRoot: p.allowRoot } : {}),
        ...(typeof p.denyRoot === "string" ? { denyRoot: p.denyRoot } : {}),
        ...(typeof p.categoryAllowRoot === "string"
          ? { categoryAllowRoot: p.categoryAllowRoot }
          : {}),
        ...(p.timeWindow !== undefined ? { timeWindow: p.timeWindow } : {}),
        ...(typeof p.policyExpiryUnixSeconds === "number"
          ? { policyExpiryUnixSeconds: p.policyExpiryUnixSeconds }
          : {}),
      });
    }
    case "ws-status": {
      // WS-client status probe. The popup uses this
      // to decide whether to keep its existing polling cadence (default)
      // or drop to event-driven updates (when WS reports "connected").
      // No side effects: doesn't subscribe, doesn't open a connection.
      // Just reports what the SW-singleton currently sees.
      const client = getWsClient();
      const status: WsStatus = client.status;
      return { ok: true, status };
    }
    case "ws-subscribe-new-heads": {
      // Fire-and-forget subscribe to the chain's
      // `newHeads` channel. The SW-singleton WsClient manages one
      // connection per SW lifetime; subsequent calls share it.
      //
      // Side effect: when a new head arrives, the SW writes the latest
      // blockHex to `chrome.storage.session` under `mono.ws.lastBlockHex`.
      // The popup's ChainStatusBanner subscribes to that key via
      // chrome.storage.onChanged for live updates without polling.
      //
      // Graceful degradation: if WS unavailable, the IPC returns
      // `{ ok: true, status: "unavailable" }` and the popup keeps its
      // existing 8 s blockNumber poll active.
      const client = getWsClient();
      // First call: install the storage-write listener exactly once
      // per SW boot via the `wsNewHeadsListenerInstalled` flag.
      if (!wsNewHeadsListenerInstalled) {
        wsNewHeadsListenerInstalled = true;
        client.subscribe("newHeads", (params) => {
          // Chain emits `{ number: "0x...", hash, parent, ... }`. The wallet
          // only cares about the height for the live banner. Shape-validate the
          // operator-pushed payload before it touches banner state: a connected
          // operator could push a malformed/garbage block number. Only a
          // well-formed 0x block hex updates the banner; anything else is
          // dropped (F-2.4/#21).
          const number =
            typeof params === "object" && params !== null
              ? (params as { number?: unknown }).number
              : undefined;
          if (isWellFormedBlockNumberHex(number)) {
            chrome.storage.session
              .set({ [STORAGE_KEY_WS_LAST_BLOCK_HEX]: number })
              .catch(() => {
                // session write failure is non-load-bearing
              });
            // B2: track WHEN the head advanced (keyed by hex) so the popup's
            // stall window survives a reopen. Update the timestamp ONLY when the
            // hex changes — not on every duplicate push — so it reflects genuine
            // advancement. Best-effort; a failed read/write just means the next
            // popup open falls back to its own first-tick baseline.
            chrome.storage.session
              .get(STORAGE_KEY_WS_BLOCK_ADVANCE)
              .then((s) => {
                const prev = s?.[STORAGE_KEY_WS_BLOCK_ADVANCE];
                const prevHex =
                  typeof prev === "object" && prev !== null
                    ? (prev as { hex?: unknown }).hex
                    : undefined;
                if (prevHex !== number) {
                  chrome.storage.session
                    .set({
                      [STORAGE_KEY_WS_BLOCK_ADVANCE]: {
                        hex: number,
                        advancedAtMs: Date.now(),
                      },
                    })
                    .catch(() => {});
                }
              })
              .catch(() => {});
          }
        });
      }
      return { ok: true, status: client.status };
    }
    case "wallet-send-tx": {
      // Self-heal a false "locked" after an MV3 SW cold-restart mid-prep
      // (no-op + fail-closed outside the live auto-lock window).
      await ensureUnlockRestored();
      const p = message.payload as {
        to?: string;
        valueWeiHex?: string;
        chainIdHex?: string;
        // Optional contract-call fields. Omit
        // both for native LYTH transfers and the handler behaves
        // exactly as it did before; supply them for NFT
        // safeTransferFrom and the data is forwarded verbatim into
        // the ML-DSA-65 envelope.
        data?: string;
        gasLimitHex?: string;
        // Notifications — optional operation tag. METADATA
        // ONLY: this is never plumbed into submitPlaintextMlDsaTx; it
        // rides only into persistPendingRowBackground's pending-row
        // record so the notifications hook can label the resulting
        // NotificationRecord with a friendly title. An unknown literal
        // is coerced to the "contract_call" fallback (defense in depth).
        opKind?: unknown;
        // Cluster metadata for delegation sends — METADATA ONLY (same as
        // opKind): rides only into the pending row, never the signer.
        clusterId?: unknown;
        clusterName?: unknown;
        // Redelegate DESTINATION cluster — METADATA ONLY (for the toast).
        toClusterId?: unknown;
        toClusterName?: unknown;
        // Reward-claim metadata (opKind:"claim") — METADATA ONLY (same as
        // clusterId): rides into the pending row + local-claims store, never the
        // signer. claimedAmount = decimal LYTH | null; rateAtClaim = number |
        // null; currency = ISO-4217 code.
        claimedAmount?: unknown;
        rateAtClaim?: unknown;
        currency?: unknown;
        // Delegation weight (bps) for delegate/redelegate — METADATA ONLY (same
        // as clusterId): the same uint16 already in `data`; rides only into the
        // pending row so the notification shows the %. Never re-encoded.
        delegationWeightBps?: unknown;
        // T1-04(a) — elevated re-auth for an over-limit passkey send. When
        // the per-vault passkey cap would reject this value-only transfer,
        // the popup re-submits with the account password here; the SW
        // VERIFIES it (verifyContainerPasswordV4) before signing. A plain
        // boolean would be forgeable by the local IPC actor this gate
        // targets, so the proof is the password itself, SW-checked.
        elevatedPassword?: unknown;
        // T4-04 (Item D, b1) — the EXACT fee the popup preview displayed
        // (base + tier-scaled tip + unit limit). When present the SW signs
        // this verbatim (after rpcQuantityToHex validation + a sane-ceiling
        // clamp) instead of re-reading the operator, closing the display-vs-
        // sign double-read and the Slow/Fast tier-multiplier desync.
        signedFee?: unknown;
      };
      if (
        typeof p?.to !== "string" ||
        typeof p?.valueWeiHex !== "string" ||
        typeof p?.chainIdHex !== "string"
      ) {
        return { ok: false, reason: "missing to, valueWeiHex, or chainIdHex" };
      }
      if (
        p.data !== undefined &&
        (typeof p.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(p.data))
      ) {
        return { ok: false, reason: "data must be 0x-prefixed hex" };
      }
      if (
        p.gasLimitHex !== undefined &&
        (typeof p.gasLimitHex !== "string" ||
          !/^0x[0-9a-fA-F]+$/.test(p.gasLimitHex))
      ) {
        return { ok: false, reason: "gasLimitHex must be 0x-prefixed hex" };
      }
      // Notifications — tolerate but sanitize opKind. Absent stays
      // absent (legacy/untagged path → coarse fallback at the hook). A known
      // literal rides through. An unknown / non-string value is coerced to
      // the fallback "contract_call" so a buggy caller produces a coarse-but-
      // valid notification instead of corrupting the row.
      const acceptedOpKind: TxOpKind | undefined =
        p.opKind === undefined
          ? undefined
          : isTxOpKind(p.opKind)
            ? p.opKind
            : "contract_call";
      // Cluster metadata — METADATA ONLY (never reaches the signer). Sanitize:
      // a finite number id + a non-empty string name; anything else is dropped.
      const acceptedClusterId =
        typeof p.clusterId === "number" && Number.isFinite(p.clusterId)
          ? p.clusterId
          : undefined;
      const acceptedClusterName =
        typeof p.clusterName === "string" && p.clusterName.length > 0
          ? p.clusterName
          : undefined;
      const acceptedToClusterId =
        typeof p.toClusterId === "number" && Number.isFinite(p.toClusterId)
          ? p.toClusterId
          : undefined;
      const acceptedToClusterName =
        typeof p.toClusterName === "string" && p.toClusterName.length > 0
          ? p.toClusterName
          : undefined;
      // Reward-claim metadata — METADATA ONLY (never reaches the signer).
      // Sanitize: a decimal-string|null amount, a finite|null rate, a valid
      // ISO-4217 currency; anything else is dropped.
      const acceptedClaimedAmount =
        typeof p.claimedAmount === "string" || p.claimedAmount === null
          ? p.claimedAmount
          : undefined;
      const acceptedRateAtClaim =
        typeof p.rateAtClaim === "number" && Number.isFinite(p.rateAtClaim)
          ? p.rateAtClaim
          : p.rateAtClaim === null
            ? null
            : undefined;
      const acceptedCurrency = isCurrencyCode(p.currency) ? p.currency : undefined;
      // Delegation weight (bps) — METADATA ONLY. Accept only an integer in the
      // chain-valid 1..10000 range; anything else is dropped (no % shown).
      const acceptedDelegationWeightBps =
        typeof p.delegationWeightBps === "number" &&
        Number.isInteger(p.delegationWeightBps) &&
        p.delegationWeightBps >= 1 &&
        p.delegationWeightBps <= 10_000
          ? p.delegationWeightBps
          : undefined;
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "send is only wired for Monolythium Testnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      // NN-01: bind to the active vault at handler entry, before the passkey-cap
      // + nonce/fee/sign awaits below (any of which yields the event loop to a
      // concurrent vault-select). The per-vault passkey-cap block reads the
      // active id again for cap eval; this binding is for the signer identity.
      const boundVaultId = getActiveVaultIdV4();
      if (boundVaultId === null) {
        return { ok: false, reason: "wallet locked" };
      }
      // S6 #45 B1: a multisig active vault must use the propose/approve flow —
      // refuse before the passkey-cap + nonce/fee/sign work below.
      if (await activeVaultIsMultisig()) {
        return { ok: false, reason: MULTISIG_SEND_REFUSAL };
      }
      // T1-04(a): LOCAL defense-in-depth enforcement of the per-vault passkey
      // spending cap on BARE VALUE TRANSFERS (real contract calls are out of
      // policy scope). Until now the cap was advisory (popup amber badge
      // only); enforce it here so the displayed limit is a real block. An
      // over-limit send requires an SW-VERIFIED password re-auth — NOT a
      // popup-asserted flag, which the already-unlocked local IPC actor this
      // gate targets could forge. This is local defense-in-depth, NOT
      // cryptographic passkey authorization (that needs the chain precompile).
      //
      // A bare value transfer is `data === undefined` OR an empty `data` of
      // "0x": tx-mldsa normalizes input to "0x" either way, so a "0x" data
      // field is byte-identical to a native transfer and must be capped too —
      // otherwise an over-limit native-equivalent transfer could slip past the
      // cap by sending data:"0x". (data === "" is already rejected by the
      // 0x-prefix validation above; only "0x" reaches here.)
      const isBareValueTransfer = p.data === undefined || p.data === "0x";
      if (isBareValueTransfer) {
        const activeVaultId = getActiveVaultIdV4();
        if (activeVaultId) {
          const pkState = await readPasskeyStateV4(activeVaultId);
          if (pkState.policy.enabled && pkState.credentials.length > 0) {
            let pkValue: bigint;
            try {
              pkValue = BigInt(p.valueWeiHex);
            } catch {
              return { ok: false, reason: "valueWeiHex is not a hex bigint" };
            }
            const recentUsage = await readPasskeyUsageEntries(activeVaultId);
            const decision = evaluatePasskeyPolicy({
              state: pkState,
              valueWei: pkValue,
              recentUsage,
              now: Date.now(),
            });
            if (decision.kind === "over-limit") {
              const human =
                decision.mode === "per-tx"
                  ? "amount exceeds the per-tx passkey limit — password unlock required"
                  : "amount exceeds the daily passkey cap — password unlock required";
              if (
                typeof p.elevatedPassword !== "string" ||
                p.elevatedPassword.length === 0
              ) {
                return {
                  ok: false,
                  passkeyElevation: "required" as const,
                  reason: human,
                };
              }
              // SW-verified elevated re-auth. Share the brute-force lockout
              // counters with unlock/export-seed/reset so the send path can't
              // become an unthrottled password oracle (the Argon2id cost is a
              // further natural throttle).
              const ses = await chrome.storage.session.get([
                SESSION_KEY_UNLOCK_FAIL_COUNT,
                SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
              ]);
              let failCount =
                typeof ses[SESSION_KEY_UNLOCK_FAIL_COUNT] === "number"
                  ? (ses[SESSION_KEY_UNLOCK_FAIL_COUNT] as number)
                  : 0;
              let lockoutUntil =
                typeof ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] === "number"
                  ? (ses[SESSION_KEY_UNLOCK_LOCKOUT_UNTIL] as number)
                  : 0;
              const nowMs = Date.now();
              if (lockoutUntil > nowMs) {
                return {
                  ok: false,
                  passkeyElevation: "rate_limited" as const,
                  reason: "rate_limited",
                  secondsRemaining: Math.ceil((lockoutUntil - nowMs) / 1000),
                };
              }
              const verified = await verifyContainerPasswordV4(
                p.elevatedPassword,
              );
              if (!verified) {
                failCount += 1;
                const ms = lockoutMsFor(failCount);
                if (ms > 0) lockoutUntil = Date.now() + ms;
                await chrome.storage.session.set({
                  [SESSION_KEY_UNLOCK_FAIL_COUNT]: failCount,
                  [SESSION_KEY_UNLOCK_LOCKOUT_UNTIL]: lockoutUntil,
                });
                return {
                  ok: false,
                  passkeyElevation: "wrong_password" as const,
                  reason: "wrong_password",
                  secondsRemaining: ms > 0 ? Math.ceil(ms / 1000) : 0,
                };
              }
              await chrome.storage.session.remove([
                SESSION_KEY_UNLOCK_FAIL_COUNT,
                SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
              ]);
            }
          }
        }
      }
      try {
        // Local pending-nonce: max(committed, last-submitted+1) so a 2nd tx
        // sent before the 1st commits gets the NEXT nonce instead of reusing
        // it (the chain has no pending-nonce read). See nextNonceHex.
        const nonceHex = await nextNonceHex(fromAddr, p.chainIdHex);
        const fee = await suggestFee(p.chainIdHex);
        // T4-04 (Item D, b1): if the popup bound the exact fee it displayed,
        // sign THAT instead of a second operator read (closes the display-vs-
        // sign double-read + the Slow/Fast tier-multiplier desync). Absent /
        // malformed → fall back to suggestFee (legacy callers, e.g. Stake).
        const bound = acceptSignedFee(p.signedFee);
        // the testnet's mempool enforces an intrinsic execution-unit floor
        // that the compatibility estimate does not reflect. Native transfers
        // use the pre-resolved hex from suggestFee; contract calls carry
        // their caller-supplied estimate because the hint is sized for native
        // transfers only.
        const rawGasHex =
          p.gasLimitHex ?? bound?.executionUnitLimitHex ?? fee.gasLimit ?? TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX;
        // F-3.11 (#28): clamp the resolved execution-unit LIMIT to a sane
        // ceiling, mirroring the per-unit-price clamp below. Defense-in-depth
        // against a future non-UI caller supplying an absurd limit; the ceiling
        // (MAX_EXECUTION_UNIT_LIMIT) is far above any legitimate budget so a
        // real native transfer / precompile call / MRV submission is unchanged.
        const gasHex =
          "0x" + clampToSaneBound(BigInt(rawGasHex), MAX_EXECUTION_UNIT_LIMIT).toString(16);
        // T4-04 (Item D, a1): clamp the per-execution-unit price to a sane
        // ceiling so a malicious/MITM operator (or a tampered popup) cannot
        // sign an absurd maxFeePerGas. Applies to BOTH the bound fee and the
        // suggestFee fallback.
        const maxFeePerGas =
          "0x" +
          clampToSaneBound(
            BigInt(bound?.maxFeePerGasHex ?? fee.maxFeePerGas),
            MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
          ).toString(16);
        // SDK 0.3.11 sane fee defaults: the priority tip never exceeds the
        // max execution-unit price the wallet is willing to pay. A tip above
        // the ceiling would be silently re-clamped chain-side; clamp here so
        // the displayed fee and the submitted fee agree.
        const maxPriorityFeePerGas = clampPriorityTipToMaxFee(
          bound?.maxPriorityFeePerGasHex ?? fee.maxPriorityFeePerGas,
          maxFeePerGas,
        );
        const txReq: EthSendTxFields = {
          to: p.to,
          value: p.valueWeiHex,
          ...(p.data !== undefined ? { data: p.data } : {}),
          gas: gasHex,
          nonce: nonceHex,
          maxFeePerGas,
          maxPriorityFeePerGas,
          chainIdHex: p.chainIdHex,
        };
        const { txHash, via } = await submitMlDsaTx(txReq, boundVaultId);
        // Advance the local pending-nonce now that the submit was accepted, so
        // a 2nd tx sent before this one commits doesn't reuse this nonce.
        // Awaited (small session write) so the next send sees it immediately.
        // Only the success path reaches here — a reject throws to the catch.
        await recordSubmittedNonce(fromAddr, p.chainIdHex, nonceHex);
        // Fire-and-forget pending-row write. Unawaited so
        // Send-screen response latency is preserved (pending row lands
        // ~50-200ms after the popup receives txHash). Errors are
        // swallowed inside the helper; a pending-write failure is
        // silent UX degradation only. Reached only on the success path:
        // a failed broadcast jumps to the catch block below and never
        // executes this line.
        void persistPendingRowBackground({
          address: fromAddr,
          chainIdHex: p.chainIdHex,
          txHash,
          to: p.to,
          valueWeiHex: p.valueWeiHex,
          via,
          // Metadata-only: opKind never reached submitPlaintextMlDsaTx —
          // it travels straight from the popup → here → the pending-row
          // record for the notifications hook to read back.
          ...(acceptedOpKind !== undefined ? { opKind: acceptedOpKind } : {}),
          ...(acceptedClusterId !== undefined ? { clusterId: acceptedClusterId } : {}),
          ...(acceptedClusterName !== undefined
            ? { clusterName: acceptedClusterName }
            : {}),
          ...(acceptedToClusterId !== undefined ? { toClusterId: acceptedToClusterId } : {}),
          ...(acceptedToClusterName !== undefined
            ? { toClusterName: acceptedToClusterName }
            : {}),
          // Reward-claim metadata — only meaningful when opKind:"claim"; the
          // helper gates the local-claim write on opKind. Metadata-only.
          ...(acceptedClaimedAmount !== undefined
            ? { claimedAmount: acceptedClaimedAmount }
            : {}),
          ...(acceptedRateAtClaim !== undefined
            ? { rateAtClaim: acceptedRateAtClaim }
            : {}),
          ...(acceptedCurrency !== undefined ? { currency: acceptedCurrency } : {}),
          // Delegation weight (bps) — metadata only; the % the notification shows.
          ...(acceptedDelegationWeightBps !== undefined
            ? { delegationWeightBps: acceptedDelegationWeightBps }
            : {}),
        });
        return { ok: true, txHash, via };
      } catch (e) {
        // Forward method + via when testnetJsonRpc stamped them onto
        // the error (see tx-mldsa.ts body.error branch). Popup's Send
        // ErrorView uses these for method-aware copy that distinguishes
        // pre-submit RPC failures from real submission rejects.
        const err = e as Error & {
          code?: number;
          via?: string;
          method?: string;
        };
        const code = typeof err.code === "number" ? err.code : undefined;
        const method = typeof err.method === "string" ? err.method : undefined;
        const via = typeof err.via === "string" ? err.via : undefined;
        const reason = err.message ?? "send failed";
        return {
          ok: false,
          reason,
          ...(code !== undefined && { code }),
          ...(method !== undefined && { method }),
          ...(via !== undefined && { via }),
        };
      }
    }
    case "notifications-list": {
      // Global inbox: every `mono.notifications.history.*`
      // entry merged + sorted newest-first. The popup's Notifications
      // page renders this verbatim. §0.4: no notification-creating IPC
      // is added — only reads + mark-as-read. `recordNotification` stays
      // SW-only (only the wallet's own tracked-tx terminal transitions
      // can emit).
      try {
        // S6 #44 B3: scope the inbox to the active vault's address (null when
        // locked → empty), so vault B's notifications never render under A.
        const records = await listAllNotifications(
          getUnlockedAddressV4()?.toLowerCase() ?? null,
        );
        return { ok: true, records };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-mark-all-read": {
      // Flip every record across every scope's history to
      // read:true. Returns the count of records that changed; the
      // toolbar badge clears on the next `refreshUnreadBadge` call,
      // which we also fire here so the pip updates without waiting
      // for the next snapshot tick.
      try {
        // S6 #44 B3: same active-address scope for the flip AND the badge
        // refresh, so the toolbar pip stays consistent with the inbox.
        const a = getUnlockedAddressV4()?.toLowerCase() ?? null;
        const { flipped } = await markAllNotificationsRead(a);
        // Best-effort badge refresh — a badge failure is harmless.
        void refreshUnreadBadge({ unlocked: isUnlockedV4(), activeAddrLower: a });
        return { ok: true, flipped };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-get-unread": {
      // Global unread count for the MainMenu's bell-row pill
      // (matches the toolbar badge). Derived from history; no separate
      // counter key.
      try {
        // S6 #44 B3: active-vault unread count (null when locked → 0), matching
        // the inbox + toolbar badge.
        const count = await getUnread(
          getUnlockedAddressV4()?.toLowerCase() ?? null,
        );
        return { ok: true, count };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-get-os-enabled": {
      // Read the user-facing OS-toast toggle. Default true
      // (absent ⇒ on). §0.4 still holds: this is read-only.
      try {
        const enabled = await getOsNotificationsEnabled();
        return { ok: true, enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-mark-read": {
      // Flip ONE record's read flag to true. The id payload
      // is validated as a non-empty string at the IPC boundary so the
      // store helper never sees garbage. Fires refreshUnreadBadge on a
      // successful flip so the toolbar badge updates without waiting
      // for the next snapshot tick (and the popup's onChanged listener
      // refreshes the top-bar bell dot). §0.4 holds: this is a WRITE to
      // an existing record's UI read flag — NOT a notification-creating
      // IPC. recordNotification stays SW-only.
      const p = (message.payload ?? {}) as { id?: unknown };
      if (typeof p.id !== "string" || p.id.length === 0) {
        return { ok: false, reason: "id must be a non-empty string" };
      }
      try {
        // S6 #44 B3: scope the flip + badge refresh to the active address.
        const a = getUnlockedAddressV4()?.toLowerCase() ?? null;
        const r = await markNotificationRead(p.id, a);
        if (r.flipped)
          void refreshUnreadBadge({ unlocked: isUnlockedV4(), activeAddrLower: a });
        return { ok: true, flipped: r.flipped };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-set-os-enabled": {
      // Write the user-facing OS-toast toggle. Boolean
      // validated at the IPC boundary (anything non-boolean is rejected
      // before touching storage). Gates ONLY the OS toast; history +
      // badge keep running regardless on the chokepoint hook side, so
      // the notifications center remains the durable record.
      const p = (message.payload ?? {}) as { enabled?: unknown };
      if (typeof p.enabled !== "boolean") {
        return { ok: false, reason: "enabled must be boolean" };
      }
      try {
        await setOsNotificationsEnabled(p.enabled);
        return { ok: true, enabled: p.enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    // Three additional boolean toggles, mirroring the
    // Phase-5 os-enabled get/set (boolean-validated at the boundary; default
    // true; local-only). Each gates an on-screen surface only — never the
    // in-app history record.
    case "notifications-get-show-details": {
      try {
        return { ok: true, enabled: await getShowDetails() };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-set-show-details": {
      const p = (message.payload ?? {}) as { enabled?: unknown };
      if (typeof p.enabled !== "boolean") {
        return { ok: false, reason: "enabled must be boolean" };
      }
      try {
        await setShowDetails(p.enabled);
        return { ok: true, enabled: p.enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-get-notify-when-locked": {
      try {
        return { ok: true, enabled: await getNotifyWhenLocked() };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-set-notify-when-locked": {
      const p = (message.payload ?? {}) as { enabled?: unknown };
      if (typeof p.enabled !== "boolean") {
        return { ok: false, reason: "enabled must be boolean" };
      }
      try {
        await setNotifyWhenLocked(p.enabled);
        return { ok: true, enabled: p.enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-get-badge-when-locked": {
      try {
        return { ok: true, enabled: await getBadgeWhenLocked() };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-set-badge-when-locked": {
      const p = (message.payload ?? {}) as { enabled?: unknown };
      if (typeof p.enabled !== "boolean") {
        return { ok: false, reason: "enabled must be boolean" };
      }
      try {
        await setBadgeWhenLocked(p.enabled);
        return { ok: true, enabled: p.enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-get-incoming-enabled": {
      try {
        return { ok: true, enabled: await getIncomingEnabled() };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "notifications-set-incoming-enabled": {
      const p = (message.payload ?? {}) as { enabled?: unknown };
      if (typeof p.enabled !== "boolean") {
        return { ok: false, reason: "enabled must be boolean" };
      }
      try {
        await setIncomingEnabled(p.enabled);
        return { ok: true, enabled: p.enabled };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    default:
      return { error: `unknown popup op ${message.op}` };
  }
}

// ---- notifications — top-level listener registrations ----
//
// MV3 re-inits the SW per event; listeners added inside an async path can
// be missed. Register `chrome.notifications.onClicked` here at module top
// level BEFORE the onMessage router so a click delivered to a freshly-
// woken SW finds a handler. The handler opens Monoscan for the canonical
// inner tx hash parsed off the notification id. Refresh the toolbar
// badge once at startup so the unread pip is correct after a re-init.

installNotificationsClickListener();
void refreshUnreadBadge({
  unlocked: isUnlockedV4(),
  activeAddrLower: getUnlockedAddressV4()?.toLowerCase() ?? null,
});

// ---- message routing ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const m = message as { kind?: string };
  // T2-02 — fail-closed sender authentication. Reject any message that does
  // not originate from THIS extension. `externally_connectable` is absent, so
  // a web page cannot reach this router today; this verifies that invariant
  // rather than assuming it (defense-in-depth). The bridge-stamped
  // `message.origin` remains the per-dApp authorization key for rpc.
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  // Keepalive ping. The popup fires this on mount to
  // wake the SW out of MV3 idle before any real call goes out;
  // synchronous reply, no work, no auto-lock reset.
  // Anything that touches state belongs in the popup or rpc branch.
  if (m?.kind === "ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (m?.kind === "announce") {
    // T2-01 residual close — the content-script bridge announces its origin on
    // load (document_start), BEFORE its first rpc. Refresh the SAME tabId->origin
    // map the rpc branch maintains so a cross-origin navigation flips the entry
    // the instant the new page loads, not at the tab's next rpc. This shrinks
    // the stale-mapping window to the content-script load instant — without the
    // "tabs"/"webNavigation" permission. Gated by `sender.id === runtime.id`
    // above (C5); deliberately NOT routed through the popup-URL branch — a
    // content script's `sender.url` is the page URL, which that branch correctly
    // rejects. The announced origin is trusted exactly as the rpc-stamped origin
    // (same ISOLATED-world source, the per-dApp authz key) — no new trust surface.
    const ann = message as { origin?: unknown };
    const annTabId = sender.tab?.id;
    if (typeof annTabId === "number" && typeof ann.origin === "string") {
      tabOriginById.set(annTabId, ann.origin);
      // Initial provider-state sync. The page-local provider seeds its
      // eth_accounts/eth_chainId caches from this reply, so it must reflect
      // POST-hydration state: on a cold SW start (a page reload typically
      // wakes the SW) connectedOrigins / chainId / the session-rehydrated
      // unlock are restored by the boot path — await it before answering.
      // The connection check runs inside connectionScopedProviderState AT
      // REPLY TIME (after the await), so an origin revoked while we waited
      // gets no accounts. Non-connected and locked origins receive
      // accounts: [] — the chainId is public (same posture as the
      // eth_chainId arm), the empty array carries no account data, and a
      // uniform reply lets every page's provider settle immediately instead
      // of burning its sync timeout on silence.
      const announcedOrigin = ann.origin;
      void (async () => {
        try {
          await bootHydrated;
        } catch {
          // Hydration failure → answer current (possibly empty) state; the
          // provider's pushed-event updates still correct it later.
        }
        sendResponse(connectionScopedProviderState(announcedOrigin));
      })();
      return true;
    }
    return false;
  }
  if (m?.kind === "rpc") {
    const rpc = message as RpcMessage;
    // T2-01 — remember which tab speaks for which origin so account-carrying
    // events can be scoped to connected origins (no "tabs" permission needed;
    // the origin is the one the content bridge stamped on this message).
    const tabId = sender.tab?.id;
    if (typeof tabId === "number" && typeof rpc.origin === "string") {
      tabOriginById.set(tabId, rpc.origin);
    }
    handleRpc(rpc)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: { code: -32603, message: String(e) } }));
    return true;
  }
  if (m?.kind === "popup") {
    // Popup-internal ops (resolve / revoke / keystore / …) must come from a
    // popup document, not a content script that merely shares this extension
    // id. A compromised content script can reach the rpc branch (and is gated
    // there by message.origin + per-op approval) but must NOT reach popup ops.
    if (!sender.url?.startsWith(chrome.runtime.getURL("src/popup/"))) {
      return false;
    }
    handlePopup(message as PopupMessage)
      .then((reply) => {
        sendResponse(reply);
        const op = (message as PopupMessage).op;
        if (!AUTO_LOCK_EXEMPT_OPS.has(op) && isUnlockedV4()) {
          void resetAutoLock();
        }
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  // After an applied update (or fresh install) any persisted "update available"
  // verdict is stale by construction — the running version IS the new version.
  // Clear it so the next popup open re-derives cleanly (the fresh-install path);
  // otherwise the banner persists behind the 12h check gate + throttle
  // stickiness (see the 2026-06-16 update-banner inspect).
  void reconcileWalletUpdateOnInstalled(details.reason);
});

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    rejectByWindow(winId);
  });
}

// Reconcile the persisted approval queue with the (empty) in-memory state on
// every SW startup. After the worker sleeps, storage outlives the in-memory
// `pending` Map; without this reset the popup would render zombie rows whose
// Promise resolvers no longer exist.
void clearPending();
