// Popup-side helpers for talking to the background service worker.
// All calls go through chrome.runtime.sendMessage with `{ kind: "popup", ... }`.

export type Custody = "tpm" | "passkey" | "hw" | "sw";
export type SignAlgo = "secp256k1" | "slhdsa" | "mldsa";

export interface KeystoreStatus {
  hasVault: boolean;
  /**
   * `true` when a legacy v1 (PBKDF2+AES-GCM) envelope is on disk. The popup
   * surfaces a "vault format upgraded — re-import your seed" notice on the
   * onboarding screen so the user knows their old keystore is no longer
   * usable. Per the v1→v2 ethos there is no silent re-encryption.
   */
  legacyVault: boolean;
  unlocked: boolean;
  address: string | null;
  /**
   * Custody backend currently used by the keystore. Today this is always
   * `"sw"` (software-encrypted vault). The shape exists so future hardware /
   * passkey / TPM backends can flip the popup's chrome without UI rewrites.
   */
  custody: Custody;
  /** Signature algorithm currently active. `"mldsa"` once a v3 vault is
   * the primary; `"secp256k1"` while a legacy v2 vault is the only one
   * on disk. The `"slhdsa"` slot was reserved for a SLH-DSA pilot that
   * was retired in favour of ML-DSA-65 — kept in the union so the
   * Settings panel's pre-PQ fallback render path still typechecks. */
  algo: SignAlgo;
}

export type ApprovalKind =
  | "connect"
  | "personal_sign"
  | "typed_sign"
  | "send_tx"
  | "switch_chain"
  | "add_chain";

export interface SendTxView {
  estimatedGas: string | null;
  gasPrice: string | null;
  nonce: string | null;
  simulation:
    | null
    | { success: true; returnData: string }
    | { success: false; error: string };
  chainId: string;
  chainLabel: string;
}

export interface TypedDataEnvelope {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ConnectRequest {
  kind: "connect";
  origin: string;
}

export interface PersonalSignRequest {
  kind: "personal_sign";
  origin: string;
  message: string;
  address: string;
}

export interface TypedSignRequest {
  kind: "typed_sign";
  origin: string;
  address: string;
  rawTypedData: string;
  parsed: TypedDataEnvelope | null;
  digest: string | null;
}

export interface SendTxRequest {
  kind: "send_tx";
  origin: string;
  tx: {
    from?: string;
    to?: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
    nonce?: string;
    chainId?: string;
  };
  view: SendTxView;
}

export interface AddChainRequest {
  kind: "add_chain";
  origin: string;
  chain: {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    blockExplorerUrls?: string[];
    iconUrls?: string[];
    nativeCurrency?: { name: string; symbol: string; decimals: number };
  };
}

export interface SwitchChainRequest {
  kind: "switch_chain";
  origin: string;
  chainId: string;
}

export type ApprovalRequest =
  | ConnectRequest
  | PersonalSignRequest
  | TypedSignRequest
  | SendTxRequest
  | AddChainRequest
  | SwitchChainRequest;

export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  createdAt: number;
}

export interface ChainEntry {
  chainId: string;
  name: string;
  rpc: string;
  chainIdNum: number;
  builtin: boolean;
  /** True for Foundation-attested official chains (Sprintnet today).
   * Surfaces the "Official" badge on the Networks screen; user-added
   * chains via `wallet_addEthereumChain` are always `false`. */
  official?: boolean;
  active: boolean;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

/** Phase 5.0.1 — error-message fragments that indicate the SW was
 *  idle/asleep when sendMessage fired. Chrome MV3 wakes the worker
 *  on demand, but the wake race can drop the first message; the
 *  retry path below catches these classes. */
const SW_IDLE_ERROR_MARKERS = [
  "No SW",
  "message port closed",
  "receiving end does not exist",
  "Could not establish connection",
];

function isSwIdleError(message: string): boolean {
  return SW_IDLE_ERROR_MARKERS.some((m) => message.includes(m));
}

function rawSendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

function send<T>(op: string, payload?: unknown): Promise<T> {
  // Single retry against the MV3 idle/wake race. Pure transport-
  // level retry — application-level errors (`{ ok: false, ... }`
  // payloads) reach the caller unchanged on the first attempt.
  const envelope = { kind: "popup", op, payload };
  return (async () => {
    try {
      return (await rawSendMessage(envelope)) as T;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!isSwIdleError(msg)) throw e;
      await new Promise((r) => setTimeout(r, 100));
      return (await rawSendMessage(envelope)) as T;
    }
  })();
}

