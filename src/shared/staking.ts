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
   *  TODO: chain GAP — the cluster-name registry is not yet emitted by
   *  any SDK read; the wallet displays `cluster-<id>` until Nayiem wires
   *  the name resolver. */
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
// TODO: chain GAP — needs Nayiem
// ────────────────────────────────
// The SDK at 0fd8a79 (Phase 7.1 head) does not yet expose:
//   - per-account pending-rewards aggregation
//   - redemption-queue rows for in-flight unstake events
//
// Both shapes are typed here against the whitepaper §23 economic model
// so the popup can render the cards once the chain side lands; the SW
// staking-client returns `{ ok: false, reason: "chain GAP" }` until the
// SDK surfaces a `lyth_pendingRewards` / `lyth_redemptionQueue` reader.

/** Aggregated pending rewards across every active delegation. */
export interface PendingRewardsRow {
  /** Cluster id the rewards accrued from. */
  cluster: number;
  /** Accrued rewards in wei-LYTH (smallest unit). */
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
  totalAmountWei: string;
  rows: PendingRewardsRow[];
  /** Block height the snapshot was taken at; absent when the data is
   *  mocked (chain GAP). */
  blockHeight: string | null;
}

/** Redemption-queue row. NOTE: per whitepaper §23.2 "zero unbonding
 *  period" for delegators, this is a vestigial concept — direct
 *  unstake is instant for the delegator side. The shape exists to
 *  cover the chain-side eventual implementation of any redemption-
 *  delay schedule (which would be a constitutional-layer change per
 *  §30.6 and therefore unlikely pre-mainnet). For now the queue is
 *  always empty. */
export interface RedemptionQueueRow {
  cluster: number;
  amountWei: string;
  /** Unix timestamp the redemption clears at. `null` when the chain
   *  reports an instant exit (the §23.2 baseline). */
  unlockAt: number | null;
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
 *  TODO: chain GAP — needs Nayiem
 *  ────────────────────────────────
 *  As of mono-core-sdk @0fd8a79 there is NO chain-side read for per-
 *  cluster APR. The Phase 7.1 brief expected `lyth_clusterApr` (or a
 *  REST equivalent at `/api/v1/staking/apr`) to land via mono-core
 *  commit 964b0a3 "Expose advanced read API routes" — that commit
 *  exposed certificates, registry, and DAG routes but no staking APR.
 *  This table remains the wallet's authoritative APR source until the
 *  chain side ships a reader; the §23.5 quadratic reward curve is
 *  deterministic, so a future activation just swaps the table for a
 *  per-cluster call. */
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
//   ❌ `lyth_pendingRewards` — STILL no chain reader. Mock derivation
//      stays in `staking-client.readPendingRewards`.
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
