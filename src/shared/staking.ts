// Phase 7 — staking data types shared between the SW staking-client and the
// popup-side bg wrappers + UI. These mirror the SDK bindings emitted by
// mono-core-sdk @0fd8a79 (Phase 7.1 uplift) but live here in the wallet so:
//
//   1. The IPC boundary doesn't need to import the SDK at the popup edge
//      (the SDK pulls in a large dependency surface; the popup just wants
//      typed JSON).
//   2. We can mark fields the chain doesn't yet emit with explicit GAP
//      comments and provide mock-fallback shapes without polluting the SDK.
//   3. The autovote algorithm (src/shared/autovote.ts, Phase 7 commit 3)
//      sees one source of truth for the cluster metadata it consumes.
//
// Each type is annotated with the SDK binding it mirrors and the whitepaper
// §-reference for any business-logic field. Field-level GAPs are tagged
// `TODO: chain GAP — needs Nayiem` so a grep surfaces every place the
// runtime currently mocks.

// ─────────────────────────────────────────────────────────────────────────────
// Cluster directory + status
// ─────────────────────────────────────────────────────────────────────────────

/** Aggregate-health enum from `lyth_clusters` (SDK
 *  `ClusterDirectoryEntryResponse.aggregateHealth`). The chain reports this
 *  as a free-form string today; the wallet treats unknowns as `"unknown"`
 *  rather than crashing. */
export type ClusterHealth = "healthy" | "degraded" | "offline" | "unknown";

/** Cluster directory row. Mirrors SDK `ClusterDirectoryEntryResponse` + the
 *  entity flag pulled in via `lyth_getClusterEntity` (so a single popup-
 *  visible cluster card carries the Foundation / community badge per §30.5
 *  without a second per-row roundtrip). */
export interface ClusterDirectoryEntry {
  /** Numeric cluster id used by every chain-side delegation precompile. */
  clusterId: number;
  /** §22.4 cluster-name-registry display name (e.g. `halcyon.cluster.mono`).
   *  chain GAP — see `_dev-notes/browser-wallet/active-nayiem-pings.md`
   *  PING #8 (cluster name registry). No `lyth_resolveName` /
   *  `lyth_clusterName` reader exists in mono-core protocore.rs as of
   *  HEAD f7236197 (2026-05-27). Wallet displays mock names from
   *  `MOCK_CLUSTERS[*].name` below; replace with a real lookup when the
   *  chain ships the primitive. */
  name: string | null;
  /** Member count (`ClusterDirectoryEntryResponse.size`). Whitepaper §14
   *  fixes this at 10 for v1; surfaced from the chain so future
   *  configurations (200/500/1000 cluster scaling per OI-0061) render
   *  honestly. */
  size: number;
  /** BFT threshold (`threshold`). Whitepaper §28: 7-of-10 for v1. */
  threshold: number;
  /** Aggregate health string from the chain. */
  health: ClusterHealth;
  /** Geographic region tags (`regionDiversity`). Per §28.3.1 the chain
   *  cross-checks these against IP-geolocation; the wallet displays them
   *  verbatim and aggregates the cardinality for the diversity score. */
  regions: string[];
  /** Whether the cluster is in the active consensus set right now. */
  active: boolean;
  /** Entity flag from `lyth_getClusterEntity` (§30.5). `"mono-labs"` for
   *  Foundation clusters that the chain expects to sunset; `"independent"`
   *  for community clusters; pass-through for anything else the chain
   *  emits. */
  entity: string | null;
}

/** Paginated wrapper. Mirrors SDK `ClusterDirectoryPageResponse`. */
export interface ClusterDirectoryPage {
  page: number;
  limit: number;
  totalClusters: number;
  clusters: ClusterDirectoryEntry[];
}

/** Cluster member envelope from `lyth_clusterStatus`. Each entry is one of
 *  the 10 operator-positions inside the cluster. */