/** Wake the SW. Cheap no-op response from the SW's `ping` handler;
 *  the only purpose is to flip the worker out of MV3 idle before any
 *  real call lands. Caller does not need the result; failures are
 *  swallowed because the followup real call carries its own retry. */
export async function bgPing(): Promise<void> {
  try {
    await rawSendMessage({ kind: "ping" });
  } catch {
    /* swallow — followup calls carry their own retry. */
  }
}

export async function bgKeystoreStatus(): Promise<KeystoreStatus> {
  return send<KeystoreStatus>("keystore-status");
}

export async function bgKeystoreUnlock(
  password: string,
): Promise<
  | { ok: true; address: string }
  | {
      ok: false;
      reason?: "wrong_password" | "rate_limited" | string;
      secondsRemaining?: number;
      failCount?: number;
    }
> {
  return send("keystore-unlock", { password });
}

export async function bgKeystoreLock(): Promise<{ ok: boolean }> {
  return send("keystore-lock");
}

export async function bgKeystoreCreateNew(
  password: string,
): Promise<
  | { ok: true; mnemonic: string; address: string }
  | { ok: false; reason?: string }
> {
  return send("keystore-create-new", { password });
}

export async function bgKeystoreCreateFromMnemonic(
  password: string,
  mnemonic: string,
): Promise<{ ok: true; address: string } | { ok: false; reason?: string }> {
  return send("keystore-create-from-mnemonic", { password, mnemonic });
}

/**
 * Re-auth and return the 24-word PQM-1 mnemonic for the Settings →
 * Show recovery phrase flow. Wrong-password attempts share the
 * SESSION_KEY_UNLOCK_FAIL_COUNT/_UNTIL counters with `bgKeystoreUnlock`,
 * so brute-force lockout thresholds apply identically. v4 strict
 * guarantees the mnemonic is always stored, so the only failure cases
 * are wrong_password and rate_limited.
 */
export async function bgKeystoreExportSeed(
  password: string,
): Promise<
  | { ok: true; mnemonic: string }
  | {
      ok: false;
      reason?: "wrong_password" | "rate_limited" | string;
      secondsRemaining?: number;
      failCount?: number;
    }
> {
  return send("keystore-export-seed", { password });
}

/**
 * Re-auth + destructive wipe used by Settings → Reset wallet. Same
 * brute-force lockout counters as `bgKeystoreUnlock` /
 * `bgKeystoreExportSeed`. After a successful reply the SW broadcasts
 * `walletLocked = true` so any open popup re-syncs to the post-wipe state.
 */
export async function bgKeystoreReset(
  password: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason?: "wrong_password" | "rate_limited" | string;
      secondsRemaining?: number;
      failCount?: number;
    }
> {
  return send("keystore-reset", { password });
}

/**
 * No-re-auth wipe used by Welcome → Forgot password? → "Reset & Import".
 * The user has no password to enter, so this path is throttled at the SW
 * (one call per 5 s) rather than gated by re-auth. Threat model: a
 * popup-access attacker can wipe but gets no key material; the security
 * boundary is the 24-word recovery phrase, not the popup.
 */
export async function bgKeystoreWipeUnauth(): Promise<
  { ok: true } | { ok: false; reason?: string }
> {
  return send("keystore-wipe-unauth");
}

/**
 * Real account state surfaced to the popup so Home can render the
 * unlocked v3 wallet's address instead of the demo `mono1:…` placeholder.
 * Mirrors the shape the service worker returns from "wallet-active-account".
 */
export interface ActiveAccount {
  /** EVM-style hex address (`0x` + 40 hex chars). */
  address: string;
  algo: SignAlgo;
  custody: Custody;
}

export async function bgWalletActiveAccount(): Promise<
  { ok: true; account: ActiveAccount } | { ok: false; reason?: string }
