// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts        (real popup approval)
//   - eth_chainId / net_version
//   - eth_sendTransaction        (real RLP build + secp256k1 sign + raw broadcast)
//   - eth_sign / personal_sign   (real secp256k1 sign over the EIP-191 prefix)
//   - eth_signTypedData_v4       (EIP-712 typed-data signing)
//   - eth_sendRawTransaction     (proxy through MonolythiumProvider)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain    (real approval UI; persists to chrome.storage)
//
// Plus internal channels used by the popup:
//   - get-pending-approval
//   - resolve-approval
//   - keystore.{status, unlock, lock, create-from-new, create-from-mnemonic}
//
// Chain reads/writes go through `MonolythiumProvider` from
// `@monolythium/core-sdk` — the ethers v6 shim. The shim re-uses the SDK's
// JSON-RPC transport (no raw fetch in this file), so any future SDK transport
// feature (auth headers, ws upgrade, registry-aware routing) lights up for the
// wallet automatically.

import {
  MonolythiumProvider,
  MONOLYTHIUM_TESTNET_CHAIN_ID,
} from "@monolythium/core-sdk";
import {
  buildWalletMrvCallNativePlan,
  buildWalletMrvDeployNativePlan,
  walletMrvNativePlanToSubmitTx,
  type WalletMrvNativeSubmissionPlan,
  type WalletMrvCallNativePlanInput,
  type WalletMrvDeployNativePlanInput,
} from "../shared/mrv-native-plan.js";
import {
  enqueue as enqueueApproval,
  resolve as resolveApproval,
  rejectByWindow,
  getPending,
  listPending,
  clearPending,
  focusApproval,
  type ApprovalDecision,
  type SendTxView,
  type AddChainSpec,
  type TypedDataEnvelope,
} from "./approvals.js";
import {
  hasVault,
  hasLegacyVault,
  getStoredAddress,
  getUnlockedAddress,
  isUnlocked,
  lock as lockKeystore,
  unlock as unlockKeystore,
  personalSign as keystorePersonalSign,
  signLegacyTx,
  signTypedDataV4,
  computeTypedDataDigest,
} from "./keystore.js";
import {
  isUnlockedV4,
  getUnlockedAddressV4,
  hasVaultV4,
  getStoredAddressV4,
  lockV4,
  createVaultFromNewMnemonic,
  createVaultFromMnemonic,
  exportMnemonicV4,
  wipeVaultV4,
  personalSignV4,
  signTypedDataV4FromV4,
  getUnlockedPublicKeyV4,
  // Phase 5 multi-vault surface (Commit 2).
  hasContainerV4,
  unlockContainerV4,
  selectActiveVaultV4,
  listVaultsV4,
  renameVaultV4,
  addVaultFreshV4,
  addVaultImportV4,
  wipeContainerV4,
  // Phase 8 multisig surface (Commit 1).
  addVaultMultisigV4,
  readMultisigMetaV4,
  writeMultisigMetaV4,
  getVaultPubkeyV4,
  signWithVaultV4,
  // Phase 9 passkey surface (Commit 1).
  readPasskeyStateV4,
  addPasskeyCredentialV4,
  removePasskeyCredentialV4,
  setPasskeyPolicyV4,
  // Phase 10 SLH-DSA emergency-backup surface (Commit 1+2+4).
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
} from "./keystore-mldsa.js";
import type { PasskeyCredential, PasskeyPolicy } from "../shared/passkey.js";
import {
  DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
  DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
  evaluatePolicy as evaluatePasskeyPolicy,
  validateCredentialName,
  validatePasskeyPolicy,
} from "../shared/passkey.js";
import {
  loadTwoTierState,
  setTwoTierFeature,
} from "./two-tier-features-store.js";
import {
  FEATURE_FLAGS,
  type FeatureFlag,
} from "../shared/two-tier-features.js";
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
import { shake256 } from "@noble/hashes/sha3.js";
import {
  chainRequiresMlDsa,
  SPRINTNET_TRANSFER_GAS_LIMIT_HEX,
  probeFirstAliveOperator,
  BUILTIN_CHAINS as BUILTIN_CHAINS_LIST,
  loadOperatorOverride,
  setOperatorOverride,
  readOperatorOverride,
  getDefaultOperators,
  getActiveOperators,
  verifyOperatorGenesis,
  snapshotGenesisCache,
  clearGenesisCache,
} from "./networks.js";
import {
  STORAGE_KEY_OPERATOR_OVERRIDE,
  validateOperatorList,
} from "../shared/operators.js";
import {
  activityCacheKey,
  activityPendingKey,
  mergeIndexerSnapshot,
  evictExpiredPending,
  reconcilePending,
  validateActivityCache,
  validatePendingActivityCache,
  type ActivityCache,
  type PendingTxRow,
  type RawAddressActivity,
  type RawDelegationHistory,
} from "../shared/activity.js";
import {
  STORAGE_KEY_NAME_CACHE,
  mergeNameCache,
  evictExpiredNames,
  validateNameCache,
  type NameLabelRecord,
  type NameLabel,
  type NameCache,
} from "../shared/name-resolution.js";
import {
  submitEncryptedMlDsaTx,
  sprintnetJsonRpc,
  sprintnetMaxBalanceConsensus,
} from "./tx-mldsa.js";
import { getWsClient, type WsStatus } from "./ws-client.js";
import {
  DEFAULT_ACTIVITY_KIND_ENVELOPE,
  normaliseActivityKind,
} from "../shared/activity-kind.js";
import {
  WALLET_KNOWN_INDEXER_SCHEMA_VERSION,
  validateIndexerStatusWire,
} from "../shared/indexer-status.js";
import {
  collectWalletBridgeRouteDisclosures,
  validateWalletTokenBalanceList,
  type WalletBridgeRouteDisclosure,
  type WalletBridgeRouteReadiness,
  type WalletTokenBalance,
} from "../shared/token-balances.js";
import {
  readClusterDelegators,
  readClusterDirectory,
  readClusterStatus,
  readDelegationHistory,
  readDelegations,
  readDelegationCap,
  readPendingRewards,
  readRedemptionQueue,
} from "./staking-client.js";
import { readBridgeRoutes } from "./bridge-routes-client.js";

interface WalletMrvNativeReceiptEvidence {
  schema: string | null;
  txType: number | null;
  artifactHash: string | null;
  receiptCommitment: string | null;
  eventCount: number | null;
  noEvmProofStatus: "missing" | "present-unverified";
}

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
  ALARM_AUTO_LOCK,
  AUTO_LOCK_EXEMPT_OPS,
  AUTO_LOCK_MINUTES_DEFAULT,
  AUTO_LOCK_OPTIONS,
  LOCKOUT_THRESHOLDS,
  SESSION_KEY_AUTO_LOCK_DEADLINE,
  SESSION_KEY_UNLOCK_FAIL_COUNT,
  SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
  SESSION_KEY_WALLET_LOCKED,
  STORAGE_KEY_AUTO_LOCK_MINUTES,
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
  /** True for Foundation-attested official chains (Sprintnet). */
  official?: boolean;
  /** Optional explorer URL surfaced by `wallet_addEthereumChain`. */
  blockExplorer?: string;
  /** Native currency descriptor (default: LYTH 18). */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

// Canonical chain id for the LythiumDAG-BFT testnet (Law §13.1, mirrored by
// the SDK's `MONOLYTHIUM_TESTNET_CHAIN_ID`). Stored as the upper-cased hex
// quantity so chain-registry lookups don't drift on casing.
const TESTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // 0x10F2C

// Built-in chains derived from networks.ts. v4.0 ships Sprintnet only;
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

async function persistUserChains(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [USER_CHAINS_STORAGE_KEY]: userChains }, () =>
      resolve(),
    );
  });
}

