// Staking data types shared between the SW staking-client and the
// popup-side bg wrappers + UI. These mirror the SDK bindings emitted by
// mono-core-sdk @0fd8a79 but live here in the wallet so:
//
//   1. The IPC boundary doesn't need to import the SDK at the popup edge
//      (the SDK pulls in a large dependency surface; the popup just wants
//      typed JSON).
//   2. We can mark fields the chain doesn't yet emit with explicit GAP
//      comments and provide mock-fallback shapes without polluting the SDK.
//   3. The autovote algorithm (src/shared/autovote.ts)
//      sees one source of truth for the cluster metadata it consumes.
//
// Each type is annotated with the SDK binding it mirrors and the whitepaper
// §-reference for any business-logic field. Field-level GAPs are tagged
// `TODO: chain GAP — needs Nayiem` so a grep surfaces every place the
// runtime currently mocks.

// ─────────────────────────────────────────────────────────────────────────────
// Cluster directory + status
// ─────────────────────────────────────────────────────────────────────────────

/** Aggregate-health enum from `lyth_clusterDirectory` (SDK
 *  `ClusterDirectoryEntryResponse.aggregateHealth`). Chain emits a
 *  free-form string with three known values today — `"ok"`,
 *  `"degraded"`, `"halted"` per mono-core
 *  `crates/core/runtime/src/providers.rs:6848-6854` — which the wallet
 *  normalises to this enum via `normaliseHealth` in `staking-client.ts`.
 *  Unknown values fall through to `"unknown"` rather than crashing. */
export type ClusterHealth = "healthy" | "degraded" | "offline" | "unknown";

/** Format a delegation weight (basis points) as a percent string —
 *  e.g. 107 → "1.07%". This is the weight share, NOT a LYTH amount (the
 *  indexer delegation entries carry no LYTH amount; see the activity
 *  delegation rows). Returns "—" for null / non-finite input. */
export function formatWeightBpsPercent(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

/** Display label for a delegation row's cluster. Returns the real
 *  `*.cluster.mono` name when one was captured at send time (threaded onto the
 *  confirmed row via `applyCapturedClusterNames`), otherwise an honest
 *  `Cluster #<id>` using the RAW numeric id. NEVER fabricates a name: the
 *  chain/indexer ships no cluster name (§C — `cluster` is a numeric id only;
 *  no `lyth_resolveName` / `lyth_clusterName` reader and no `monok1` cluster
 *  address in mono-core), so an indexer-sourced (non-originated) stake honestly
 *  shows `Cluster #<id>` until a chain name source exists. Mirrors the
 *  NotificationRow / NotificationDetail real-name-or-#id treatment. */
export function clusterLabel(cluster: number, clusterName?: string | null): string {
  if (typeof clusterName === "string" && clusterName.length > 0) return clusterName;
  return `Cluster #${cluster}`;
}

/** Cluster directory row. Mirrors SDK `ClusterDirectoryEntryResponse` + the
 *  entity flag pulled in via `lyth_getClusterEntity` (so a single popup-
 *  visible cluster card carries the Foundation / community badge per §30.5
 *  without a second per-row roundtrip). */
export interface ClusterDirectoryEntry {
  /** Numeric cluster id used by every chain-side delegation precompile. */
  clusterId: number;
  /** §22.4 cluster-name-registry display name (e.g. `halcyon.cluster.mono`).
   *  chain GAP — no chain-side cluster-name reader yet.
   *  (cluster name registry). No `lyth_resolveName` /
   *  `lyth_clusterName` reader exists in mono-core protocore.rs as of
   *  HEAD f7236197. Wallet displays mock names from
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
  /** Observed APR in basis points from `lyth_clusterApr(clusterId)`
   *  (mono-core `253cac0b`, live since v0.0.11-testnet). Derived from
   *  cumulative reward-index growth over a rolling ~1h window; `0` is a
   *  legitimate chain value meaning "no rewards observed in the window
   *  yet" (early-testnet / no-proposing state). `null` when the
   *  per-cluster fanout call failed or the operator doesn't expose the
   *  method — display falls back to `—` per no-mock-fallbacks. Optional
   *  so non-directory ClusterDirectoryEntry fixtures stay valid. */
  aprBps?: number | null;
  /** §25.1 roster-diversity score from `lyth_getClusterDiversity(clusterId)`
   *  (SDK `ClusterDiversityView.score`, MB-2/PF-6, live in 0.3.10).
   *  Range `0..=10000` bps (`DIVERSITY_SCORE_MAX`). Headline figure
   *  blending ASN / geo / hosting-class entropy. `null` when the
   *  per-cluster diversity fanout failed or the operator doesn't expose
   *  the method — autovote + the ClusterDetail card fall back to the
   *  region-count + entity heuristic. Optional so non-directory fixtures
   *  stay valid. */
  diversityScore?: number | null;
  /** §25.1 normalised ASN-distribution entropy (`0..=10000` bps,
   *  `ClusterDiversityView.asnVariance`). `null` when unavailable. */
  asnVariance?: number | null;
  /** §25.1 normalised country-distribution entropy (`0..=10000` bps,
   *  `ClusterDiversityView.geoVariance`). `null` when unavailable. */
  geoVariance?: number | null;
  /** §25.1 normalised hosting-class-distribution entropy (`0..=10000`
   *  bps, `ClusterDiversityView.hostingSpread`). `null` when
   *  unavailable. */
  hostingSpread?: number | null;
}

/** §25.1 per-cluster roster-diversity view, mirroring SDK
 *  `ClusterDiversityView` from `lyth_getClusterDiversity(clusterId)`.
 *  All scores are `0..=10000` bps (`DIVERSITY_SCORE_MAX`). Lives here so
 *  the IPC boundary + the autovote scorer share one shape without
 *  importing the SDK at the popup edge. */
export interface ClusterDiversity {
  clusterId: number;
  /** Headline diversity score (`0..=10000`). */
  score: number;
  /** Normalised ASN-distribution entropy (`0..=10000`). */
  asnVariance: number;
  /** Normalised country-distribution entropy (`0..=10000`). */
  geoVariance: number;
  /** Normalised hosting-class-distribution entropy (`0..=10000`). */
  hostingSpread: number;
}

/** Maximum value of any §25.1 diversity score (bps). Mirrors SDK
 *  `DIVERSITY_SCORE_MAX`. */
export const DIVERSITY_SCORE_MAX = 10_000;

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
  consensusPubkey: string;
  /** Operator membership state inside this cluster. Free-form string on
   *  the wire (`ClusterMemberResponse.state` is `string` in SDK 0.3.9 —
   *  no formal enum yet). Live `lyth_clusterStatus(0)` probes
   *  against op-1 (`178.105.15.216`, height ~87828) return a
   *  mix of these tokens:
   *
   *  - `"active"`  — currently signing.
   *  - `"standby"` — in the cluster roster but not in the active signing
   *     set (the chain DOES emit this post-regenesis — supersedes the
   *     earlier "no standby token" reading).
   *  - `"jailed"`  — in an active jail period.
   *  - `"offline"` — slashed / ejected.
   *
   *  The long-term ask is a formal enum on the SDK type
   *  plus an explicit `standbyCount` aggregate on `ClusterStatusResponse`.
   *
   *  The wallet renders the token pass-through. `StateChip`
   *  (`ClusterDetail.tsx`) maps `"active"`/`"jailed"`/`"offline"`
   *  explicitly; `"standby"` and any future token fall through to the
   *  neutral muted-fg dot (a dedicated standby treatment is a flagged
   *  UX follow-up). */
  state: string;
}