> {
  // The IPC handler returns the account fields inline rather than nested.
  // Reshape here so callers can keep `r.account.address` etc.
  type Reply =
    | { ok: true; address: string; algo: SignAlgo; custody: Custody }
    | { ok: false; reason?: string };
  const r = await send<Reply>("wallet-active-account");
  if (!r.ok) return r;
  return {
    ok: true,
    account: { address: r.address, algo: r.algo, custody: r.custody },
  };
}

export async function bgWalletBalance(
  address: string,
  chainIdHex: string,
): Promise<{ ok: true; balanceHex: string } | { ok: false; reason?: string }> {
  return send("wallet-balance", { address, chainIdHex });
}

/**
 * Read-only `eth_call` proxy. The popup has no RpcClient instance of
 * its own — every chain query goes through the SW's existing operator-
 * failover routing (Sprintnet) or `providerFor` (everything else).
 * The NFT tab uses this for ERC-721 / ERC-1155 ownership and metadata
 * lookups via the `IpcEthCaller` adapter in `nftEthCaller.ts`.
 */
export async function bgEthCall(
  to: string,
  data: string,
  chainIdHex: string,
): Promise<{ ok: true; result: string } | { ok: false; reason?: string }> {
  return send("wallet-eth-call", { to, data, chainIdHex });
}

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
}

export interface WalletAddressLabel {
  address: string;
  category: string;
  displayName: string | null;
  updatedAtBlock: number;
}

export interface WalletDelegationHistoryRow {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  wallet: string;
  cluster: number;
  toCluster: number | null;
  kind: string;
  weightBps: number;
  walletTotalBps: number | null;
}

export interface WalletAddressActivityRow {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  kind: string;
  direction: "in" | "out" | null;
  counterparty: string | null;
  tokenId: string | null;
  amount: string | null;
  cluster: number | null;
  weightBps: number | null;
  subKind: string | null;
}

export interface WalletIndexerSnapshot {
  tokenBalances: WalletTokenBalance[];
  addressLabel: WalletAddressLabel | null;
  delegationHistory: WalletDelegationHistoryRow[];
  addressActivity: WalletAddressActivityRow[];
  errors: Partial<Record<"tokenBalances" | "addressLabel" | "delegationHistory" | "addressActivity", string>>;
}

export async function bgWalletIndexerSnapshot(
  address: string,
  chainIdHex: string,
): Promise<{ ok: true; snapshot: WalletIndexerSnapshot } | { ok: false; reason?: string }> {
  return send("wallet-indexer-snapshot", { address, chainIdHex });
}

// Phase 4.4 — cached, kind-dispatched activity feed (Layer 2 in the plan).
// Re-exports the wallet-internal cache and pending-row types from
// shared/activity.ts so callers don't need to import from two paths.
export type {
  ActivityCache,
  ActivityRow,
  ConfirmedRow,
  PendingTxRow,
} from "../shared/activity.js";

export async function bgWalletActivityGet(
  address: string,
  chainIdHex: string,
): Promise<
  | {
      ok: true;
      cache: import("../shared/activity.js").ActivityCache;
      pending: import("../shared/activity.js").PendingTxRow[];
      errors: Record<string, string>;
    }
  | { ok: false; reason?: string }
> {
  return send("wallet-activity-get", { address, chainIdHex });
}

// Phase 4.4 — batched name resolution via lyth_getAddressLabel.
// Re-export the wallet-internal label types so popup callers don't
// need to reach into shared/.
export type { NameLabel, NameLabelRecord } from "../shared/name-resolution.js";

export async function bgWalletResolveNames(
  addresses: string[],
  chainIdHex: string,
): Promise<
  | {
      ok: true;
      resolved: Record<string, import("../shared/name-resolution.js").NameLabel>;
    }
  | { ok: false; reason?: string }
> {
  return send("wallet-resolve-names", { addresses, chainIdHex });
}

// Phase 4.4 — indexer-status polling for the §28.2.1 staleness banner.
// All success-path fields nullable: when the method is unavailable or
// the response is malformed, the handler returns the defensive
// { stale: false, lagBlocks: null, currentHeight: null, latestHeight: null }
// rather than surfacing a false-positive stale flag to the user.
export interface IndexerStatusView {
  stale: boolean;
  lagBlocks: number | null;
  currentHeight: number | null;
  latestHeight: number | null;
}