/**
 * Load the persisted active chain id from chrome.storage. Returns the
 * Sprintnet default when nothing is stored yet (first launch) or when
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

console.log("[Monolythium Wallet] service worker boot");
// Hydrate user-added chains and the persisted active chain id as soon as
// the worker spins up. Service-worker hibernation → we re-read on every
// boot. The active-chain hydration runs after user-chains so a stored id
// pointing at a user-added chain resolves cleanly via lookupChain.
void (async () => {
  // Force-lock first — before any hydration await that could fail. SW
  // restart always drops the in-memory ML-DSA backend held by
  // keystore-mldsa.ts, so persistent state must say walletLocked=true to
  // match. Hoisted ahead of the hydration awaits so a throw in
  // loadConnectedSites / loadUserChains / etc. (cf. 5316b25) can't leave
  // the flag stale at false. Popup's onChanged listener (a1068b6) picks
  // up the write and routes to UnlockScreen if open.
  await chrome.storage.session.remove(SESSION_KEY_AUTO_LOCK_DEADLINE);
  await chrome.storage.session.set({ [SESSION_KEY_WALLET_LOCKED]: true });

  await loadUserChains();
  await loadOperatorOverride();
  session.chainId = await loadActiveChainId();

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
})();

// Hot-reload the operator override when storage changes. The popup's
// sprintnet-operators-set IPC writes here and the in-memory activeOperators
// list re-syncs; the `cachedOperator` answer used by the chain-status
// banner + chain-health poll is also invalidated so the next probe picks
// up the new list immediately rather than waiting for the 10s TTL.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!(STORAGE_KEY_OPERATOR_OVERRIDE in changes)) return;
  void loadOperatorOverride();
  cachedOperator = null;
  // GAP #11: a fresh override list may add an operator that was never
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

async function resetAutoLock(): Promise<void> {
  await chrome.alarms.clear(ALARM_AUTO_LOCK);
  if (isUnlockedV4()) {
    await chrome.alarms.create(ALARM_AUTO_LOCK, {
      delayInMinutes: session.autoLockMinutes,
    });
    const deadline = Date.now() + session.autoLockMinutes * 60_000;
    await chrome.storage.session.set({
      [SESSION_KEY_AUTO_LOCK_DEADLINE]: deadline,
      [SESSION_KEY_WALLET_LOCKED]: false,
    });
  } else {
    await chrome.storage.session.remove(SESSION_KEY_AUTO_LOCK_DEADLINE);
  }
}

async function triggerAutoLock(): Promise<void> {
  lockV4();
  await chrome.alarms.clear(ALARM_AUTO_LOCK);
  await chrome.storage.session.remove(SESSION_KEY_AUTO_LOCK_DEADLINE);
  await chrome.storage.session.set({ [SESSION_KEY_WALLET_LOCKED]: true });
}

// Suspend the auto-lock alarm while a separate-window approval is open.
// Without this, a slow user can find the wallet locked at the moment they
// click Approve — the approval window doesn't fire any popup IPC ops, so the
// usual `resetAutoLock()` on activity never runs. Counter so concurrent
// approvals (different origins) all have to close before the alarm restarts.
async function pauseAutoLock(): Promise<void> {
  await chrome.alarms.clear(ALARM_AUTO_LOCK);
  await chrome.storage.session.remove(SESSION_KEY_AUTO_LOCK_DEADLINE);
}

let openApprovalCount = 0;

// Phase 11 Commit 2 — WS infrastructure module state.
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

async function approvalOpened(): Promise<void> {
  openApprovalCount++;
  await pauseAutoLock();
}

async function approvalClosed(): Promise<void> {
  openApprovalCount = Math.max(0, openApprovalCount - 1);
  if (openApprovalCount === 0) {
    await resetAutoLock();
  }
}

/** enqueueApproval wrapped in approvalOpened/Closed so the auto-lock alarm
 *  stays paused for the lifetime of the approval window. */
async function gatedEnqueue(
  req: Parameters<typeof enqueueApproval>[0],
): Promise<ApprovalDecision> {
  await approvalOpened();
  try {
    return await enqueueApproval(req);
  } finally {
    await approvalClosed();
  }
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

/**
 * Build a `MonolythiumProvider` for the given chain. The provider is the
 * ethers v6 shim from `@monolythium/core-sdk` and re-uses the SDK's transport,
 * so every JSON-RPC call benefits from the SDK's error envelope handling.
 *
 * We keep an in-memory cache keyed by `<chainId, rpcUrl>` so each chain reuses
 * a single transport across calls — the service worker rebuilds the cache on
 * cold start, which is fine because the underlying transport holds no state
 * beyond the endpoint URL.
 */
const providerCache = new Map<string, MonolythiumProvider>();

function providerFor(chainId: string): MonolythiumProvider {
  const net = lookupChain(chainId);
  if (!net) throw new Error(`unknown chain ${chainId}`);
  const key = `${chainId}|${net.rpc}`;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = new MonolythiumProvider(net.rpc, {
      network: { chainId: BigInt(net.chainIdNum), name: net.name },
    });
    providerCache.set(key, provider);
  }
  return provider;
}

/**
 * Send a single JSON-RPC method through the SDK transport that the
 * `MonolythiumProvider` uses. Surfaces `{ result }` / `{ error }` from the
 * provider's `_send` exactly as a JSON-RPC server would, then unwraps to a
 * native value or throws.
 */
async function rpcSend<T>(
  provider: MonolythiumProvider,
  method: string,
  params: unknown[],
): Promise<T> {
  const [response] = await provider._send({
    id: 1,
    jsonrpc: "2.0",
    method,
    params,
  });
  if (!response) {
    throw new Error(`provider returned no response for ${method}`);
  }
  if ("error" in response && response.error) {
    const e = new Error(response.error.message ?? `rpc error ${method}`) as Error & { code?: number };
    e.code = response.error.code;
    throw e;
  }
  return (response as { result: T }).result;
}