export interface ClusterMember {
  operatorId: string;
  blsPubkey: string;
  /** Operator lifecycle state — `"active"`, `"standby"`, `"jailed"`, etc.
   *  The chain emits this as a free-form string; the wallet renders it
   *  pass-through and only branches on `"active"` for the consensus-
   *  participant count. */
  state: string;
}

/** Per-operator metadata from `lyth_operatorInfo`. Mirrors the
 *  user-facing subset of SDK `OperatorInfoResponse`; SDK-internal
 *  fields (operatorKeyFingerprint, blsKeyFingerprint, capability,
 *  activeClusterIds) are deliberately not surfaced — add them when a
 *  UI consumer needs them. `bondedAmount` is the operator's self-bond
 *  in lythoshi (V4.1-BOND-0001 = 5,000 LYTH chain-enforced floor). */
export interface WalletOperatorInfo {
  operatorId: string;
  moniker: string | null;
  alias: string | null;
  bonded: boolean;
  /** Self-bond in lythoshi. Stringified bigint for IPC transparency
   *  (popup never sees a `bigint`); the popup parses for display. */
  bondedAmount: string;
  commissionBps: number | null;
  delegationCount: number | null;
  /** Operator-level lifecycle string from the chain. Free-form; the
   *  wallet renders it pass-through. Separate concept from
   *  `ClusterMember.state` (which is membership state inside one
   *  specific cluster). */
  lifecycleState: string;
}

