// Popup-side helpers for talking to the background service worker.
// All calls go through chrome.runtime.sendMessage with `{ kind: "popup", ... }`.

import type {
  WalletBridgeRouteDisclosure,
  WalletBridgeRouteReadiness,
  WalletTokenBalance,
} from "../shared/token-balances.js";
import type { WalletMrvNativeSubmissionPlan } from "../shared/mrv-native-plan.js";
export type {
  WalletBridgeDisclosureValue,
  WalletBridgeRouteDisclosure,
  WalletBridgeRouteReadiness,
  WalletMrcHolder,
  WalletMrcHoldersResponse,
  WalletTokenBalance,
  WalletTokenBalanceMrcIdentity,
} from "../shared/token-balances.js";
export type { WalletMrvNativeSubmissionPlan } from "../shared/mrv-native-plan.js";

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
  /** Compatibility field name; hex execution-unit limit. */
  estimatedGas: string | null;
  /** Compatibility field name; hex lythoshi per execution unit. */
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
    /** Compatibility field name; hex lythoshi native value. */
    value?: string;
    data?: string;
    /** Compatibility field name; hex execution-unit limit. */
    gas?: string;
    /** Compatibility field name; hex lythoshi per execution unit. */
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
  bridgeRouteDisclosure?: WalletBridgeRouteDisclosure;
  bridgeRouteDisclosures?: WalletBridgeRouteDisclosure[];
  bridgeRouteReadiness?: WalletBridgeRouteReadiness | null;
  addressLabel: WalletAddressLabel | null;
  delegationHistory: WalletDelegationHistoryRow[];
  addressActivity: WalletAddressActivityRow[];
  errors: Partial<Record<"tokenBalances" | "mrcHolders" | "bridgeRoutes" | "addressLabel" | "delegationHistory" | "addressActivity", string>>;
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

/** Phase 11 Commit 3 — typed AddressActivityKind probe (GAP #17 closes).
 *  Returns one of {found, not_found, indexer_disabled, pruned, private,
 *  unknown} so the activity feed can pick the right empty-state UX.
 *  Never errors at this layer — the SW collapses transport failures
 *  into the safe defensive default ("not_found"). */
export type { WalletActivityKindEnvelope } from "../shared/activity-kind.js";
export async function bgWalletActivityKind(
  address: string,
): Promise<{
  ok: true;
  envelope: import("../shared/activity-kind.js").WalletActivityKindEnvelope;
}> {
  return send("wallet-activity-kind", { address });
}

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
//
// Phase 11 Commit 4 — extended with schemaVersion + schemaDrift +
// retention envelope (chain commits 9d59c3f + 94cf845). Closes GAP #18.
export interface IndexerRetentionView {
  /** True when the indexer also serves a deep archive. */
  archive: boolean;
  /** Rolling window size in blocks (null when the chain doesn't surface). */
  retentionBlocks: number | null;
  /** Free-form redirect hint when the indexer is rolling and an archive
   *  is available somewhere else. Chain-supplied string; the wallet
   *  renders verbatim. */
  archiveRedirect: string | null;
}

export interface IndexerStatusView {
  stale: boolean;
  lagBlocks: number | null;
  currentHeight: number | null;
  latestHeight: number | null;
  /** Chain-emitted schema version (null when chain doesn't include it).
   *  Used by the popup to detect drift against the wallet's known schema. */
  schemaVersion: number | null;
  /** True when chain's schemaVersion > the build's known version. The
   *  popup surfaces a non-blocking "wallet needs update" hint when set;
   *  parsing continues with the existing additive validators. */
  schemaDrift: boolean;
  /** Retention envelope when chain serves it. Null when chain or
   *  operator omits the field. */
  retention: IndexerRetentionView | null;
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
      schemaVersion: r.schemaVersion,
      schemaDrift: r.schemaDrift,
      retention: r.retention,
    },
  };
}