/** Per-operator metadata from `lyth_operatorInfo`. Mirrors the
 *  user-facing subset of SDK `OperatorInfoResponse`; SDK-internal
 *  fields (operatorKeyFingerprint, consensusKeyFingerprint, capability,
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

/** Cluster-level service-tier offerings derived from per-operator
 *  `lyth_getServiceProbe` results. The cluster is treated
 *  as offering a tier when at least one member operator probes
 *  reachable for that tier ("any-true" aggregation).
 *
 *  Surfaced for the five user-facing tiers; SDK exposes ten bits in
 *  `NODE_REGISTRY_CAPABILITIES` but Broadcaster, WebSocket, LightClient,
 *  PublicAPI, and GpuProve are operator-internal and skipped here.
 *
 *  The long-term fix is a `ClusterDirectoryEntry.serviceTiers:
 *  string[]` aggregate field on the chain side; once shipped, the wallet
 *  can drop per-operator probing for this surface entirely. */
export interface ClusterServiceTiers {
  rpc: boolean;
  indexer: boolean;
  archive: boolean;
  oracle: boolean;
  bridgeRelay: boolean;
  /** Whether ANY probe completed (vs. all timed out or returned null).
   *  Popup uses this to suppress the badge row entirely when chain data
   *  is fully unavailable (silent fallback). */
  anyReachable: boolean;
  /** Number of operators successfully probed (denominator for the UI
   *  "1/10 archive" sort of phrasing if we ever surface it). */
  probedOperators: number;
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
   *  §23.7 auto-rebalance hook). */
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
  /** Accrued rewards as a hex lythoshi quantity (18-decimal native LYTH).
   *  The `amountWei` key is a legacy upstream/API compatibility name only. */
  amountWei: string;
  /** Cluster's effective reward rate at observation time, in basis
   *  points. Rewards are SERVICE-PROVED: they accrue from the services a
   *  cluster actually delivers, then split across the cluster's delegators
   *  in proportion to delegated weight — stake is not itself rewarded.
   *  `null` when the chain hasn't surfaced a rate for this cluster (the
   *  per-cluster instant rate isn't yet emitted). */
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
// MOCK — verify against live chain when the testnet back
// ────────────────────────────────────────────────────
// The testnet cluster set may be offline. The wallet's read paths
// fall through to these fixtures when every active operator fails the
// genesis-pin trust check or returns a transport-level error.
//
// Numbers are illustrative-only: they preserve the whitepaper §14 + §23
// architecture (10 operators per cluster, 7-of-10 threshold, mixed
// region diversity, mixed entity flags including Foundation clusters
// per §30.5) so the UI renders the realistic shape rather than empty
// state. The autovote algorithm gets exercised
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