function broadcastEvent(event: string, payload: unknown): void {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { kind: "event", event, payload }).catch(() => {
        /* tab may not host our content script; ignore */
      });
    }
  });
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
      const addr = getUnlockedAddressV4() ?? (await getStoredAddressV4());
      if (!addr) return ok([]);
      return ok(session.connectedOrigins.has(origin) ? [addr] : []);
    }

    case "eth_requestAccounts": {
      // If wallet doesn't exist yet, surface a clear error so the dapp can
      // tell the user to onboard. We could also auto-open the popup at the
      // onboarding screen — left to next stage.
      if (!(await hasVaultV4())) {
        return err(ERR_UNAUTHORIZED, "Monolythium Wallet has no vault — open the extension and complete onboarding first");
      }
      // Phase 4.0 Decision §9: already-connected origin + unlocked wallet
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
        address: getUnlockedAddressV4() ?? (await getStoredAddressV4()) ?? "",
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the message");
      }
      if (!isUnlockedV4()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      try {
        // v4-strict (Phase 3.5 + 4.0): the wallet's on-chain address is
        // keccak(ml-dsa-65 pubkey). Routing personal_sign through the
        // legacy keystore.ts secp256k1 path would produce a signature
        // whose ecrecover'd address doesn't match `eth_accounts[0]` —
        // and on top of that, the popup unlock flow only populates the
        // v4 backend, so the secp256k1 path throws "wallet is locked"
        // even when the v4 keystore is unlocked. Sign with ML-DSA-65.
        const sig = isUnlockedV4()
          ? personalSignV4(messageParam)
          : await keystorePersonalSign(messageParam);
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
      const txReq = (arr[0] as Record<string, string> | undefined) ?? {};

      // Build the approval view BEFORE opening the popup so the user sees
      // real numbers (gas estimate, simulation outcome, nonce) instead of
      // demo placeholders. RPC failures degrade gracefully — we still let
      // the user approve, but the popup will surface the gap.
      const view = await buildSendTxView(txReq);

      const decision = await gatedEnqueue({
        kind: "send_tx",
        origin,
        tx: txReq,
        view,
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the transaction");
      }

      // Monolythium-protocol chains reject the legacy RLP+secp256k1
      // envelope at the decoder layer (Law §2.1) — route to the SDK's
      // ML-DSA-65 bincode wire format instead. The v3 keystore holds
      // the unlocked backend; reads/writes funnel through the published
      // Sprintnet operators since the canonical alias is NXDOMAIN.
      if (chainRequiresMlDsa(session.chainId)) {
        if (!isUnlockedV4()) {
          return err(ERR_UNAUTHORIZED, "wallet is locked");
        }
        try {
          const fromAddr =
            getUnlockedAddressV4() ?? "0x0000000000000000000000000000000000000000";
          // Resolve missing nonce/execution units/fee from the operators directly —
          // the chain registry's RPC alias resolves NXDOMAIN and the
          // existing `view` was built against that broken alias too, so
          // its fields are usually null on Sprintnet.
          const nonceHex =
            txReq.nonce ?? view.nonce ??
            (await sprintnetJsonRpc<string>("eth_getTransactionCount", [fromAddr, "pending"])).result;
          const gasPriceHex =
            txReq.gasPrice ?? view.gasPrice ??
            (await sprintnetJsonRpc<string>("eth_gasPrice", [])).result;
          // Sprintnet's mempool intrinsic execution-unit floor is above what
          // `eth_estimateGas` reports (the latter only covers EVM
          // execution). Honour an explicit dapp execution-unit hint if provided —
          // a dapp may know better than us and we'd rather surface a
          // chain reject than silently override — otherwise default to
          // the wallet's audited Sprintnet floor with headroom.
          const gasHex =
            txReq.gas ?? view.estimatedGas ?? SPRINTNET_TRANSFER_GAS_LIMIT_HEX;

          // Sign + ML-KEM-768/ChaCha20-Poly1305 wrap + lyth_submitEncrypted.
          // The chain rejects plaintext at admission (Law §4.5 / Q2), so
          // there is no eth_sendRawTransaction fallback path on Sprintnet.
          const { txHash } = await submitEncryptedMlDsaTx({
            ...(txReq.to !== undefined ? { to: txReq.to } : {}),
            ...(txReq.value !== undefined ? { value: txReq.value } : {}),
            ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            nonce: nonceHex,
            gas: gasHex,
            gasPrice: gasPriceHex,
            chainIdHex: session.chainId,
          });
          return ok(txHash);
        } catch (e) {
          return err(ERR_INTERNAL, `ml-dsa tx failed: ${(e as Error).message}`);
        }
      }

      if (!isUnlockedV4()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }

      try {
        const net = lookupChain(session.chainId);
        if (!net) throw new Error(`unknown chain ${session.chainId}`);
        const provider = providerFor(session.chainId);

        // Re-resolve gas with the latest node values at sign time. The view
        // we showed the user is the same shape (and usually identical
        // numbers) but we don't trust stale views to be authoritative.
        const fromAddr = getUnlockedAddressV4() ?? "0x0000000000000000000000000000000000000000";
        const nonceHex =
          txReq.nonce ?? view.nonce ??
          (await rpcSend<string>(provider, "eth_getTransactionCount", [fromAddr, "pending"]));
        const gasPriceHex =
          txReq.gasPrice ?? view.gasPrice ?? (await rpcSend<string>(provider, "eth_gasPrice", []));
        const gasHex =
          txReq.gas ?? view.estimatedGas ??
          (await rpcSend<string>(provider, "eth_estimateGas", [
            {
              from: fromAddr,
              ...(txReq.to !== undefined ? { to: txReq.to } : {}),
              ...(txReq.value !== undefined ? { value: txReq.value } : {}),
              ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            },
          ]));

        const { rawTx, txHash } = await signLegacyTx({
          ...(txReq.to !== undefined ? { to: txReq.to } : {}),
          ...(txReq.value !== undefined ? { value: txReq.value } : {}),
          ...(txReq.data !== undefined ? { data: txReq.data } : {}),
          nonce: nonceHex,
          gas: gasHex,
          gasPrice: gasPriceHex,
          chainId: net.chainIdNum,
        });

        // Best-effort broadcast. If the RPC rejects, surface the message but
        // also return the locally-computed hash so the caller can poll. We
        // strongly prefer a successful broadcast though.
        try {
          const accepted = await rpcSend<string>(provider, "eth_sendRawTransaction", [rawTx]);
          return ok(accepted || txHash);
        } catch (e) {
          return err(ERR_INTERNAL, `broadcast failed: ${(e as Error).message}`);
        }
      } catch (e) {
        return err(ERR_INTERNAL, `tx build failed: ${(e as Error).message}`);
      }
    }

    case "eth_signTypedData_v4":
    case "eth_signTypedData": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      // EIP-712 dapps pass [address, typedData]. Some pass them swapped — we
      // recognize an address-shaped string in either slot to be tolerant.
      let address: string | null = null;
      let dataParam: unknown = null;
      const a = arr[0];
      const b = arr[1];
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        address = a;
        dataParam = b;
      } else if (typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(b)) {
        address = b;
        dataParam = a;
      } else {
        // Fall back: assume canonical [address, data].
        address = typeof a === "string" ? a : "";
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
        address: address ?? getUnlockedAddressV4() ?? (await getStoredAddressV4()) ?? "",
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
        // Same v4 routing as personal_sign — the v4 ML-DSA backend is
        // the one that's unlocked and is the one whose pubkey defines
        // the wallet's on-chain address. See the comment in the
        // personal_sign branch above.
        const sig = isUnlockedV4()
          ? signTypedDataV4FromV4(parsed)
          : await signTypedDataV4(parsed);
        return ok("0x" + bytesToHex(sig));
      } catch (e) {
        return err(ERR_INTERNAL, `typed-data sign failed: ${(e as Error).message}`);
      }
    }

    case "eth_sendRawTransaction": {
      const arr = Array.isArray(params) ? params : [];
      const raw = arr[0];
      if (typeof raw !== "string") {
        return err(-32602, "eth_sendRawTransaction expects a hex string");
      }
      try {
        const provider = providerFor(session.chainId);
        const hash = await rpcSend<string>(provider, "eth_sendRawTransaction", [raw]);
        return ok(hash);
      } catch (e) {
        return err(ERR_INTERNAL, `broadcast failed: ${(e as Error).message}`);
      }
    }

    case "wallet_switchEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_switchEthereumChain: missing chainId param");
      const found = lookupChain(requested);
      if (!found) {
        return err(ERR_CHAIN_NOT_ADDED, "Unknown chain. Use wallet_addEthereumChain first.");
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
 * Pre-populate the `SendTxView` shown on the approval popup. We attempt every
 * RPC in parallel so the popup opens fast; an individual failure leaves that
 * field `null` and the UI surfaces the gap rather than blocking approval.
 */
async function buildSendTxView(
  txReq: Record<string, string>,
): Promise<SendTxView> {
  const chainId = session.chainId;
  const net = lookupChain(chainId);
  const chainLabel = net?.name ?? chainId;

  const view: SendTxView = {
    estimatedGas: txReq.gas ?? null,
    gasPrice: txReq.gasPrice ?? null,
    nonce: txReq.nonce ?? null,
    simulation: null,
    chainId,
    chainLabel,
  };
  if (!net) return view;

  const provider = providerFor(chainId);
  const fromAddr =
    txReq.from ?? getUnlockedAddressV4() ?? (await getStoredAddressV4()) ?? "0x0000000000000000000000000000000000000000";

  const callShape = {
    from: fromAddr,
    ...(txReq.to !== undefined ? { to: txReq.to } : {}),
    ...(txReq.value !== undefined ? { value: txReq.value } : {}),
    ...(txReq.data !== undefined ? { data: txReq.data } : {}),
  };

  type SimResult = SendTxView["simulation"];
  const simPromise: Promise<SimResult> =
    txReq.data && txReq.data !== "0x" && txReq.data.length > 2
      ? rpcSend<string>(provider, "eth_call", [callShape, "latest"])
          .then(
            (r): SimResult => ({ success: true, returnData: r ?? "0x" }),
          )
          .catch(
            (e: Error): SimResult => ({
              success: false,
              error: e.message ?? "revert",
            }),
          )
      : Promise.resolve(null);

  const [gasEst, gasPrice, nonce, sim] = await Promise.all([
    view.estimatedGas != null
      ? Promise.resolve(view.estimatedGas)
      : rpcSend<string>(provider, "eth_estimateGas", [callShape])
          .catch(() => null as string | null),
    view.gasPrice != null
      ? Promise.resolve(view.gasPrice)
      : rpcSend<string>(provider, "eth_gasPrice", [])
          .catch(() => null as string | null),
    view.nonce != null
      ? Promise.resolve(view.nonce)
      : rpcSend<string>(provider, "eth_getTransactionCount", [fromAddr, "pending"])
          .catch(() => null as string | null),
    simPromise,
  ]);

  view.estimatedGas = gasEst;
  view.gasPrice = gasPrice;
  view.nonce = nonce;
  view.simulation = sim;
  return view;
}

// ---- fee suggestion ----

/**
 * Sprintnet-specific minimum priority tip discovered empirically via
 * smoke-test admission rejection: 10_000_000_000 lythoshi per execution unit. The
 * chain doesn't expose this via RPC and `eth_maxPriorityFeePerGas`
 * is method-not-found, so it lives here as a chain constant. If the
 * chain operators ever change the floor, this is the one place to bump.
 */
const SPRINTNET_MIN_PRIORITY_FEE_LYTHOSHI_PER_EXECUTION_UNIT_HEX = "0x2540be400";

// ---- Operator liveness cache ----
//
// Backs the popup's chain-status banner. We probe the published Sprintnet
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
// "first alive Sprintnet operator" answer; caching name+rpc together avoids
// re-running the operator probe loop at the 8-second health-poll cadence.
let cachedOperator: {
  name: string | null;
  rpc: string | null;
  checkedAt: number;
} | null = null;

// ---- Phase 9 — in-memory passkey usage ledger ----
//
// Per-vault list of compatibility-shaped `{ at, valueWei }` entries
// containing lythoshi for txs signed under the passkey-unlock path.
// Used to enforce the daily-cap mode of `PasskeyPolicy`. Lives in memory
// only — SW hibernation drops it, which is fine: the daily cap is purely
// a wallet-side spam guard, not a security invariant, and a fresh SW boot
// starts the window at zero (so a user who reboots their browser and
// immediately makes a large passkey-unlocked tx is the worst-case "the cap
// doesn't bind" scenario — still within the per-tx limit, which is the real
// ceiling).
const passkeyUsage = new Map<string, { at: number; valueWei: bigint }[]>();

/**
 * Suggest `(maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas)` for a
 * given chain. On Sprintnet we ignore `eth_gasPrice` (returns `0x0`)
 * and `eth_maxPriorityFeePerGas` (method-not-found) and instead read
 * the next-block base fee via `eth_feeHistory(1, "latest", [])` and
 * stack the hardcoded lythoshi-per-execution-unit tip floor on top.
 *
 * For non-Sprintnet chains we fall back to `eth_gasPrice` for now —
 * close enough for the legacy path that the popup may eventually use,
 * and the existing `eth_sendTransaction` handler does the same.
 */
async function suggestFee(chainIdHex: string): Promise<{
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  baseFeePerGas: string;
  /** Hex execution-unit limit recommendation. Sprintnet has a known intrinsic
   * floor that `eth_estimateGas` doesn't reflect — surface the
   * pre-resolved value to the popup so the fee preview is accurate.
   * Other chains return null and let the caller estimate themselves. */
  gasLimit: string | null;
}> {
  if (chainRequiresMlDsa(chainIdHex)) {
    const { result } = await sprintnetJsonRpc<{
      baseFeePerGas?: string[];
      gasUsedRatio?: number[];
      oldestBlock?: string;
      reward?: unknown[];
    }>("eth_feeHistory", ["0x1", "latest", []]);
    const baseList = Array.isArray(result?.baseFeePerGas) ? result.baseFeePerGas : [];
    if (baseList.length === 0) {
      throw new Error("eth_feeHistory returned no baseFeePerGas entries");
    }
    // Last entry is the next-block estimate when feeHistory returns the
    // pending base fee; with a single requested block we get two
    // entries (current + next).
    const baseHex = baseList[baseList.length - 1]!;
    const baseLythoshiPerExecutionUnit = BigInt(baseHex);
    const tipLythoshiPerExecutionUnit = BigInt(
      SPRINTNET_MIN_PRIORITY_FEE_LYTHOSHI_PER_EXECUTION_UNIT_HEX,
    );
    return {
      baseFeePerGas: baseHex,
      maxPriorityFeePerGas: SPRINTNET_MIN_PRIORITY_FEE_LYTHOSHI_PER_EXECUTION_UNIT_HEX,
      maxFeePerGas:
        "0x" + (baseLythoshiPerExecutionUnit + tipLythoshiPerExecutionUnit).toString(16),
      gasLimit: SPRINTNET_TRANSFER_GAS_LIMIT_HEX,
    };
  }
  const provider = providerFor(chainIdHex);
  const gasPriceHex = await rpcSend<string>(provider, "eth_gasPrice", []);
  return {
    baseFeePerGas: gasPriceHex,
    maxPriorityFeePerGas: gasPriceHex,
    maxFeePerGas: gasPriceHex,
    gasLimit: null,
  };
}

// ---- Phase 9 passkey IPC marshalling ----
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
  // Phase 9 hotfix: defensive against a degraded in-memory shape.
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

function parseMrvNativeReceiptEvidence(
  raw: unknown,
): WalletMrvNativeReceiptEvidence | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    schema: typeof r.schema === "string" ? r.schema : null,
    txType: typeof r.txType === "number" ? r.txType : null,
    artifactHash: typeof r.artifactHash === "string" ? r.artifactHash : null,
    receiptCommitment: parseMrvReceiptCommitment(r.receiptCommitment),
    eventCount: typeof r.eventCount === "number" ? r.eventCount : null,
    noEvmProofStatus:
      r.noEvmProof === null || r.noEvmProof === undefined
        ? "missing"
        : "present-unverified",
  };
}