/** Full cluster status. Mirrors SDK `ClusterStatusResponse`. */
export interface ClusterStatus {
  clusterId: number;
  threshold: number;
  size: number;
  /** Members currently above the chain-side liveness threshold. The chain
   *  emits these as live-count integers rather than per-member liveness
   *  flags. */
  live: number;
  lagging: number;
  offline: number;
  maintenance: number;
  members: ClusterMember[];
  /** Current epoch (`bigint` on the SDK; the wallet stringifies for IPC
   *  transparency). */
  epoch: string | null;
  /** Current round. */
  round: string | null;
  /** Quorum string (e.g. `"7-of-10"`). */
  quorum: string;
  /** Reputation score (§14 + §28.3). Float on the chain; `null` when not
   *  yet computed. */
  reputationScore: number | null;
  /** Liveness score (same shape). */
  livenessScore: number | null;
  /** Block height the row was last refreshed. */
  lastUpdateHeight: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegation surface (§23.2 + §23.6 + §23.9)
// ─────────────────────────────────────────────────────────────────────────────

/** One delegation row. Mirrors SDK `DelegationRow`. */
export interface DelegationRow {
  /** Cluster id receiving the delegated weight. */
  cluster: number;
  /** Delegated weight in basis points. The wallet's autovote and stake-
   *  form consume bps directly; conversion to LYTH amount happens at the
   *  render layer with the user's current balance. */
  weightBps: number;
}

/** Active-delegations envelope for a wallet. Mirrors SDK
 *  `DelegationsResponse`. `totalBps` is the chain-canonical sum; the
 *  wallet treats it as authoritative (the per-row sum is an integrity
 *  check, not the source of truth). */
export interface DelegationsView {
  wallet: string;
  rows: DelegationRow[];
  totalBps: number;
}

/** Active-cap state from `lyth_getDelegationCap`. The cap binds on capital
 *  per wallet per cluster (§23.6); the wallet's stake form enforces the
 *  invariant client-side and surfaces the cap-headroom badge on every
 *  cluster card. */
export interface DelegationCap {
  /** Per-cluster cap in basis points. `null` is the wallet's normalised
   *  "disabled" — the chain encodes disabled as `u32::MAX`. */
  capBps: number | null;
  /** Height of the most recent milestone that changed the cap (used by
   *  §23.7 auto-rebalance hook in Phase 7.1). */
  lastChangedAtHeight: string;
}

/** Delegation history event row. Mirrors SDK `DelegationHistoryRecord`.
 *  Surfaces in the Delegations page transaction-history view. */
export interface DelegationHistoryRow {
  blockHeight: string;
  txIndex: number;
  logIndex: number;
  wallet: string;
  cluster: number;
  /** Destination cluster for redelegations (`be79a2f` precompile). Null
   *  on plain delegate/undelegate events. */
  toCluster: number | null;
  /** `"delegated" | "undelegated" | "redelegated"`. The chain emits as a
   *  free-form string; the wallet renders the three known kinds and a
   *  pass-through fallback. */
  kind: string;
  weightBps: number;
  walletTotalBps: number | null;
}

/** Paginated per-wallet delegation event timeline. Mirrors the
 *  `lyth_getDelegationHistory` reader, which returns a plain
 *  `DelegationHistoryRecord[]` on the wire — the wallet wraps the array
 *  in this envelope so the popup's render path can branch on `via:
 *  "mock"` and surface a "chain offline — history may be stale" hint
 *  when the cluster is offline. */
export interface DelegationHistoryView {
  wallet: string;
  rows: DelegationHistoryRow[];
}

/** Co-delegators for a cluster. Mirrors SDK `ClusterDelegatorsResponse`
 *  (binding from `lyth_getClusterDelegators`). The chain returns a
 *  capped list of delegator addresses + a `count` of the total scanned
 *  slots; the wallet surfaces this on the cluster-detail panel so the
 *  user can see "n wallets delegate here" without picking a delegator
 *  from the list (the addresses themselves are unlabeled and not
 *  individually meaningful in the wallet UI). */
export interface ClusterDelegatorsView {
  cluster: number;
  /** Addresses returned by the chain in canonical scan order. The
   *  wallet doesn't sort or dedup; the chain side already deduplicates. */
  delegators: string[];
  /** Number of delegator slots scanned by the node — may exceed
   *  `delegators.length` when the chain caps the returned list. */
  count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewards + redemption queue (§23.4, §23.2)
// ─────────────────────────────────────────────────────────────────────────────
//
// The chain now exposes `lyth_pendingRewards(wallet)` for the rewards
// snapshot and `lyth_redemptionQueue(wallet, [block])` for durable
// maturity-height redemption tickets. The wallet keeps legacy `amountWei`
// and `unlockAt` compatibility names at the IPC boundary, but the live
// queue is block-height based; UI code must use `maturityHeight`/`mature`
// rather than treating `unlockAt: null` as withdrawable.

/** Aggregated pending rewards across every active delegation. */
export interface PendingRewardsRow {
  /** Cluster id the rewards accrued from. */
  cluster: number;
  /** Delegated weight at observation time, in basis points. */
  weightBps: number;
  /** Unsettled rewards from this cluster, as a decimal lythoshi string. */
  unsettledAmountLythoshi: string;
  /** Accrued rewards as a hex lythoshi quantity (8-decimal native LYTH).
   *  The `amountWei` key is a legacy upstream/API compatibility name only. */
  amountWei: string;
  /** Cluster's effective APR at observation time, in basis points. `null`
   *  when the chain hasn't surfaced an APR for this cluster (per §23.5
   *  the quadratic curve is deterministic, but the per-cluster instant
   *  rate isn't yet emitted). */
  effectiveAprBps: number | null;
}

/** Pending-rewards envelope keyed by wallet. */
export interface PendingRewardsView {
  wallet: string;
  /** Total pending rewards, as a decimal lythoshi string. */
  totalAmountLythoshi: string;
  /** Settled-but-unclaimed rewards, as a decimal lythoshi string. */
  settledPendingLythoshi: string;
  /** Unsettled accrual still attributed to delegation rows, as decimal
   *  lythoshi. */
  unsettledAmountLythoshi: string;
  /** Whether the wallet has chain-side auto-compounding enabled. */
  autoCompound: boolean;
  /** Total accrued rewards as hex lythoshi. `totalAmountWei` is retained
   *  as a compatibility boundary name until the upstream staking API shape
   *  is renamed. */
  totalAmountWei: string;
  rows: PendingRewardsRow[];
  /** Block height the snapshot was taken at; absent when the data is
   *  mocked because `lyth_pendingRewards` is unavailable/offline. */
  blockHeight: string | null;
}

/** Redemption-queue row from `lyth_redemptionQueue(wallet, [block])`.
 *  The committed core reader exposes weight-bps tickets and maturity
 *  heights; `amountWei` remains a legacy compatibility field and is
 *  `"0x0"` when the live ticket has no token amount. */
export interface RedemptionQueueRow {
  /** Queue index in the wallet's chain-side ticket list. */
  index: number;
  cluster: number;
  /** Removed delegation weight in basis points. */
  weightBps: number;
  /** Optional token amount, as decimal lythoshi, when a future chain/SDK
   *  response includes it. Null for the current weight-only core ticket. */
  amountLythoshi: string | null;
  /** Redemption amount as hex lythoshi. The `amountWei` key remains only
   *  for staking API compatibility. */
  amountWei: string;
  /** Unix timestamp the redemption clears at. The live V4.1 queue is
   *  height-based, so this stays null unless a future chain response
   *  explicitly supplies wall-clock unlock time. */
  unlockAt: number | null;
  /** Canonical block height at which the ticket was created. */
  createdHeight: string;
  /** Canonical block height at which the ticket becomes mature. */
  maturityHeight: string;
  /** Chain-side maturity probe at the requested block. Null when the
   *  operator could not determine maturity for that block selector. */
  mature: boolean | null;
}

/** Redemption-queue envelope keyed by wallet. */
export interface RedemptionQueueView {
  wallet: string;
  rows: RedemptionQueueRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Result envelopes
// ─────────────────────────────────────────────────────────────────────────────

/** Common result envelope — every staking-client read returns either an
 *  `ok: true, data` payload or an `ok: false, reason` failure. The popup
 *  surfaces `reason` verbatim in the error banner. */
export type StakingResult<T> =
  | { ok: true; data: T; via?: string }
  | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Mock cluster fixtures
// ─────────────────────────────────────────────────────────────────────────────
//
// MOCK — verify against live chain when Sprintnet back
// ────────────────────────────────────────────────────
// The Sprintnet cluster set is offline at Phase 7 phase-start (Nayiem
// deploying Ferveo wiring after CI iteration). The wallet's read paths
// fall through to these fixtures when every active operator fails the
// genesis-pin trust check or returns a transport-level error.
//
// Numbers are illustrative-only: they preserve the whitepaper §14 + §23
// architecture (10 operators per cluster, 7-of-10 threshold, mixed
// region diversity, mixed entity flags including Foundation clusters
// per §30.5) so the UI renders the realistic shape rather than empty
// state. The autovote algorithm (Phase 7 commit 3) gets exercised
// against this shape directly in tests.

export const MOCK_CLUSTERS: ReadonlyArray<ClusterDirectoryEntry> = [
  {
    clusterId: 1,
    name: "halcyon.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["fsn1", "nbg1", "hel1"],
    active: true,
    entity: "mono-labs",
  },
  {
    clusterId: 2,
    name: "north-mesh.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["ash", "fsn1", "sin"],
    active: true,
    entity: "mono-labs",
  },
  {
    clusterId: 3,
    name: "polar.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["sin", "ash"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 4,
    name: "ember.cluster.mono",
    size: 10,
    threshold: 7,
    health: "degraded",
    regions: ["hel1", "nbg1"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 5,
    name: "salt.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["ash", "fsn1"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 6,
    name: null, // mid-registration cluster — no name yet
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["sin"],
    active: true,
    entity: "independent",
  },
];

/** Mock per-cluster APR table, in basis points. Numbers are illustrative
 *  and approximate the §23 model's diminishing-returns regime (clusters
 *  with more delegated stake → lower per-stake APR; community clusters
 *  marginally above Foundation clusters since the Foundation burns its
 *  rewards per §30.5).
 *
 *  chain GAP — see `_dev-notes/browser-wallet/active-nayiem-pings.md`
 *  PING #7 (APR / reward-rate chain primitive). No `lyth_clusterApr`,
 *  `lyth_rewardRate`, or `lyth_clusterRewardShare` reader exists in
 *  mono-core protocore.rs as of HEAD f7236197 (2026-05-27). The §23.5
 *  quadratic reward curve is deterministic by design, so a future
 *  activation just swaps the table for a per-cluster call. */
export const MOCK_CLUSTER_APR_BPS: Readonly<Record<number, number>> = {
  1: 820, // 8.20% — Foundation, mid-saturation
  2: 805, // 8.05% — Foundation
  3: 940, // 9.40% — under-served, higher APR per §23.5 quadratic
  4: 720, // 7.20% — degraded health → slightly suppressed APR
  5: 880, // 8.80% — healthy community cluster
  6: 1010, // 10.10% — newest cluster, max APR before delegation arrives
};

/** Mock per-cluster reputation. Range 0..1; community clusters with
 *  longer track records score higher than fresh entrants. */
export const MOCK_CLUSTER_REPUTATION: Readonly<Record<number, number>> = {
  1: 0.94,
  2: 0.92,
  3: 0.78,
  4: 0.55,
  5: 0.82,
  6: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11 chain investigation — 2026-05-16
// ─────────────────────────────────────────────────────────────────────────────
//
// Re-audit of mono-core HEAD `ce93d83` + mono-core-sdk @0fd8a79 status:
//
//   ✅ `lyth_addressActivityKind` (chain d77e4fc / SDK exposes
//      `RpcClient.lythAddressActivityKind`) — REPLACES the P4.4
//      heuristic empty-state. GAP #17 closes in Phase 11 Commit 3.
//
//   ✅ `lyth_indexerStatus` returning `IndexerStatus | null` (chain
//      94cf845 / SDK `RpcClient.lythIndexerStatus`) — supports
//      activity-feed pagination + archive-redirect. GAP #18 closes
//      in Phase 11 Commit 4.
//
//   ✅ `lyth_subscribe` / `lyth_unsubscribe` (chain 0aaa5fc / SDK
//      `RpcClient.lythSubscribe`/`lythUnsubscribe`) — note: these
//      are WebSocket-only on the chain side. The Phase 11 Commit 2
//      WS-client wires them with graceful HTTP-fallback.
//
//   ⚠️ `lyth_operatorCapabilities` (chain 017cab9 / SDK
//      `RpcClient.lythOperatorCapabilities`) — risk-preview field
//      shape evolving; the Phase 11 Commit 5 wire-up renders the
//      stable subset (latency / version / uptime) and uses
//      `withChainFallback` to keep the operators page rendering when
//      the chain method 404s.
//
//   ⚠️ `7160636` registry public service probe runner — chain ships
//      it, but the SDK at 0fd8a79 doesn't yet have a typed helper.
//      Phase 11 Commit 5 calls via `lyth_publicServiceProbe` direct
//      RPC behind `withChainFallback`.
//
//   ✅ `lyth_pendingRewards` — wallet calls the direct RPC first and
//      uses the old mock derivation only when the method is unavailable
//      or Sprintnet is offline.
//
//   ✅ `lyth_redemptionQueue` — wallet calls the direct RPC first and
//      uses the old empty queue only when the method is unavailable or
//      Sprintnet is offline. Current core tickets are maturity-height
//      and weight-bps based; token amount remains optional.
//
//   ❌ `lyth_clusterApr` — STILL no chain reader. MOCK_CLUSTER_APR_BPS
//      stays the wallet's authoritative APR source.
//
//   ❌ `lyth_namingRegistry` (§22.8) — STILL no chain reader. Cluster
//      names display `cluster-<id>` until Nayiem wires the resolver.
//
// The above is the binding wallet-side view; Sprintnet deploy status
// of each method is checked at runtime via `withChainFallback` rather
// than baked into the build.