/** Mock per-cluster reward-rate table, in basis points. Numbers are
 *  illustrative only. Under the service-based model a cluster's reward
 *  rate reflects the services it actually proves and the delegators it
 *  shares those rewards across — so a busy cluster carrying many
 *  delegators yields a lower per-delegator rate, and community clusters
 *  sit marginally above Foundation clusters since the Foundation burns
 *  its rewards per §30.5. Stake itself is not rewarded; it only sets a
 *  cluster's top-100 admission rank and a delegator's share of the
 *  proved-service rewards.
 *
 *  RETIRED FROM USER-FACING DISPLAY — the chain now exposes
 *  `lyth_clusterApr(clusterId)` (mono-core `253cac0b`, live since
 *  v0.0.11-testnet). The Stake-page APR cells read the real value off
 *  `ClusterDirectoryEntry.aprBps` (populated by the directory fanout in
 *  `staking-client.ts::readClusterApr`). The chain-reader path is in place for the
 *  display path.
 *
 *  This table is NOT yet deletable: it still feeds (1) the autovote
 *  Max-Yield scorer (`src/shared/autovote.ts::clusterApr`, a sync
 *  deterministic algorithm — converting it to the async chain reader is
 *  the flagged "autovote Max-Yield disposition" follow-up) and (2) the
 *  `lyth_pendingRewards`-unavailable fallback in
 *  `staking-client.ts::mockPendingRewardsView`. Both must move to the
 *  real reader before this constant can be removed. */
export const MOCK_CLUSTER_APR_BPS: Readonly<Record<number, number>> = {
  1: 820, // 8.20% — Foundation, many delegators sharing proved rewards
  2: 805, // 8.05% — Foundation
  3: 940, // 9.40% — fewer delegators, higher per-delegator share
  4: 720, // 7.20% — degraded health → fewer services proved
  5: 880, // 8.80% — healthy community cluster
  6: 1010, // 10.10% — newest cluster, few delegators sharing rewards
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
// Chain investigation
// ─────────────────────────────────────────────────────────────────────────────
//
// Re-audit of mono-core HEAD `ce93d83` + mono-core-sdk @0fd8a79 status:
//
//   ✅ `lyth_addressActivityKind` (chain d77e4fc / SDK exposes
//      `RpcClient.lythAddressActivityKind`) — REPLACES the P4.4
//      heuristic empty-state.
//
//   ✅ `lyth_indexerStatus` returning `IndexerStatus | null` (chain
//      94cf845 / SDK `RpcClient.lythIndexerStatus`) — supports
//      activity-feed pagination + archive-redirect.
//
//   ✅ `lyth_subscribe` / `lyth_unsubscribe` (chain 0aaa5fc / SDK
//      `RpcClient.lythSubscribe`/`lythUnsubscribe`) — note: these
//      are WebSocket-only on the chain side. The
//      WS-client wires them with graceful HTTP-fallback.
//
//   ⚠️ `lyth_operatorCapabilities` (chain 017cab9 / SDK
//      `RpcClient.lythOperatorCapabilities`) — risk-preview field
//      shape evolving; the wire-up renders the
//      stable subset (latency / version / uptime) and uses
//      `withChainFallback` to keep the operators page rendering when
//      the chain method 404s.
//
//   ⚠️ `7160636` registry public service probe runner — chain ships
//      it, but the SDK at 0fd8a79 doesn't yet have a typed helper.
//      The wallet calls via `lyth_publicServiceProbe` direct
//      RPC behind `withChainFallback`.
//
//   ✅ `lyth_pendingRewards` — wallet calls the direct RPC first and
//      uses the old mock derivation only when the method is unavailable
//      or the testnet is offline.
//
//   ✅ `lyth_redemptionQueue` — wallet calls the direct RPC first and
//      uses the old empty queue only when the method is unavailable or
//      The testnet is offline. Current core tickets are maturity-height
//      and weight-bps based; token amount remains optional.
//
//   ❌ `lyth_clusterApr` — STILL no chain reader. MOCK_CLUSTER_APR_BPS
//      stays the wallet's authoritative APR source.
//
//   ❌ `lyth_namingRegistry` (§22.8) — STILL no chain reader. Cluster
//      names display `cluster-<id>` until the chain wires the resolver.
//
// The above is the binding wallet-side view; the testnet deploy status
// of each method is checked at runtime via `withChainFallback` rather
// than baked into the build.