function parseMrvReceiptCommitment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : null;
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

async function settleSprintnetRpc<T>(method: string, params: unknown[]): Promise<SettledRpc<T>> {
  try {
    const { result } = await sprintnetJsonRpc<T>(method, params);
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
  addressLabel: unknown | null;
  delegationHistory: unknown[];
  addressActivity: unknown[];
  errors: Record<string, string>;
}

function readTokenBalanceRows(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const r = input as Record<string, unknown>;
  return Array.isArray(r.tokenBalances) ? r.tokenBalances : [];
}

/** Parallel-fetch the four indexer streams used by both popup-facing
 *  snapshots. Token balances are validated at the SW boundary because the
 *  popup renders them directly; other streams keep their existing raw shapes
 *  and are validated by the consumers that need typed rows. */
async function fetchIndexerSnapshot(
  address: string,
  _chainIdHex: string,
): Promise<IndexerSnapshotRaw> {
  const [
    tokenBalances,
    bridgeRoutes,
    addressLabel,
    delegationHistory,
    addressActivity,
  ] = await Promise.all([
    settleSprintnetRpc<unknown>("lyth_getTokenBalances", [address]),
    readBridgeRoutes(),
    settleSprintnetRpc<unknown | null>("lyth_getAddressLabel", [address]),
    settleSprintnetRpc<unknown[]>("lyth_getDelegationHistory", [address, 20]),
    settleSprintnetRpc<unknown[]>("lyth_getAddressActivity", [address, 30]),
  ]);
  const errors: Record<string, string> = {};
  if (tokenBalances.error) errors.tokenBalances = tokenBalances.error;
  if (bridgeRoutes.kind !== "live" && "reason" in bridgeRoutes) {
    errors.bridgeRoutes = bridgeRoutes.reason;
  }
  if (addressLabel.error) errors.addressLabel = addressLabel.error;
  if (delegationHistory.error) errors.delegationHistory = delegationHistory.error;
  if (addressActivity.error) errors.addressActivity = addressActivity.error;
  const rawTokenBalances = readTokenBalanceRows(tokenBalances.value);
  return {
    tokenBalances: validateWalletTokenBalanceList(rawTokenBalances),
    bridgeRouteDisclosures: dedupeWalletBridgeRouteDisclosures([
      ...bridgeRoutes.data.bridgeRouteDisclosures,
      ...collectWalletBridgeRouteDisclosures(tokenBalances.value),
    ]),
    bridgeRouteReadiness: bridgeRoutes.data.readiness,
    addressLabel: addressLabel.value ?? null,
    delegationHistory: Array.isArray(delegationHistory.value) ? delegationHistory.value : [],
    addressActivity: Array.isArray(addressActivity.value) ? addressActivity.value : [],
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

// Phase 7.1 — helpers for the operators-health enrichment. The batched
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
): Promise<{ cache: ActivityCache | null; pending: PendingTxRow[] }> {
  const stored = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get([cacheKey, pendingKey], (res) => resolve(res ?? {}));
  });
  return {
    cache: validateActivityCache(stored[cacheKey]),
    pending: validatePendingActivityCache(stored[pendingKey])?.pending ?? [],
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

// Indexer-staleness threshold for the §28.2.1 banner. The indexer is
// considered "stale" when latestHeight - currentHeight exceeds this
// many blocks. At Sprintnet's 3-second cadence (ADR-0031), 10 blocks
// is ~30 s of indexer lag — wider than normal ingestion variance,
// narrow enough to flag a real backlog before it becomes user-visible.
const INDEXER_LAG_STALE_THRESHOLD = 10;

// Phase 11 Commit 4 — IndexerStatus validator + WALLET_KNOWN_INDEXER_SCHEMA_VERSION
// moved to shared/indexer-status.ts so both the SW (this file) and any
// future popup-side direct consumer share one wire-shape contract.
// `validateIndexerStatus` is now a re-export alias for backward
// compatibility with the existing call site below.
const validateIndexerStatus = validateIndexerStatusWire;

/** Per-address fetch. Returns the resolved label (null = chain has no
 *  entry for this address) or a methodNotFound flag when the operator
 *  returned JSON-RPC -32601. Other RPC errors map to `label: null`
 *  without setting the flag — they're transient, not chain-wide. */
async function fetchOneAddressLabel(
  addr: string,
): Promise<{ label: NameLabel; methodNotFound: boolean }> {
  try {
    const { result } = await sprintnetJsonRpc<unknown>(
      "lyth_getAddressLabel",
      [addr],
    );
    if (result === null) return { label: null, methodNotFound: false };
    return { label: validateRawNameLabel(result), methodNotFound: false };
  } catch (e) {
    const err = e as Error & { code?: number };
    if (err.code === -32601) {
      return { label: null, methodNotFound: true };
    }
    return { label: null, methodNotFound: false };
  }
}

/** Fire-and-forget pending-row writer called from wallet-send-tx after
 *  submitEncryptedMlDsaTx resolves. Designed so a failure here CANNOT
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
 *  amountDecimal field is consistent with what mergeIndexerSnapshot receives
 *  on the confirmed side (AddressActivityEntry.amount is already a decimal
 *  string per the SDK binding). */
async function persistPendingRowBackground(args: {
  address: string;
  chainIdHex: string;
  txHash: string;
  to: string;
  valueWeiHex: string;
  via: string;
}): Promise<void> {
  try {
    const now = Date.now();
    let broadcastBlockHeight: number | null = null;
    try {
      const { result } = await sprintnetJsonRpc<unknown>("eth_blockNumber", []);
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
    const row: PendingTxRow = {
      kind: "pending_tx",
      txHash: args.txHash,
      to: args.to.toLowerCase(),
      amountDecimal,
      broadcastedAtMs: now,
      broadcastBlockHeight,
      via: args.via,
    };
    const evicted = evictExpiredPending(prev, now);
    const next = [row, ...evicted];
    await new Promise<void>((resolve) => {
      chrome.storage.local.set(
        { [pendingKey]: { pending: next } },
        () => resolve(),
      );
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
    case "get-pending": {
      const id = (message.payload as { id?: string } | undefined)?.id;
      return id ? getPending(id) : null;
    }
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
    case "list-connected-sites": {
      return loadConnectedSites();
    }
    case "revoke-origin": {
      const p = message.payload as { origin?: string } | undefined;
      if (!p?.origin) return { ok: false };
      await removeConnectedSite(p.origin);
      session.connectedOrigins.delete(p.origin);
      return { ok: true };
    }
    case "revoke-all-origins": {
      await clearAllConnectedSites();
      session.connectedOrigins.clear();
      return { ok: true };
    }
    case "keystore-status": {
      // Strategy A — v4 (ML-DSA-65) is the new primary vault. Detection
      // order: v4 first (current canonical shape), v2 next (still
      // unlockable for non-Sprintnet chains pending a v2→v4 migration
      // rule), v1 last (PBKDF2+AES-GCM, surfaced as legacy-only so the
      // popup nudges re-creation). v3 storage entries (Phase 3) are
      // unreachable from this code path — the storage key was bumped
      // from "mono.vault.v3" to "mono.vault.v4" in Phase 3.5 Commit A,
      // so any pre-upgrade dev session naturally falls through to
      // Welcome and re-onboards.
      //
      // `legacyVault` is the popup's banner trigger ("vault format
      // upgraded — re-import your seed"). It fires whenever any
      // non-current vault is on disk: v1 always, plus v2 once v4 is
      // the new primary or once we've deprecated v2.
      // Either a legacy single-vault entry (mono.vault.v4) OR a Phase
      // 5 container (mono.vaults.v4) counts as "v4 present" for the
      // popup's gating purposes — both unlock through the same dispatcher
      // handler.
      const v4Exists = (await hasVaultV4()) || (await hasContainerV4());
      const v2Exists = await hasVault();
      const v1Exists = await hasLegacyVault();
      if (v4Exists) {
        return {
          hasVault: true,
          legacyVault: v1Exists || v2Exists,
          unlocked: isUnlockedV4(),
          address: getUnlockedAddressV4() ?? (await getStoredAddressV4()),
          custody: "sw" as const,
          algo: "mldsa" as const,
        };
      }
      // No v4 vault. If a v2 vault exists, the user can still unlock it
      // for legacy chains; the banner flips on so the home/onboarding
      // surface tells them v2 is the older format.
      return {
        hasVault: v2Exists,
        legacyVault: v1Exists || v2Exists,
        unlocked: isUnlocked(),
        address: getUnlockedAddress() ?? (await getStoredAddress()),
        custody: "sw" as const,
        algo: "secp256k1" as const,
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
      // Sprintnet and broadcast chainChanged so connected dApps learn the
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
    case "sprintnet-operators-get": {
      const override = await readOperatorOverride();
      return {
        ok: true,
        override,
        defaults: getDefaultOperators().map((d) => ({ ...d })),
        effective: getActiveOperators().map((d) => ({ ...d })),
      };
    }
    case "sprintnet-operators-health": {
      // About-page operator-table source. Probes every active operator
      // in parallel (net_version + eth_blockNumber) and surfaces the
      // genesis-hash verification result (GAP #11). The inner
      // verifyOperatorGenesis call uses its own forever-cache, so
      // repeated About-page opens don't re-probe block 0; this
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

          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PROBE_BUDGET_MS);
          try {
            const startedAt = Date.now();
            // Phase 7.1 — batched probe extended with capability + indexer
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
              capabilities: null,
              indexerHeight: null,
              indexerLatest: null,
            };
          }
        }),
      );
      return { ok: true, operators: results };
    }
    case "sprintnet-runtime-provenance": {
      // Phase 7.1 — About-page runtime card. Calls `lyth_runtimeProvenance`
      // (SDK commit f67cf0e) via the existing operator-iteration path so
      // the genesis-pin trust check (GAP #11) still applies. Returns a
      // subset of `RuntimeProvenanceResponse` — only fields the About
      // card renders. On chain-offline returns `{ ok: false, reason }`;
      // the About page falls back to a placeholder.
      try {
        const { result, via } = await sprintnetJsonRpc<{
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
    case "sprintnet-operators-set": {
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
    case "keystore-unlock": {
      const p = message.payload as { password: string };
      // Phase 5: prefer the multi-vault container path. unlockContainerV4
      // runs migration opportunistically when a legacy mono.vault.v4
      // entry exists and no container does — the user's existing
      // password is used to decrypt legacy, then the same password
      // derives MEK + wraps a fresh VEK over the migrated seed. Rate
      // limiting wraps both branches identically; every wrong-password
      // attempt counts against the shared SESSION_KEY_UNLOCK_FAIL_COUNT.
      if ((await hasVaultV4()) || (await hasContainerV4())) {
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
      try {
        const r = await unlockKeystore(p.password);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-lock": {
      await triggerAutoLock();
      // Legacy v2 lock kept inline so a v2-only user still locks cleanly
      // through this op; lockV4() inside triggerAutoLock() is idempotent.
      lockKeystore();
      return { ok: true };
    }
    case "keystore-create-new": {
      // Strategy A — every new wallet from this point is v3 (ML-DSA-65).
      // PQM-1 is the canonical recovery format: 24 BIP-39 words carrying
      // the PQM-1 algo/version payload and 30 bytes of entropy.
      const p = message.payload as { password: string };
      try {
        const r = await createVaultFromNewMnemonic(p.password);
        await resetAutoLock();
        return { ok: true, mnemonic: r.mnemonic, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-create-from-mnemonic": {
      const p = message.payload as { password: string; mnemonic: string };
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
      // Password verified — wipe both legacy single-vault entry and the
      // multi-vault container, then broadcast lock. Phase 5 doubles the
      // wipe surface; either entry left behind would let a reset user
      // re-unlock with their old password.
      await wipeVaultV4();
      await wipeContainerV4();
      await chrome.storage.session.remove([
        SESSION_KEY_UNLOCK_FAIL_COUNT,
        SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
      ]);
      await triggerAutoLock();
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
      // Phase 5: same dual-wipe as keystore-reset — legacy entry plus
      // the multi-vault container. Forgot-password → Reset & Import
      // must leave no recoverable key material on disk.
      await wipeVaultV4();
      await wipeContainerV4();
      await chrome.storage.session.remove([
        SESSION_KEY_UNLOCK_FAIL_COUNT,
        SESSION_KEY_UNLOCK_LOCKOUT_UNTIL,
      ]);
      await triggerAutoLock();
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
      // PQM-1 mnemonic and appends a new VaultRecordV4. Does NOT
      // switch the active vault — caller invokes vault-select if
      // desired (gives the popup room to show "Vault N added — switch
      // to it now? [Yes / Keep current]").
      //
      // `label` is optional; the keystore helper validates 1-32 chars
      // when supplied and falls back to its own "Vault N" auto-label
      // otherwise. Phase 5 Commit 4: VaultAddModal threads a
      // user-edited label through this slot.
      const p = (message.payload ?? {}) as { label?: string };
      const label = typeof p.label === "string" ? p.label : undefined;
      try {
        const r = await addVaultFreshV4(label);
        await resetAutoLock();
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
    case "vault-add-import": {
      const p = message.payload as { mnemonic?: string; label?: string };
      if (typeof p?.mnemonic !== "string") {
        return { ok: false, reason: "missing mnemonic" };
      }
      const label = typeof p.label === "string" ? p.label : undefined;
      try {
        const r = await addVaultImportV4(p.mnemonic, label);
        await resetAutoLock();
        return { ok: true, vaultId: r.vaultId, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "vault-add-multisig": {
      // Phase 8 Commit 2 — create a multisig vault inside the
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
      // Phase 8 Commit 2 — read a vault's 1952-byte ML-DSA-65 pubkey
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
      // Phase 8 Commit 3 — create a tx proposal inside a multisig
      // vault's meta. The proposer is the first self-signer in the
      // roster (Commit 4 adds a picker when multiple self-signers
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
    case "multisig-list-proposals": {
      // Convenience read: returns the proposals array for a vault.
      // Equivalent to bgVaultMultisigMeta().meta.proposals but cheaper
      // for callers that only want the proposal list (skips the
      // governance + signers payload). `proposals: null` for single
      // vaults / unknown ids.
      const p = (message.payload ?? {}) as { vaultId?: string };
      if (typeof p.vaultId !== "string") {
        return { ok: false, reason: "missing vaultId" };
      }
      try {
        const meta = await readMultisigMetaV4(p.vaultId);
        return {
          ok: true,
          proposals: meta?.proposals ?? null,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "multisig-sign":
    case "multisig-reject": {
      // Phase 8 Commit 4 — add this wallet's signature to a pending
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
      // Phase 8 Commit 4 — broadcast a proposal that has collected
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
        // Capture the current active vault so we can restore it
        // after broadcasting via the multisig's keypair. Skipping
        // the restore would silently change which vault the popup
        // is "looking at" — confusing UX.
        const before = (await listVaultsV4()) ?? [];
        const previouslyActive = before.find((v) => v.isActive);

        // Switch to the multisig vault so submitEncryptedMlDsaTx
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
          const nonceRes = await sprintnetJsonRpc<string>(
            "eth_getTransactionCount",
            [fromAddr, "latest"],
          );
          const fee = await suggestFee(action.chainIdHex);
          const gasHex =
            action.gasLimitHex ?? fee.gasLimit ?? "0x5208";
          const valueWeiHex =
            action.kind === "send"
              ? action.valueWeiHex
              : action.valueWeiHex ?? "0x0";
          const data = action.kind === "contract" ? action.data : action.data;
          const r = await submitEncryptedMlDsaTx({
            to: action.to,
            value: valueWeiHex,
            ...(data !== undefined ? { data } : {}),
            gas: gasHex,
            nonce: nonceRes.result,
            maxFeePerGas: fee.maxFeePerGas,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
            chainIdHex: action.chainIdHex,
          });
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
      // Phase 8 Commit 5 — propose a signer-set change (add /
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
      // Phase 8 Commit 7 — serialize a proposal (tx or governance)
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
      // Phase 8 Commit 7 — accept a base64 blob from another signer's
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
    // Phase 9 — passkey IPCs (§28.5 Q30 + Q31)
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
        const usage = passkeyUsage.get(p.vaultId) ?? [];
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
      const entries = passkeyUsage.get(p.vaultId) ?? [];
      entries.push({ at: Date.now(), valueWei: valueLythoshi });
      passkeyUsage.set(p.vaultId, entries);
      return { ok: true };
    }
    case "passkey-set-policy": {
      // Replace the policy atomically. The wallet enforces the
      // resulting threshold at signing time (Commit 4). There is NO
      // chain-side enforcement today — see the chain-GAP note in
      // shared/passkey.ts. The validator inside the shared module
      // rejects bogus inputs; bad payloads round-trip a typed reason.
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
    // Phase 9 — two-tier UX feature toggle IPCs (§28.5 Q29)
    // ────────────────────────────────────────────────────────────────
    case "two-tier-get-state": {
      try {
        const state = await loadTwoTierState();
        return { ok: true, state };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "two-tier-set-feature": {
      const p = (message.payload ?? {}) as {
        flag?: string;
        enabled?: unknown;
      };
      if (typeof p.flag !== "string" || typeof p.enabled !== "boolean") {
        return { ok: false, reason: "missing flag or enabled bool" };
      }
      if (!(FEATURE_FLAGS as readonly string[]).includes(p.flag)) {
        return { ok: false, reason: "unknown feature flag" };
      }
      try {
        const state = await setTwoTierFeature(
          p.flag as FeatureFlag,
          p.enabled,
        );
        return { ok: true, state };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    // ────────────────────────────────────────────────────────────────
    // Phase 10 — SLH-DSA emergency-backup IPCs (§30.1)
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
      // Re-export flow (Commit 6 wiring). Requires the container to
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
      // Settings → Security page (Commit 6) to flip a `pending`
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
        const { result } = await sprintnetJsonRpc<{
          status?: string;
          blockNumber?: string;
        } | null>("eth_getTransactionReceipt", [p.txHash]);
        if (!result) {
          return { ok: true, receipt: null };
        }
        return {
          ok: true,
          receipt: {
            status: typeof result.status === "string" ? result.status : null,
            blockNumber:
              typeof result.blockNumber === "string" ? result.blockNumber : null,
          },
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "slh-dsa-backup-clear": {
      // Escape hatch for users who want to abandon the local
      // record and regenerate. Surfaces an explicit warning UX in
      // Commit 6 because a prior on-chain registration becomes
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
        autoLockMinutes: session.autoLockMinutes,
        options: AUTO_LOCK_OPTIONS,
      };
    }
    case "wallet-operator-status": {
      // Liveness probe for the popup's chain-status banner. We iterate
      // SPRINTNET_OPERATOR_RPCS and return the first that answers
      // `net_version` with the expected chain id (within a 1-second
      // per-host budget). Result is cached for 10s so a banner that
      // re-renders on every screen change doesn't hammer the chain.
      const now = Date.now();
      if (
        cachedOperator !== null &&
        now - cachedOperator.checkedAt < OPERATOR_CACHE_TTL_MS
      ) {
        return { ok: true, name: cachedOperator.name };
      }
      try {
        const hit = await probeFirstAliveOperator(undefined, 1_000);
        cachedOperator = {
          name: hit?.name ?? null,
          rpc: hit?.rpc ?? null,
          checkedAt: now,
        };
        return { ok: true, name: cachedOperator.name };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-chain-block-number": {
      // Real chain-liveness probe for the popup's status-bar health
      // indicator. Calls `eth_blockNumber` on the active Sprintnet
      // operator and returns the hex result; the popup tracks block-
      // advance freshness client-side at an 8-second cadence to drive
      // the LIVE / STALLED / OFFLINE state machine.
      //
      // Reuses `cachedOperator` (shared with `wallet-operator-status`)
      // to avoid re-running the operator probe loop on every health
      // tick. Cache miss / stale falls through to a fresh probe and
      // refreshes the cache for both handlers.
      const now = Date.now();
      let rpc: string | null = null;
      let operatorName: string | null = null;
      if (
        cachedOperator !== null &&
        now - cachedOperator.checkedAt < OPERATOR_CACHE_TTL_MS
      ) {
        rpc = cachedOperator.rpc;
        operatorName = cachedOperator.name;
      } else {
        try {
          const hit = await probeFirstAliveOperator(undefined, 1_000);
          cachedOperator = {
            name: hit?.name ?? null,
            rpc: hit?.rpc ?? null,
            checkedAt: now,
          };
          rpc = cachedOperator.rpc;
          operatorName = cachedOperator.name;
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
      }
      if (rpc === null) {
        return { ok: false, reason: "no operator" };
      }
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
          return { ok: false, reason: `http ${res.status}` };
        }
        const body = (await res.json()) as {
          result?: string;
          error?: { message?: string };
        };
        if (body.error) {
          return { ok: false, reason: body.error.message ?? "rpc error" };
        }
        if (typeof body.result !== "string") {
          return { ok: false, reason: "bad response" };
        }
        return { ok: true, blockHex: body.result, operator: operatorName };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-active-account": {
      // Surface the unlocked v3 keypair to the popup so Home can render
      // the real ML-DSA-65 address instead of the demo `mono1:…` placeholder.
      // Stays scoped to v3 — the legacy v2 keystore goes through the
      // existing demo-data path until the Networks list switch lands.
      //
      // Phase 5: either a legacy single envelope OR a container counts;
      // unlockContainerV4 sets `unlocked` to the active vault's backend
      // either way, so getUnlockedAddressV4() returns the right address.
      if (!(await hasVaultV4()) && !(await hasContainerV4())) {
        return { ok: false, reason: "no v3 vault" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "locked" };
      }
      const address = getUnlockedAddressV4() ?? (await getStoredAddressV4());
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
      // Sprintnet uses MAX-consensus across all active operators (see
      // `sprintnetMaxBalanceConsensus`): a lagging operator can only
      // under-report balance, so taking the max across responding
      // operators is the safe resilience strategy. Other Sprintnet RPC
      // methods (eth_call, nonce, fee, indexer) keep the single-
      // operator-with-failover path in `sprintnetJsonRpc`, where max()
      // would not be meaningful.
      //
      // Every other chain id flows through `providerFor` so user-added
      // chains via wallet_addEthereumChain just work; those use the
      // standard `eth_getBalance` hex-string return.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      try {
        if (chainRequiresMlDsa(p.chainIdHex)) {
          const consensus = await sprintnetMaxBalanceConsensus(p.address);
          const total = consensus.contributing.length + consensus.failing.length;
          const failSummary =
            consensus.failing.length > 0
              ? ` (failing: ${consensus.failing
                  .map((f) => `${f.name}: ${f.reason}`)
                  .join(", ")})`
              : "";
          console.log(
            `[wallet] balance consensus: max=${consensus.balanceHex} from ${consensus.contributing.length}/${total} operators${failSummary}`,
          );
          return { ok: true, balanceHex: consensus.balanceHex };
        }
        const provider = providerFor(p.chainIdHex);
        const balanceHex = await rpcSend<string>(provider, "eth_getBalance", [
          p.address,
          "latest",
        ]);
        return { ok: true, balanceHex };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-eth-call": {
      // Phase 5 Commit 6: read-only `eth_call` proxy for popup consumers
      // that need to query EVM contracts without instantiating their own
      // RPC client. Today's consumer is the NFT tab — `nft-client.ts`
      // helpers (ownerOf, balanceOf, supportsInterface, tokenURI) all
      // route through the popup's `IpcEthCaller` which lands here.
      // Same Sprintnet operator-failover routing as `wallet-balance`;
      // other chains flow through `providerFor` so user-added EVM chains
      // (`wallet_addEthereumChain`) still work uniformly.
      const p = message.payload as {
        to?: string;
        data?: string;
        chainIdHex?: string;
      };
      if (
        typeof p?.to !== "string" ||
        typeof p?.data !== "string" ||
        typeof p?.chainIdHex !== "string"
      ) {
        return { ok: false, reason: "missing to, data, or chainIdHex" };
      }
      try {
        if (chainRequiresMlDsa(p.chainIdHex)) {
          const { result } = await sprintnetJsonRpc<string>("eth_call", [
            { to: p.to, data: p.data },
            "latest",
          ]);
          if (typeof result !== "string") {
            return { ok: false, reason: "unexpected eth_call result shape" };
          }
          return { ok: true, result };
        }
        const provider = providerFor(p.chainIdHex);
        const result = await rpcSend<string>(provider, "eth_call", [
          { to: p.to, data: p.data },
          "latest",
        ]);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-indexer-snapshot": {
      // Existing consumer (popup Home) shape: passes `unknown[]` through
      // verbatim, no caching. Phase 4.4 added `wallet-activity-get` which
      // layers caching + dedupe on top of the same fetch path. This case
      // is preserved bit-for-bit for backward compatibility until commit
      // 13 swaps Home over to the new pipeline.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "indexer snapshot is only wired for Sprintnet today" };
      }
      const fresh = await fetchIndexerSnapshot(p.address, p.chainIdHex);
      return {
        ok: true,
        snapshot: {
          tokenBalances: fresh.tokenBalances,
          bridgeRouteDisclosures: fresh.bridgeRouteDisclosures,
          bridgeRouteReadiness: fresh.bridgeRouteReadiness,
          addressLabel: fresh.addressLabel,
          delegationHistory: fresh.delegationHistory,
          addressActivity: fresh.addressActivity,
          errors: fresh.errors,
        },
      };
    }
    case "wallet-activity-get": {
      // Phase 4.4 read-through cache. Hits chrome.storage.local first;
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
        return { ok: false, reason: "activity-get is only wired for Sprintnet today" };
      }
      const addressLower = p.address.toLowerCase();
      const cacheKey = activityCacheKey(addressLower, p.chainIdHex);
      const pendingKey = activityPendingKey(addressLower, p.chainIdHex);
      const now = Date.now();
      const { cache: prevCache, pending: prevPending } = await readActivityStorage(
        cacheKey,
        pendingKey,
      );
      const isFresh =
        prevCache !== null && now - prevCache.lastFetchedAtMs < CACHE_STALENESS_MS;
      if (isFresh) {
        const pending = evictExpiredPending(prevPending, now);
        if (pending.length !== prevPending.length) {
          await new Promise<void>((resolve) => {
            chrome.storage.local.set(
              { [pendingKey]: { pending } },
              () => resolve(),
            );
          });
        }
        return { ok: true, cache: prevCache, pending, errors: {} };
      }
      const fresh = await fetchIndexerSnapshot(p.address, p.chainIdHex);
      const activityOk = fresh.errors.addressActivity === undefined;
      const delegationOk = fresh.errors.delegationHistory === undefined;
      if (!activityOk && !delegationOk && prevCache !== null) {
        // Total indexer outage with a usable prev cache — preserve and
        // surface. TTL backstop still runs on the pending list.
        const pending = evictExpiredPending(prevPending, now);
        if (pending.length !== prevPending.length) {
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
      const nextCache = mergeIndexerSnapshot({ activity, delegation }, now);
      const reconciled = reconcilePending(prevPending, nextCache.confirmed);
      const nextPending = evictExpiredPending(reconciled, now);
      await writeActivityStorage(cacheKey, pendingKey, nextCache, prevPending, nextPending);
      return { ok: true, cache: nextCache, pending: nextPending, errors: fresh.errors };
    }
    case "wallet-activity-kind": {
      // Phase 11 Commit 3 — typed AddressActivityKind probe (chain
      // commit d77e4fc, GAP #17 closes here).
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
        const { result } = await sprintnetJsonRpc<unknown>(
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
        // method-not-found (-32601) → emit "indexer_disabled" rather
        // than "not_found" so the user sees the right copy. Other
        // transport errors get the not_found defensive default.
        if (err.code === -32601) {
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
    case "wallet-resolve-names": {
      // Phase 4.4 batched name resolution. The de facto naming source on
      // Sprintnet is `lyth_getAddressLabel` (per the §22.8 GAP-OPEN
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
      //   5. If ANY per-address call returned JSON-RPC -32601, mark the
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
        return { ok: false, reason: "resolve-names is only wired for Sprintnet today" };
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
      // Method-gate write: trip if any call returned -32601, clear if
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
      // Phase 4.4 — drives the §28.2.1 indexer-staleness banner.
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
        return { ok: false, reason: "indexer-status is only wired for Sprintnet today" };
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
        const { result } = await sprintnetJsonRpc<unknown>("lyth_indexerStatus", []);
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
        // Phase 11 Commit 4 — schema drift detection. Chain reports a
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
        if (err.code === -32601) {
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
        return { ok: false, reason: "MRV planning is only wired for Sprintnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddress = getUnlockedAddressV4();
      if (!fromAddress) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const nonceRes = await sprintnetJsonRpc<string>(
          "eth_getTransactionCount",
          [fromAddress, "latest"],
        );
        const fee =
          p.maxExecutionFeeLythoshiHex === undefined ||
          p.priorityTipLythoshiHex === undefined
            ? await suggestFee(chainIdHex)
            : null;
        const input: WalletMrvDeployNativePlanInput = {
          fromAddress,
          chainIdHex,
          nonceHex: nonceRes.result,
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
        return { ok: false, reason: "MRV planning is only wired for Sprintnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddress = getUnlockedAddressV4();
      if (!fromAddress) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const nonceRes = await sprintnetJsonRpc<string>(
          "eth_getTransactionCount",
          [fromAddress, "latest"],
        );
        const fee =
          p.maxExecutionFeeLythoshiHex === undefined ||
          p.priorityTipLythoshiHex === undefined
            ? await suggestFee(chainIdHex)
            : null;
        const input: WalletMrvCallNativePlanInput = {
          fromAddress,
          chainIdHex,
          nonceHex: nonceRes.result,
          executionUnitLimitHex: p.executionUnitLimitHex,
          maxExecutionFeeLythoshiHex:
            p.maxExecutionFeeLythoshiHex ?? fee?.maxFeePerGas ?? "0x0",
          contractAddress: p.contractAddress,
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
        return { ok: false, reason: "MRV submission is only wired for Sprintnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const txReq = walletMrvNativePlanToSubmitTx(p.plan, {
          chainIdHex: p.chainIdHex,
          fromAddress: fromAddr,
        });
        const { txHash, via } = await submitEncryptedMlDsaTx(txReq);
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
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return {
          ok: false,
          reason: "MRV receipt polling is only wired for Sprintnet today",
        };
      }
      try {
        const { result, via } = await sprintnetJsonRpc<{
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
          const native = await sprintnetJsonRpc<unknown>("lyth_nativeReceipt", [
            p.txHash,
          ]);
          nativeReceipt = parseMrvNativeReceiptEvidence(native.result);
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
      // Phase 11.5 Commit 2 — call lyth_previewTransactionHooks
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
    case "chain-signing-activity": {
      // Phase 11.5 Commit 3 — call lyth_signingActivity (MD-CORE-0004)
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
      // Phase 11.5 Commit 5 — call lyth_operatorRisk (MD-CORE-0006)
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
      // Phase 11.5 Commit 7 — call lyth_upcomingDuties (MD-CORE-0005)
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
    // ─────────────────────────────────────────────────────────────────
    // Phase 7 — staking + delegation reads (§23 whitepaper)
    // ─────────────────────────────────────────────────────────────────
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
      // Phase 7.1 — per-wallet delegation event timeline. Distinct from
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
      // Phase 7.1 — co-delegator surface for a single cluster. Used by
      // the cluster-detail expand panel to render "n wallets delegate
      // here" without inferring from indirect signals.
      const p = message.payload as { clusterId?: number } | undefined;
      if (typeof p?.clusterId !== "number") {
        return { ok: false, reason: "missing clusterId" };
      }
      return readClusterDelegators(p.clusterId);
    }
    case "staking-autovote-seed": {
      // Per-user §23.9 entropy: derive a 32-byte seed from the unlocked
      // ML-DSA-65 public key + a domain tag. The public key is already
      // public state (`register-pubkey` precompile §22.4), so this leaks
      // no secret material; the uniqueness property the whitepaper
      // requires ("two delegators picking Max Yield don't end up at the
      // same cluster set") rides on different users having different
      // pubkeys. Locked wallets get a typed error and the popup falls
      // back to a "please unlock to use autovote" branch.
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
    case "ws-status": {
      // Phase 11 Commit 2 — WS-client status probe. The popup uses this
      // to decide whether to keep its existing polling cadence (default)
      // or drop to event-driven updates (when WS reports "connected").
      // No side effects: doesn't subscribe, doesn't open a connection.
      // Just reports what the SW-singleton currently sees.
      const client = getWsClient();
      const status: WsStatus = client.status;
      return { ok: true, status };
    }
    case "ws-subscribe-new-heads": {
      // Phase 11 Commit 2 — fire-and-forget subscribe to the chain's
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
          // Chain emits `{ number: "0x...", hash, parent, ... }`. The
          // wallet only cares about the height for the live banner.
          if (
            typeof params === "object" &&
            params !== null &&
            "number" in (params as Record<string, unknown>)
          ) {
            const number = (params as { number?: unknown }).number;
            if (typeof number === "string") {
              chrome.storage.session
                .set({ [STORAGE_KEY_WS_LAST_BLOCK_HEX]: number })
                .catch(() => {
                  // session write failure is non-load-bearing
                });
            }
          }
        });
      }
      return { ok: true, status: client.status };
    }
    case "wallet-send-tx": {
      const p = message.payload as {
        to?: string;
        valueWeiHex?: string;
        chainIdHex?: string;
        // Phase 5 Commit 7 — optional contract-call fields. Omit
        // both for native LYTH transfers and the handler behaves
        // exactly as it did before; supply them for NFT
        // safeTransferFrom and the data is forwarded verbatim into
        // the ML-DSA-65 envelope.
        data?: string;
        gasLimitHex?: string;
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
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        // Real-send through the legacy secp256k1 path is not in scope yet —
        // the popup only wires Sprintnet for now. When non-Sprintnet send
        // lands it'll route through providerFor + signLegacyTx like the
        // existing `eth_sendTransaction` handler does.
        return { ok: false, reason: "send is only wired for Sprintnet today" };
      }
      if (!isUnlockedV4()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddr = getUnlockedAddressV4();
      if (!fromAddr) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const nonceRes = await sprintnetJsonRpc<string>(
          "eth_getTransactionCount",
          [fromAddr, "latest"],
        );
        const fee = await suggestFee(p.chainIdHex);
        // Sprintnet's mempool enforces an intrinsic execution-unit floor (~24309 as
        // of audit) that `eth_estimateGas` doesn't reflect — it returns
        // EVM execution units only and ignores ML-DSA verify + envelope
        // decrypt + state proof overhead. Native transfers use the
        // pre-resolved hex from suggestFee. Contract calls (NFT
        // safeTransferFrom from the SendNft screen) carry their own
        // caller-supplied estimate because the suggestFee execution-unit hint is
        // sized for native transfers only.
        const gasHex = p.gasLimitHex ?? fee.gasLimit ?? "0x5208";
        const { txHash, via } = await submitEncryptedMlDsaTx({
          to: p.to,
          value: p.valueWeiHex,
          ...(p.data !== undefined ? { data: p.data } : {}),
          gas: gasHex,
          nonce: nonceRes.result,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          chainIdHex: p.chainIdHex,
        });
        // Phase 4.4 — fire-and-forget pending-row write. Unawaited so
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
        });
        return { ok: true, txHash, via };
      } catch (e) {
        // Forward method + via when sprintnetJsonRpc stamped them onto
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
    default:
      return { error: `unknown popup op ${message.op}` };
  }
}

// ---- message routing ----

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as { kind?: string };
  // Phase 5.0.1 — keepalive ping. The popup fires this on mount to
  // wake the SW out of MV3 idle before any real call goes out;
  // synchronous reply, no auth, no work, no auto-lock reset.
  // Anything that touches state belongs in the popup or rpc branch.
  if (m?.kind === "ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (m?.kind === "rpc") {
    const rpc = message as RpcMessage;
    handleRpc(rpc)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: { code: -32603, message: String(e) } }));
    return true;
  }
  if (m?.kind === "popup") {
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

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Monolythium Wallet] service worker installed");
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