export async function bgWalletIndexerStatus(
  chainIdHex: string,
): Promise<{ ok: true; status: IndexerStatusView } | { ok: false; reason?: string }> {
  type Reply =
    | ({ ok: true } & IndexerStatusView)
    | { ok: false; reason?: string };
  const r = await send<Reply>("wallet-indexer-status", { chainIdHex });
  if (!r.ok) return r;
  return {
    ok: true,
    status: {
      stale: r.stale,
      lagBlocks: r.lagBlocks,
      currentHeight: r.currentHeight,
      latestHeight: r.latestHeight,
    },
  };
}

/** Fee strategy returned by `bgWalletFeeSuggestion`. */
export interface FeeSuggestion {
  /** Hex wei — sender's tip target (the only revenue path on Sprintnet). */
  maxPriorityFeePerGas: string;
  /** Hex wei — hard cap (priority + base). */
  maxFeePerGas: string;
  /** Hex wei — current/next-block base fee. Surfaced for the UI fee preview. */
  baseFeePerGas: string;
  /** Hex gas-limit recommendation. Non-null on Sprintnet (the chain has
   * an intrinsic floor `eth_estimateGas` doesn't report); null on other
   * chains where the popup should estimate itself if needed. */
  gasLimit: string | null;
}

/** Tx hash + diagnostic operator id from `bgWalletSendTx`. */
export interface SendTxResult {
  txHash: string;
  via: string;
}

export async function bgWalletFeeSuggestion(
  chainIdHex: string,
): Promise<{ ok: true; suggestion: FeeSuggestion } | { ok: false; reason?: string }> {
  // The IPC handler returns the fee fields inline; reshape for callers.
  type Reply =
    | ({ ok: true } & FeeSuggestion)
    | { ok: false; reason?: string };
  const r = await send<Reply>("wallet-fee-suggestion", { chainIdHex });
  if (!r.ok) return r;
  return {
    ok: true,
    suggestion: {
      maxPriorityFeePerGas: r.maxPriorityFeePerGas,
      maxFeePerGas: r.maxFeePerGas,
      baseFeePerGas: r.baseFeePerGas,
      gasLimit: r.gasLimit,
    },
  };
}

/**
 * Read the active chain id from chrome.storage. Returns the Sprintnet
 * default (`0x10F2C`) when nothing is stored yet (first launch) or when
 * the stored id no longer maps to a known chain.
 */
export async function bgWalletActiveChain(): Promise<
  { ok: true; chainId: string } | { ok: false; reason?: string }
> {
  return send("wallet-active-chain");
}

/**
 * Switch the active chain. Mirrors `wallet_switchEthereumChain` (validate,
 * persist, broadcast `chainChanged`) but is invoked through the popup IPC
 * channel rather than the dApp RPC channel.
 */
export async function bgWalletSetActiveChain(
  chainId: string,
): Promise<{ ok: true; chainId: string } | { ok: false; reason?: string }> {
  return send("wallet-set-active-chain", { chainId });
}

/**
 * Probe the published Sprintnet operators and report which one answered
 * (or `null` if none did within budget). Backs the chain-status banner;
 * the service worker caches the answer for 10s, so it's safe to call on
 * every popup tick.
 */
export async function bgWalletOperatorStatus(): Promise<
  { ok: true; name: string | null } | { ok: false; reason?: string }
> {
  return send("wallet-operator-status");
}

/**
 * Read the active chain's current block number. Used by the popup's
 * chain-health poll to drive the LIVE / STALLED / OFFLINE state machine —
 * the popup compares blockHex across ticks, sets STALLED if it doesn't
 * advance for 30+ seconds, OFFLINE if a tick errors. The service worker
 * shares its operator cache with `bgWalletOperatorStatus` so the operator
 * probe doesn't re-run on every 8s health tick.
 */
export async function bgWalletChainBlockNumber(): Promise<
  { ok: true; blockHex: string; operator: string | null }
  | { ok: false; reason?: string }
> {
  return send("wallet-chain-block-number");
}