/** Fee strategy returned by `bgWalletFeeSuggestion`. */
export interface FeeSuggestion {
  /** Hex lythoshi per execution unit — sender's tip target (the only revenue path on Sprintnet). */
  maxPriorityFeePerGas: string;
  /** Hex lythoshi per execution unit — hard cap (priority + base). */
  maxFeePerGas: string;
  /** Hex lythoshi per execution unit — current/next-block base fee. Surfaced for the UI fee preview. */
  baseFeePerGas: string;
  /** Hex execution-unit limit recommendation. Non-null on Sprintnet (the chain has
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

/** Phase 11.5 Commit 2 — pre-tx hook preview. Calls
 *  `lyth_previewTransactionHooks` (mono-core @dd05511 / MS-CORE-0009).
 *  Returns a typed `ChainOutcome<TransactionHookPreview>` whose `kind`
 *  the Send preview branches on:
 *    - "live" → render the "Hooks that will run" section with real data
 *    - "mock-not-deployed" / "mock-offline" / "mock-error" → hide the
 *      section so older operators (pre-dd05511) don't degrade the UX
 *
 *  The IPC handler in service-worker.ts wraps the raw RPC in
 *  `withChainFallback` so this helper never throws on RPC errors;
 *  it only returns `{ ok: false }` for IPC-level validation failures
 *  (e.g. missing `to` address). */
export async function bgPreviewTransactionHooks(args: {
  from?: string;
  to: string;
  valueWeiHex?: string;
  data?: string;
}): Promise<
  | { ok: true; outcome: PreviewTransactionHooksOutcome }
  | { ok: false; reason?: string }
> {
  return send("wallet-preview-transaction-hooks", args);
}

/** Convenience re-export of the typed outcome the SW returns. */
export type PreviewTransactionHooksOutcome =
  import("../shared/chain-readiness.js").ChainOutcome<
    import("../shared/audit-followup-types.js").TransactionHookPreview
  >;

/** Phase 11.5 Commit 3 — chain-wide signing-activity sample. Calls
 *  `lyth_signingActivity` (mono-core @dd05511 / MD-CORE-0004) for a
 *  single authority slot (default 0) over a small window (default 20
 *  entries). Returns a `ChainOutcome<OperatorSigningActivity>` whose
 *  `kind` the Operators page branches on:
 *    - "live" → render the signing-health card with real data
 *    - any mock-* outcome → hide the card (no UI regression on older
 *      operators)
 *
 *  This is intentionally NOT per-RPC-endpoint attribution. The chain
 *  method is keyed on consensus authority index; mapping the wallet's
 *  RPC operators back to BLS validator slots would require chaining
 *  `lyth_resolveOperatorAuthority` + `lyth_clusterStatus.members[]`
 *  per row, which is deferred to a future commit. */
export async function bgChainSigningActivity(args?: {
  authorityIndex?: number;
  limit?: number;
}): Promise<
  | { ok: true; outcome: ChainSigningActivityOutcome }
  | { ok: false; reason?: string }
> {
  return send("chain-signing-activity", args ?? {});
}

export type ChainSigningActivityOutcome =
  import("../shared/chain-readiness.js").ChainOutcome<
    import("../shared/audit-followup-types.js").OperatorSigningActivity
  >;

/** Phase 11.5 Commit 5 — chain-wide operator-risk snapshot. Calls
 *  `lyth_operatorRisk` (mono-core @dd05511 / MD-CORE-0006, paired
 *  with 017cab9 operator pending-change risk previews) for a single
 *  authority slot (default 0) over a 200-round window (default).
 *  Returns a `ChainOutcome<OperatorRiskWire>` whose `kind` the
 *  Operators page branches on:
 *    - "live"  → render the AuthorityRiskCard with real chain data
 *    - mock-*  → hide the card (no regression on older operators)
 *
 *  Scope swap from the original "lyth_getServiceProbe" target: the
 *  wallet's Operators page tracks RPC URLs, not 32-byte peerIds, so
 *  getServiceProbe per row isn't structurally possible without a
 *  separate peerId-resolution chain. lyth_operatorRisk is the
 *  sibling MD-CORE-0006 surface that delivers the same intent
 *  (real chain-side operator health) keyed on authority index. */
export async function bgChainOperatorRisk(args?: {
  authorityIndex?: number;
  windowRounds?: number;
}): Promise<
  | { ok: true; outcome: ChainOperatorRiskOutcome }
  | { ok: false; reason?: string }
> {
  return send("chain-operator-risk", args ?? {});
}

export type ChainOperatorRiskOutcome =
  import("../shared/chain-readiness.js").ChainOutcome<
    import("../shared/audit-followup-types.js").OperatorRiskWire
  >;

/** Phase 11.5 Commit 7 — chain-wide upcoming-duties snapshot. Calls
 *  `lyth_upcomingDuties` (mono-core @dd05511 / MD-CORE-0005) for a
 *  single authority slot (default 0) over a 1000-round horizon
 *  (chain max). Returns a `ChainOutcome<UpcomingDuties>` whose
 *  `kind` the Operators page branches on:
 *    - "live"  → render UpcomingDutiesCard with the attestation
 *                window + key-rotation epoch boundary
 *    - mock-*  → hide the card (no regression on older operators)
 *
 *  Block production and sync duties are typed-null with reasons on
 *  Starfish-C (leader election is not predictable); the card shows
 *  them as informational rows rather than scheduled tasks. */
export async function bgChainUpcomingDuties(args?: {
  authorityIndex?: number;
  horizonRounds?: number;
}): Promise<
  | { ok: true; outcome: ChainUpcomingDutiesOutcome }
  | { ok: false; reason?: string }
> {
  return send("chain-upcoming-duties", args ?? {});
}

export type ChainUpcomingDutiesOutcome =
  import("../shared/chain-readiness.js").ChainOutcome<
    import("../shared/audit-followup-types.js").UpcomingDuties
  >;

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

/** Phase 11 Commit 2 — WS-client status probe. Returns the SW-singleton
 *  WsClient's current connection state so the popup can prefer event-
 *  driven updates over polling when WS is connected. Status values:
 *    - "disconnected" — no live socket (boot state or transient drop)
 *    - "connecting"   — socket opening; not yet usable
 *    - "connected"    — socket open, subscriptions active
 *    - "unavailable"  — WS endpoint unreachable after retries; polling
 *                       fallback advised. */
export type BgWsStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "unavailable";

export async function bgWsStatus(): Promise<
  { ok: true; status: BgWsStatus } | { ok: false; reason?: string }
> {
  return send("ws-status");
}

/** Phase 11 Commit 2 — fire-and-forget subscribe to chain `newHeads`.
 *  After the first call, the SW writes the latest block hex to
 *  chrome.storage.session under `mono.ws.lastBlockHex` every time a
 *  head arrives. ChainStatusBanner watches that key for live updates
 *  without its 8 s polling fallback firing as often.
 *
 *  Returns the WS-client status at the time of the call. The popup can
 *  use this as a hint whether to expect live updates or to keep its
 *  polling loop running at full cadence. */
export async function bgWsSubscribeNewHeads(): Promise<
  { ok: true; status: BgWsStatus } | { ok: false; reason?: string }
> {
  return send("ws-subscribe-new-heads");
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
  /** Optional execution-unit limit override (hex). When omitted the SW falls
   *  back to its native-transfer default (Sprintnet's intrinsic execution-unit
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

export async function bgWalletBuildMrvDeployPlan(args: {
  artifactBytes: string;
  artifactHash?: string;
  chainIdHex?: string;
  executionUnitLimitHex: string;
  maxExecutionFeeLythoshiHex?: string;
  priorityTipLythoshiHex?: string;
  valueWeiHex?: string;
}): Promise<
  { ok: true; plan: WalletMrvNativeSubmissionPlan } | { ok: false; reason?: string }
> {
  return send("wallet-mrv-build-deploy-plan", args);
}

export async function bgWalletBuildMrvCallPlan(args: {
  contractAddress: string;
  input: string;
  chainIdHex?: string;
  executionUnitLimitHex: string;
  maxExecutionFeeLythoshiHex?: string;
  priorityTipLythoshiHex?: string;
  valueWeiHex?: string;
}): Promise<
  { ok: true; plan: WalletMrvNativeSubmissionPlan } | { ok: false; reason?: string }
> {
  return send("wallet-mrv-build-call-plan", args);
}

export async function bgWalletSubmitMrvNativePlan(args: {
  plan: WalletMrvNativeSubmissionPlan;
  chainIdHex: string;
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
  const r = await send<Reply>("wallet-mrv-submit-plan", args);
  if (!r.ok) return r;
  return { ok: true, result: { txHash: r.txHash, via: r.via } };
}

export interface WalletMrvNativeReceipt {
  txHash: string;
  status: string | null;
  blockNumber: string | null;
  contractAddress: string | null;
  nativeReceipt: WalletMrvNativeReceiptEvidence | null;
  nativeReceiptError?: WalletMrvNativeReceiptEvidenceError;
}

export interface WalletMrvNativeReceiptEvidence {
  schema: string | null;
  txType: number | null;
  artifactHash: string | null;
  receiptCommitment: string | null;
  eventCount: number | null;
  noEvmProof: WalletMrvNoEvmReceiptProofTranscript | null;
  noEvmProofStatus: "missing" | "present-unverified";
}

export interface WalletMrvNoEvmReceiptProofTranscript {
  schema: "mono.no_evm_receipt_proof.v1";
  proofType: "canonicalReceiptsTranscript";
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
}

export interface WalletMrvNativeReceiptEvidenceError {
  reason: string;
  code?: number;
  method?: string;
  via?: string;
}

export async function bgWalletMrvNativeReceiptStatus(args: {
  txHash: string;
  chainIdHex: string;
}): Promise<
  | {
      ok: true;
      receipt: WalletMrvNativeReceipt | null;
      via?: string;
    }
  | {
      ok: false;
      reason?: string;
      code?: number;
      method?: string;
      via?: string;
    }
> {
  return send("wallet-mrv-receipt-status", args);
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
  /** Phase 7.1 — operator-surface availability from
   *  `lyth_operatorCapabilities` (SDK commit 0f483b8). Keys are surface
   *  names ("ferveo", "streams", "indexer", "prover", "websocket", etc.);
   *  values are the chain-reported status string. `null` when the
   *  capability probe failed or the operator doesn't expose the method
   *  — RPC dispatch is not gated on this; it's a display-only hint. */
  capabilities: Record<string, string> | null;
  /** Phase 7.1 — indexer height summary from `lyth_indexerStatus`. `null`
   *  when the operator's indexer is disabled or the probe failed.
   *  Surfaces as a "indexer #N (lag N)" line under the row. */
  indexerHeight: number | null;
  /** Highest block the indexer observed, for the lag computation. */
  indexerLatest: number | null;
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

/** Phase 7.1 — runtime provenance for the About page. Subset of
 *  `RuntimeProvenanceResponse` (SDK commit f67cf0e), pulled once at
 *  About-card mount via the existing operator-iteration path (GAP #11
 *  trust still applies). `null` on every chain-offline / malformed
 *  response — the About page renders a placeholder rather than failing
 *  to mount. */
export interface RuntimeProvenanceView {
  clientName: string;
  version: string;
  gitCommit: string;
  gitDirty: boolean;
  features: string;
  p2pProtocolVersion: number | null;
  buildTimestampUtc: number | null;
  latestHeight: number | null;
}

export async function bgRuntimeProvenance(): Promise<
  { ok: true; provenance: RuntimeProvenanceView } | { ok: false; reason?: string }
> {
  return send("sprintnet-runtime-provenance");
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
  /** Phase 8 — "single" for legacy single-key vaults, "multisig" for
   *  vaults created via {@link bgVaultAddMultisig}. */
  kind: "single" | "multisig";
  /** Phase 8 — N in M-of-N (0 for single vaults). */
  signerCount: number;
  /** Phase 8 — M in M-of-N (0 for single vaults). */
  threshold: number;
  /** Phase 8 — count of pending tx + governance proposals (0 for
   *  single vaults). The picker surfaces "M-of-N · K pending" pill. */
  pendingCount: number;
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
// Phase 8 — multisig vault surface (§28.5 Q70+Q75)
// ─────────────────────────────────────────────────────────────────────
//
// `bgVaultAddMultisig` creates a new multisig vault inside the
// container. The caller supplies the N signer roster (each entry
// must carry a label + 0x-address + 0x-pubkey + role) and the
// threshold M. The keystore validates + generates a fresh keypair
// for the multisig vault itself (the "executor" keypair) and
// returns its mnemonic + address — treat the mnemonic like a
// single-vault recovery phrase.
//
// `bgVaultMultisigMeta` reads the per-vault meta (signers, threshold,
// pending proposals, governance). `meta: null` means the target is a
// single-key vault or the id is unknown — both are non-errors.

import type {
  MultisigSigner,
  MultisigVaultMeta,
} from "../shared/multisig.js";

export type { MultisigSigner, MultisigVaultMeta } from "../shared/multisig.js";

export async function bgVaultAddMultisig(args: {
  signers: MultisigSigner[];
  threshold: number;
  label?: string;
}): Promise<
  | { ok: true; vaultId: string; mnemonic: string; address: string }
  | { ok: false; reason?: string }
> {
  return send("vault-add-multisig", args);
}

export async function bgVaultMultisigMeta(
  vaultId: string,
): Promise<
  | { ok: true; meta: MultisigVaultMeta | null }
  | { ok: false; reason?: string }
> {
  return send("vault-multisig-meta", { vaultId });
}

/** Read a vault's ML-DSA-65 pubkey (0x + 3904 hex chars). Requires
 *  an unlocked container. Used by the MultisigCreateModal to fill
 *  self-signer entries from existing vaults. */
export async function bgVaultPubkey(
  vaultId: string,
): Promise<{ ok: true; pubkey: string } | { ok: false; reason?: string }> {
  return send("vault-pubkey", { vaultId });
}

// ─────────────────────────────────────────────────────────────────────
// Phase 8 Commit 3 — proposal creation surface
// ─────────────────────────────────────────────────────────────────────
//
// `bgMultisigPropose` creates a new transaction proposal inside a
// multisig vault's meta. The first self-signer in the roster acts as
// proposer; their vault key signs the canonical proposal hash and
// the signature lands in approvals[0]. Container must be unlocked.
//
// `bgMultisigListProposals` is a thin convenience wrapper around the
// proposals array — saves callers from pulling the full meta when
// they only need the proposal list.

import type {
  PendingProposal,
  ProposalAction,
} from "../shared/multisig.js";

export type {
  PendingProposal,
  ProposalAction,
  ProposalSignature,
  ProposalStatus,
} from "../shared/multisig.js";

export async function bgMultisigPropose(args: {
  vaultId: string;
  action: ProposalAction;
}): Promise<
  | { ok: true; proposalId: string; proposerId: string }
  | { ok: false; reason?: string }
> {
  return send("multisig-propose", args);
}

export async function bgMultisigListProposals(
  vaultId: string,
): Promise<
  | { ok: true; proposals: PendingProposal[] | null }
  | { ok: false; reason?: string }
> {
  return send("multisig-list-proposals", { vaultId });
}

/** Add an approval signature to a pending proposal. Returns the new
 *  approval/rejection counts so the popup can reconcile the UI
 *  without a refetch. Requires unlocked container. */
export async function bgMultisigSign(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | {
      ok: true;
      signerId: string;
      status: import("../shared/multisig.js").ProposalStatus;
      approvals: number;
      rejections: number;
    }
  | { ok: false; reason?: string }
> {
  return send("multisig-sign", args);
}

/** Add a rejection signature. Mirrors bgMultisigSign but lands in
 *  the proposal's rejections[] array. */
export async function bgMultisigReject(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | {
      ok: true;
      signerId: string;
      status: import("../shared/multisig.js").ProposalStatus;
      approvals: number;
      rejections: number;
    }
  | { ok: false; reason?: string }
> {
  return send("multisig-reject", args);
}

/** Execute a proposal whose approvals have reached threshold. Pulls
 *  the action out of the proposal record + broadcasts via the
 *  encrypted-envelope path using the multisig vault's own keypair.
 *  Returns the tx hash on success; updates the proposal record's
 *  status + txHash atomically. */
export async function bgMultisigExecute(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | { ok: true; txHash: string | null }
  | { ok: false; reason?: string }
> {
  return send("multisig-execute", args);
}

// ─────────────────────────────────────────────────────────────────────
// Phase 8 Commit 5 — signer governance (§28.5 Q75)
// ─────────────────────────────────────────────────────────────────────

import type { GovernanceAction } from "../shared/multisig.js";

export type {
  GovernanceAction,
  GovernanceProposal,
  GovernanceStatus,
} from "../shared/multisig.js";

/** Propose a signer-set or threshold change. Dry-runs the action
 *  against current state before persisting — surfaces "would leave
 *  roster below threshold" etc. as a synchronous IPC error rather
 *  than an execute-time surprise. */
export async function bgMultisigProposeGovernance(args: {
  vaultId: string;
  action: GovernanceAction;
}): Promise<
  | { ok: true; proposalId: string; proposerId: string }
  | { ok: false; reason?: string }
> {
  return send("multisig-propose-governance", args);
}

export async function bgMultisigSignGovernance(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | {
      ok: true;
      signerId: string;
      status: import("../shared/multisig.js").GovernanceStatus;
      approvals: number;
      rejections: number;
    }
  | { ok: false; reason?: string }
> {
  return send("multisig-sign-governance", args);
}

export async function bgMultisigRejectGovernance(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | {
      ok: true;
      signerId: string;
      status: import("../shared/multisig.js").GovernanceStatus;
      approvals: number;
      rejections: number;
    }
  | { ok: false; reason?: string }
> {
  return send("multisig-reject-governance", args);
}

/** Apply a governance proposal's action to the meta block. The
 *  wallet enforces M-of-N at the IPC boundary; chain enforcement is
 *  out of scope (governance lives entirely in the wallet today —
 *  see shared/multisig.ts for the chain GAP). */
export async function bgMultisigExecuteGovernance(args: {
  vaultId: string;
  proposalId: string;
}): Promise<
  | { ok: true; signers: number; threshold: number }
  | { ok: false; reason?: string }
> {
  return send("multisig-execute-governance", args);
}

// ─────────────────────────────────────────────────────────────────────
// Phase 8 Commit 7 — cross-signer coordination
// ─────────────────────────────────────────────────────────────────────
//
// Multisig signers commonly live on different machines (one per
// hardware key, one per officer, etc.). The wallet's pending queue
// is local-only, so a co-signer who created a proposal needs to
// share it with the rest of the committee out-of-band. The
// export/import IPC pair serializes a proposal record (base64 JSON)
// for pasting into chat/email/QR code; the recipient's wallet
// verifies every signature against the local roster's pubkeys
// before merging.
//
// Chain-side coordination would supersede this when a user-multisig
// precompile lands (see shared/multisig.ts module doc for the GAP).

/** Serialize a proposal (tx or governance) as a base64 JSON blob
 *  for out-of-band sharing. The blob carries the full proposal
 *  record including current signatures so recipients can merge
 *  without losing approvals already collected. */
export async function bgMultisigExportProposal(args: {
  vaultId: string;
  proposalId: string;
  kind: "tx" | "gov";
}): Promise<
  { ok: true; blob: string } | { ok: false; reason?: string }
> {
  return send("multisig-export-proposal", args);
}

/** Import a shared proposal blob from another signer. Verifies
 *  every signature against the local roster's pubkeys; on a known
 *  proposal id, merges approvals/rejections (dedupe by signerId);
 *  on a new id, appends the (sanitized) proposal. */
export async function bgMultisigImportProposal(args: {
  vaultId: string;
  blob: string;
}): Promise<
  | { ok: true; kind: "tx" | "gov"; proposalId: string }
  | { ok: false; reason?: string }
> {
  return send("multisig-import-proposal", args);
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
  ClusterDelegatorsView,
  ClusterDirectoryEntry,
  ClusterDirectoryPage,
  ClusterHealth,
  ClusterMember,
  ClusterStatus,
  DelegationCap,
  DelegationHistoryRow,
  DelegationHistoryView,
  DelegationRow,
  DelegationsView,
  PendingRewardsRow,
  PendingRewardsView,
  RedemptionQueueRow,
  RedemptionQueueView,
  StakingResult,
} from "../shared/staking.js";

import type {
  ClusterDelegatorsView,
  ClusterDirectoryPage,
  ClusterStatus,
  DelegationCap,
  DelegationHistoryView,
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
 *  not double-read. Falls back to mock-derived values only when the
 *  live `lyth_pendingRewards` reader is unavailable. */
export async function bgStakingPendingRewards(
  wallet: string,
  delegations: ReadonlyArray<DelegationRow>,
): Promise<StakingResult<PendingRewardsView>> {
  return send("staking-pending-rewards", { wallet, delegations });
}

/** Read the redemption queue for a wallet. The SW prefers live
 *  `lyth_redemptionQueue(wallet)` and only returns the empty mock shape
 *  when the method is absent or Sprintnet is unreachable. */
export async function bgStakingRedemptionQueue(
  wallet: string,
): Promise<StakingResult<RedemptionQueueView>> {
  return send("staking-redemption-queue", { wallet });
}

/** Read the per-wallet delegation event timeline (delegate / undelegate /
 *  redelegate events). Surfaces in the Delegations page's "Recent
 *  activity" panel. Pages via opaque cursor — first call omits, follow-
 *  ups echo the cursor from the previous reply. */
export async function bgStakingDelegationHistory(
  wallet: string,
  limit = 50,
  cursor?: string,
): Promise<StakingResult<DelegationHistoryView>> {
  return send(
    "staking-delegation-history",
    cursor === undefined ? { wallet, limit } : { wallet, limit, cursor },
  );
}

/** Read the co-delegator list for a single cluster — used by the
 *  cluster-detail expand panel to surface demand-profile context
 *  ("47 wallets delegate here"). Returns `{ delegators: [], count: 0 }`
 *  with `via: "mock"` when the chain is offline. */
export async function bgStakingClusterDelegators(
  clusterId: number,
): Promise<StakingResult<ClusterDelegatorsView>> {
  return send("staking-cluster-delegators", { clusterId });
}

/** Derive the per-user autovote entropy seed (§23.9). The SW derives
 *  it from the unlocked ML-DSA-65 public key + a domain tag; the
 *  popup uses the returned 32-byte hex value as the seed argument
 *  to every pick* call in shared/autovote.ts. */
export async function bgStakingAutovoteSeed(): Promise<
  { ok: true; seedHex: string } | { ok: false; reason: string }
> {
  return send("staking-autovote-seed");
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 9 — passkey + two-tier IPC helpers
// ────────────────────────────────────────────────────────────────────────────

/** Wire-format passkey policy. `bigint` does not survive
 *  `chrome.runtime.sendMessage`, so we ship decimal strings on the
 *  wire and the popup helpers convert at the boundary. */
export interface BgPasskeyPolicy {
  enabled: boolean;
  mode: BgPolicyMode;
  /** Compatibility field name; decimal-string lythoshi. */
  limitWei: string;
  /** Compatibility field name; decimal-string lythoshi. */
  dailyCapWei: string;
}

export interface BgPasskeyState {
  credentials: BgPasskeyCredential[];
  policy: BgPasskeyPolicy;
}

export type BgAuthenticatorKind = "platform" | "cross-platform";
export type BgPolicyMode = "per-tx" | "daily";

export interface BgPasskeyCredential {
  credentialId: string;
  name: string;
  kind: BgAuthenticatorKind;
  createdAt: number;
}

export async function bgPasskeyGetState(
  vaultId: string,
): Promise<{ ok: true; state: BgPasskeyState } | { ok: false; reason: string }> {
  return send("passkey-get-state", { vaultId });
}

export async function bgPasskeyAddCredential(args: {
  vaultId: string;
  credential: BgPasskeyCredential;
}): Promise<{ ok: true; state: BgPasskeyState } | { ok: false; reason: string }> {
  return send("passkey-add-credential", args);
}

export async function bgPasskeyRemoveCredential(args: {
  vaultId: string;
  credentialId: string;
}): Promise<{ ok: true; state: BgPasskeyState } | { ok: false; reason: string }> {
  return send("passkey-remove-credential", args);
}

export async function bgPasskeySetPolicy(args: {
  vaultId: string;
  policy: BgPasskeyPolicy;
}): Promise<{ ok: true; state: BgPasskeyState } | { ok: false; reason: string }> {
  return send("passkey-set-policy", args);
}

/** Wire-format passkey decision — mirrors `PolicyDecision` in
 *  `shared/passkey.ts` with lythoshi bigint values encoded as hex strings. */
export type BgPasskeyDecision =
  | { kind: "passkey-ok"; credentials: BgPasskeyCredential[] }
  | { kind: "password-required"; reason: "disabled" | "no-credential" }
  | {
      kind: "over-limit";
      mode: BgPolicyMode;
      /** Compatibility field name; hex lythoshi. */
      thresholdWeiHex: string;
      /** Compatibility field name; hex lythoshi. */
      attemptedWeiHex: string;
    };

/** Consult the policy for a tx value. The wallet UI runs this before
 *  the preview screen so the user sees which unlock path applies. */
export async function bgPasskeyEvaluate(args: {
  vaultId: string;
  /** Compatibility field name; hex lythoshi. */
  valueWeiHex: string;
}): Promise<
  | { ok: true; decision: BgPasskeyDecision }
  | { ok: false; reason: string }
> {
  return send("passkey-evaluate", args);
}

/** Append to the in-memory daily-cap ledger after a successful
 *  passkey-unlocked tx submit. Caller is the popup Send flow on the
 *  Confirm → submit → success transition. */
export async function bgPasskeyRecordUsage(args: {
  vaultId: string;
  /** Compatibility field name; hex lythoshi. */
  valueWeiHex: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return send("passkey-record-usage", args);
}

// Two-tier UX feature toggles
import type {
  FeatureFlag as TwoTierFlag,
  TwoTierState,
} from "../shared/two-tier-features.js";

export async function bgTwoTierGetState(): Promise<
  { ok: true; state: TwoTierState } | { ok: false; reason: string }
> {
  return send("two-tier-get-state");
}

export async function bgTwoTierSetFeature(
  flag: TwoTierFlag,
  enabled: boolean,
): Promise<{ ok: true; state: TwoTierState } | { ok: false; reason: string }> {
  return send("two-tier-set-feature", { flag, enabled });
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 10 — SLH-DSA emergency-backup IPC helpers (§30.1)
// ────────────────────────────────────────────────────────────────────────────

import type { SlhDsaBackup } from "../shared/slh-dsa-backup.js";

/** Read the persisted backup record for the target vault. Returns
 *  `null` when the vault has not opted into the §30.1 flow. */
export async function bgSlhDsaBackupGet(
  vaultId: string,
): Promise<
  | { ok: true; backup: SlhDsaBackup | null }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-get", { vaultId });
}

/** Generate a fresh SLH-DSA backup keypair, persist the encrypted
 *  secret + entropy, and return the 24-word mnemonic for the reveal
 *  modal. The mnemonic MUST NOT be persisted by the popup — the
 *  user's cold-storage copy is the cryptographic backup. */
export async function bgSlhDsaBackupGenerate(
  vaultId: string,
): Promise<
  | { ok: true; mnemonic: string; backup: SlhDsaBackup }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-generate", { vaultId });
}

/** Re-derive the 24-word mnemonic from a stored backup record.
 *  Used by the Settings → Security "Re-export" flow. Requires the
 *  container to be unlocked. */
export async function bgSlhDsaBackupRecoverMnemonic(
  vaultId: string,
): Promise<
  | { ok: true; mnemonic: string }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-recover-mnemonic", { vaultId });
}

/** Flip `coldStorageConfirmed` to true after the user attests via
 *  the reveal modal's checkbox. Idempotent. */
export async function bgSlhDsaBackupConfirmColdStorage(
  vaultId: string,
): Promise<
  | { ok: true; backup: SlhDsaBackup | null }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-confirm-cold-storage", { vaultId });
}

/** Drop the backup record. Settings → Security exposes this as an
 *  explicit "Generate new key" action — chain registration becomes
 *  irrecoverable for the vault address after a clear+regenerate
 *  cycle. */
export async function bgSlhDsaBackupClear(
  vaultId: string,
): Promise<
  | { ok: true; cleared: boolean }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-clear", { vaultId });
}

/** Light wrapper around `eth_getTransactionReceipt` used to poll a
 *  pending registration. Returns `receipt: null` while the tx is
 *  still pending; on inclusion returns the `status` (`"0x1"` =
 *  success, `"0x0"` = revert) + `blockNumber`. */
export async function bgSlhDsaBackupPollReceipt(
  txHash: string,
): Promise<
  | {
      ok: true;
      receipt: { status: string | null; blockNumber: string | null } | null;
    }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-poll-receipt", { txHash });
}

/** Update a backup's chain-registration lifecycle status. Used by
 *  the popup-side orchestrator (`bgSlhDsaBackupSubmitRegistration`)
 *  on each tx-submit / receipt-poll. */
export async function bgSlhDsaBackupSetRegistrationStatus(args: {
  vaultId: string;
  status: "not-registered" | "pending" | "registered" | "registration-failed";
  txHash?: string | null;
  block?: number | null;
  error?: string | null;
}): Promise<
  | { ok: true; backup: SlhDsaBackup | null }
  | { ok: false; reason: string }
> {
  return send("slh-dsa-backup-set-registration-status", args);
}

import {
  buildEmergencyKeyRegisterTx,
} from "../shared/slh-dsa-chain-tx.js";
import { decodeBackupPublicKeyHex } from "../shared/slh-dsa-backup.js";

/** High-level orchestrator that submits the on-chain registration
 *  for the active vault's emergency-backup key.
 *
 *  Flow:
 *   1. Look up the persisted backup record (caller already showed
 *      the user a "Register on-chain" CTA — they have one). Decode
 *      the 32-byte pubkey from its hex storage shape.
 *   2. Build the `register(uint16,bytes)` calldata for the
 *      precompile at 0x1100.
 *   3. Submit via `bgWalletSendTx` (the same path every other
 *      contract-call tx takes).
 *   4. On submit success, flip `chainRegistrationStatus` to
 *      `"pending"` with the tx hash so the UI can render a "tx
 *      submitted, waiting for inclusion" badge + Monoscan link.
 *   5. On submit failure, flip to `"registration-failed"` with the
 *      chain reason verbatim. The user can retry from Settings.
 *
 *  Receipt polling (pending → registered | registration-failed) is
 *  the Settings page's responsibility (Commit 6 wires it). */
export async function bgSlhDsaBackupSubmitRegistration(args: {
  vaultId: string;
  publicKeyHex: string;
  chainIdHex: string;
}): Promise<
  | { ok: true; txHash: string; backup: SlhDsaBackup | null }
  | { ok: false; reason: string }
> {
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = decodeBackupPublicKeyHex(args.publicKeyHex);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const tx = buildEmergencyKeyRegisterTx(pubkeyBytes);
  const submit = await bgWalletSendTx({
    to: tx.to,
    valueWeiHex: tx.valueWeiHex,
    data: tx.data,
    chainIdHex: args.chainIdHex,
  });

  if (!submit.ok) {
    const reason =
      typeof submit.reason === "string" ? submit.reason : "tx submit failed";
    // Persist the failure so the Settings page can show a clear
    // "registration failed, retry?" state even after popup close.
    await bgSlhDsaBackupSetRegistrationStatus({
      vaultId: args.vaultId,
      status: "registration-failed",
      error: reason,
    });
    return { ok: false, reason };
  }

  const txHash = submit.result.txHash;
  const setRes = await bgSlhDsaBackupSetRegistrationStatus({
    vaultId: args.vaultId,
    status: "pending",
    txHash,
  });
  if (!setRes.ok) {
    return { ok: false, reason: setRes.reason };
  }
  return { ok: true, txHash, backup: setRes.backup };
}