export async function bgWalletSendTx(args: {
  to: string;
  valueWeiHex: string;
  chainIdHex: string;
  /** Optional EVM calldata. Required for contract calls (NFT
   *  safeTransferFrom, ERC-20 transfer, etc.); omit for native LYTH
   *  transfers. The SW forwards the bytes verbatim into the
   *  ML-DSA-65 envelope path; signing semantics are unchanged.
   *  Phase 5 Commit 7 added this field for the SendNft screen. */
  data?: string;
  /** Optional gas-limit override (hex). When omitted the SW falls
   *  back to its native-transfer default (Sprintnet's intrinsic-gas
   *  floor). NFT calldata pushes that floor well past 21k, so the
   *  Send-NFT page passes a conservative overhead-aware estimate. */
  gasLimitHex?: string;
}): Promise<
  { ok: true; result: SendTxResult }
  | {
      ok: false;
      reason?: string;
      code?: number;
      method?: string;
      via?: string;
    }
> {
  type Reply =
    | { ok: true; txHash: string; via: string }
    | {
        ok: false;
        reason?: string;
        code?: number;
        method?: string;
        via?: string;
      };
  const r = await send<Reply>("wallet-send-tx", args);
  if (!r.ok) return r;
  return { ok: true, result: { txHash: r.txHash, via: r.via } };
}

export async function bgListPending(): Promise<PendingApproval[]> {
  return send<PendingApproval[]>("list-pending");
}

export async function bgGetPending(id: string): Promise<PendingApproval | null> {
  return send<PendingApproval | null>("get-pending", { id });
}

export async function bgResolveApproval(
  id: string,
  decision: { ok: boolean; reason?: string },
): Promise<{ found: boolean }> {
  return send<{ found: boolean }>("resolve", { id, decision });
}

export async function bgFocusApproval(id: string): Promise<{ focused: boolean }> {
  return send<{ focused: boolean }>("focus-approval", { id });
}

export interface ConnectedSiteRecord {
  address: string;
  approvedAt: number;
}

export type ConnectedSitesMap = Record<string, ConnectedSiteRecord>;

export async function bgListConnectedSites(): Promise<ConnectedSitesMap> {
  return send<ConnectedSitesMap>("list-connected-sites");
}

export async function bgRevokeOrigin(origin: string): Promise<{ ok: boolean }> {
  return send<{ ok: boolean }>("revoke-origin", { origin });
}

export async function bgRevokeAllOrigins(): Promise<{ ok: boolean }> {
  return send<{ ok: boolean }>("revoke-all-origins");
}

export async function bgChainList(): Promise<ChainEntry[]> {
  return send<ChainEntry[]>("chain-list");
}

/**
 * Manually add a user-defined chain from the in-popup form. Skips the
 * `gatedEnqueue` approval gate that `wallet_addEthereumChain` uses for
 * dApp-initiated adds — the user is already in the wallet UI explicitly
 * clicking Apply, so a redundant approval window over the popup would
 * be worse UX than the dApp path it mirrors.
 */
export async function bgChainAddManual(spec: {
  chainId: string;
  name: string;
  rpc: string;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}): Promise<{ ok: true; chainId: string } | { ok: false; reason?: string }> {
  return send("chain-add-manual", { chain: spec });
}

/**
 * Edit a user-added chain. Builtin chains are rejected at the SW with
 * reason "cannot edit builtin chain". Does NOT broadcast `chainChanged`
 * even when the active chain's RPC is edited — chainId itself doesn't
 * change, so EIP-1193 says the event is wrong.
 */
export async function bgChainEdit(
  chainId: string,
  patch: {
    name?: string;
    rpc?: string;
    blockExplorer?: string | null;
    nativeCurrency?: { name: string; symbol: string; decimals: number } | null;
  },
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return send("chain-edit", { chainId, patch });
}

/**
 * Delete a user-added chain. Builtin chains are rejected. If the deleted
 * chain was active, the SW resets `session.chainId` to Sprintnet and
 * broadcasts `chainChanged` so connected dApps re-prompt for the chain.
 */
export async function bgChainDelete(
  chainId: string,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return send("chain-delete", { chainId });
}

export interface OperatorEntryWire {
  name: string;
  region: string;
  rpc: string;
}

/** Read the current operator-override state. `override` is null when the
 *  user has not customized; `defaults` is the SDK-published list;
 *  `effective` is what RPC dispatch actually iterates (defaults or override). */
export async function bgOperatorsGet(): Promise<{
  ok: true;
  override: OperatorEntryWire[] | null;
  defaults: OperatorEntryWire[];
  effective: OperatorEntryWire[];
}> {
  return send("sprintnet-operators-get");
}

/** Persist a new operator override (or null to clear and revert to defaults).
 *  The SW's chrome.storage.onChanged listener invalidates the operator
 *  probe cache so the next chain-health tick picks up the new list. */
export async function bgOperatorsSet(
  operators: OperatorEntryWire[] | null,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return send("sprintnet-operators-set", { operators });
}

/** Per-operator health row surfaced by `sprintnet-operators-health`. `ok`
 *  is true when the operator responded with both a `net_version` and a
 *  `eth_blockNumber` within the probe budget; `trustedGenesis` is true
 *  when the operator's block 0 hash matches the wallet's pinned
 *  SPRINTNET_GENESIS_HASH (Phase 6 GAP #11 — orphan-fork defense). The
 *  two are orthogonal: an operator can be live but on a forked chain
 *  (ok=true, trustedGenesis=false) — RPC dispatch still excludes it,
 *  and the row is rendered with a distinct badge. */
export interface OperatorHealthRowCommon {
  name: string;
  region: string;
  rpc: string;
  /** True iff block-0 hash matches the wallet's pinned genesis. */
  trustedGenesis: boolean;
  /** Block-0 hash returned by `eth_getBlockByNumber("0x0", false)`;
   *  null when the probe failed or the response was malformed. */
  observedGenesis: string | null;
}

export type OperatorHealthRow =
  | (OperatorHealthRowCommon & {
      ok: true;
      chainIdDec: number | null;
      blockHex: string | null;
      latencyMs: number;
    })
  | (OperatorHealthRowCommon & {
      ok: false;
      reason: string;
    });

/** Probe every active operator in parallel and return per-row status.
 *  Used by the About page; not cached because we want fresh numbers on
 *  the user opening the screen. */
export async function bgOperatorsHealth(): Promise<{
  ok: true;
  operators: OperatorHealthRow[];
}> {
  return send("sprintnet-operators-health");
}

export async function bgGetAutoLockMinutes(): Promise<{
  autoLockMinutes: number;
  options: readonly number[];
}> {
  return send("get-auto-lock-minutes");
}

export async function bgSetAutoLockMinutes(
  minutes: number,
): Promise<
  | { ok: true; autoLockMinutes: number }
  | { ok: false; reason?: string }
> {
  return send("set-auto-lock-minutes", { minutes });
}

// ---- Phase 5 multi-vault container surface ----
//
// The popup vault picker (VaultPicker component, Commit 3) reads these
// to render the list + switch active vault. Add/rename land via the
// same channel. Whitepaper §21.2.1 endorses the "wallet that manages
// many keystores" pattern that backs this surface.

export interface VaultSummary {
  id: string;
  label: string;
  /** EVM-style hex address (`0x` + 40 hex chars). Cached in the
   *  container alongside the encrypted vault record so the picker
   *  can render addresses without unlocking. */
  addr: string;
  createdAt: number;
  isActive: boolean;
}

/**
 * List the multi-vault container's vaults. `vaults` is `null` (not
 * `[]`) when no container exists yet — that signal lets the picker
 * branch on "still single-vault legacy, no picker UI yet" vs "empty
 * container shouldn't happen post-migration". Returns array of
 * summaries once the container has been initialized.
 */
export async function bgVaultsList(): Promise<
  | { ok: true; vaults: VaultSummary[] | null }
  | { ok: false; reason?: string }
> {
  return send("vault-list");
}

/**
 * Switch the active vault. The service worker broadcasts EIP-1193
 * `accountsChanged` with the new address — connected dApps re-fetch
 * state. Requires an unlocked container (MEK cached).
 */
export async function bgVaultSelect(
  vaultId: string,
): Promise<
  { ok: true; address: string } | { ok: false; reason?: string }
> {
  return send("vault-select", { vaultId });
}

/**
 * Update a vault's label. No re-auth required — labels are non-
 * sensitive UI metadata in the plaintext container. Validates 1-32
 * chars after trim at the SW; surfaces the validation message back
 * in `reason` on failure.
 */
export async function bgVaultRename(
  vaultId: string,
  label: string,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return send("vault-rename", { vaultId, label });
}

/**
 * Generate a fresh PQM-1 mnemonic and append a new vault. Caller
 * receives the mnemonic for one-time display (Settings → Show
 * recovery phrase later requires re-auth). Does NOT switch the active
 * vault — the popup decides whether to follow up with `bgVaultSelect`.
 * Requires an unlocked container.
 *
 * Optional `label` lets the popup thread a user-edited name through
 * the same call (validated 1-32 chars at the SW). When omitted the
 * keystore assigns `"Vault N"` based on post-append vault count.
 */
export async function bgVaultAddFresh(
  label?: string,
): Promise<
  | { ok: true; vaultId: string; mnemonic: string; address: string }
  | { ok: false; reason?: string }
> {
  return send("vault-add-fresh", label !== undefined ? { label } : {});
}

/**
 * Import a user-supplied PQM-1 mnemonic. Rejects duplicate-address
 * imports (the importing mnemonic would derive the same address as
 * an existing vault) with `reason: "vault with this address already
 * exists in the container"`. Same no-auto-switch + requires-unlock
 * semantics as bgVaultAddFresh; same optional `label` handling.
 */
export async function bgVaultAddImport(
  mnemonic: string,
  label?: string,
): Promise<
  | { ok: true; vaultId: string; address: string }
  | { ok: false; reason?: string }
> {
  return send(
    "vault-add-import",
    label !== undefined ? { mnemonic, label } : { mnemonic },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase 7 — staking + delegation reads (§23 whitepaper)
// ─────────────────────────────────────────────────────────────────────
//
// Every wrapper returns a `StakingResult<T>` envelope (see
// shared/staking.ts). The `via` field on success is `"mock"` when the
// SW falls back to in-tree fixtures (Sprintnet offline or chain GAP);
// the popup surfaces the mock badge so the user knows the figures
// aren't authoritative.

export type {
  ClusterDirectoryEntry,
  ClusterDirectoryPage,
  ClusterHealth,
  ClusterMember,
  ClusterStatus,
  DelegationCap,
  DelegationRow,
  DelegationsView,
  PendingRewardsRow,
  PendingRewardsView,
  RedemptionQueueRow,
  RedemptionQueueView,
  StakingResult,
} from "../shared/staking.js";

import type {
  ClusterDirectoryPage,
  ClusterStatus,
  DelegationCap,
  DelegationRow,
  DelegationsView,
  PendingRewardsView,
  RedemptionQueueView,
  StakingResult,
} from "../shared/staking.js";

/** Read the paginated cluster directory (§14 Avengers Assembly). */
export async function bgStakingClusterDirectory(
  page = 0,
  limit = 25,
): Promise<StakingResult<ClusterDirectoryPage>> {
  return send("staking-cluster-directory", { page, limit });
}

/** Read full status for a single cluster — used by the cluster-detail
 *  expand panel in ClusterPicker. */
export async function bgStakingClusterStatus(
  clusterId: number,
): Promise<StakingResult<ClusterStatus>> {
  return send("staking-cluster-status", { clusterId });
}

/** Read active delegations for a wallet. Empty rows is a legitimate
 *  read for an unstaked wallet — the popup renders the empty-state CTA. */
export async function bgStakingDelegations(
  wallet: string,
): Promise<StakingResult<DelegationsView>> {
  return send("staking-delegations", { wallet });
}

/** Read the per-cluster delegation cap (§23.6 + §23.7). */
export async function bgStakingDelegationCap(): Promise<StakingResult<DelegationCap>> {
  return send("staking-delegation-cap");
}

/** Read pending rewards for a wallet's active delegations. The popup
 *  passes its already-fetched delegation rows through so the SW does
 *  not double-read. Returns mock-derived values until the chain side
 *  surfaces a `lyth_pendingRewards` reader (chain GAP). */
export async function bgStakingPendingRewards(
  wallet: string,
  delegations: ReadonlyArray<DelegationRow>,
): Promise<StakingResult<PendingRewardsView>> {
  return send("staking-pending-rewards", { wallet, delegations });
}

/** Read the redemption queue for a wallet. Per §23.2 ("zero unbonding
 *  period"), this is vestigial — the wallet always renders an empty
 *  queue today. */
export async function bgStakingRedemptionQueue(
  wallet: string,
): Promise<StakingResult<RedemptionQueueView>> {
  return send("staking-redemption-queue", { wallet });
}
