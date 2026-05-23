// Phase 7 — staking-client. SW-side RPC wrappers for the §23 delegation
// surface. Every read goes through `sprintnetJsonRpc` so the existing
// operator-iteration + genesis-pin trust path (GAP #11) defends every
// staking read against orphan-fork operators.
//
// Each read returns a `StakingResult<T>` envelope:
//   - on transport / RPC error, falls back to MOCK_* fixtures with
//     `ok: true, data, via: "mock"` so the popup renders the realistic
//     architecture shape while Sprintnet is offline (Phase 7 phase-
//     start posture);
//   - on the few remaining chain GAPs, returns a typed mock with
//     `via: "mock"` and a clear `// TODO: chain GAP` comment at the
//     call site;
//   - on protocol-shape mismatch (the chain returned something we
//     don't recognise), returns `ok: false, reason`.
//
// The SW IPC dispatchers (service-worker.ts case "staking-*") consume
// the envelopes verbatim.
//
// Phase 7.1 — wire contract anchored to SDK. The `Raw*` types below are
// the wire form (everything optional + JSON-serialised bigints as string
// | number); the SDK exports the strict normalised shapes referenced in
// each block's `// SDK contract:` annotation. Aligning the cast targets
// to SDK types means a future chain-side shape change surfaces in the
// wallet typecheck the next time the SDK rebuilds.

import { sprintnetJsonRpc } from "./tx-mldsa.js";
import {
  MOCK_CLUSTER_APR_BPS,
  MOCK_CLUSTER_REPUTATION,
  MOCK_CLUSTERS,
  type ClusterDelegatorsView,
  type ClusterDirectoryEntry,
  type ClusterDirectoryPage,
  type ClusterHealth,
  type ClusterMember,
  type ClusterStatus,
  type DelegationCap,
  type DelegationHistoryRow,
  type DelegationHistoryView,
  type DelegationRow,
  type DelegationsView,
  type PendingRewardsRow,
  type PendingRewardsView,
  type RedemptionQueueView,
  type StakingResult,
} from "../shared/staking.js";
import { LYTHOSHI_PER_LYTH } from "../shared/native-amount.js";

// SDK-contract anchors live in `staking-client.test.ts` as typed fixtures
// (`const sdkShape: ClusterDirectoryPageResponse = ...`). When Nayiem
// rotates a chain-side field name and the SDK re-exports the new shape,
// those fixtures fail to typecheck before the wallet ships against a
// stale contract. The `Raw*` types below are the loosened wire form
// (optional everywhere, bigint admitted as string | number) so a
// misbehaving operator can't crash the parser; the runtime checks
// further down validate before normalisation.

// ─────────────────────────────────────────────────────────────────────────────
// Cluster directory
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: ClusterDirectoryPageResponse + ClusterDirectoryEntryResponse.
// The wire form below is the SDK shape with every field optional so a
// misbehaving operator can't crash the parser; the runtime check below
// validates `clusters` is an array before any normalisation.
interface RawClusterDirectoryPage {
  page?: number;
  limit?: number;
  totalClusters?: number;
  clusters?: ReadonlyArray<RawClusterDirectoryEntry>;
}

interface RawClusterDirectoryEntry {
  clusterId?: number;
  size?: number;
  threshold?: number;
  aggregateHealth?: string;
  regionDiversity?: ReadonlyArray<string> | null;
  active?: boolean;
}

// SDK contract: ClusterEntityResponse (bindings — not top-level exported).
// Wire form keeps every field optional; the chain side's strict shape is
// { cluster: number, entity: string, entityCode: number, block: unknown }
// per `mono-core-sdk/packages/ts/src/bindings/ClusterEntityResponse.ts`.
interface RawClusterEntity {
  cluster?: number;
  entity?: string;
}

function normaliseHealth(raw: unknown): ClusterHealth {
  if (raw === "healthy" || raw === "degraded" || raw === "offline") return raw;
  return "unknown";
}

function normaliseDirectoryEntry(
  raw: RawClusterDirectoryEntry,
  entityByCluster: Map<number, string>,
): ClusterDirectoryEntry | null {
  if (typeof raw.clusterId !== "number") return null;
  return {
    clusterId: raw.clusterId,
    // §22.8 namingRegistry precompile (0x1106) hasn't surfaced a reader
    // in the SDK as of 0fd8a79. Once `lythResolveName(".cluster.mono")`
    // (or equivalent) lands, swap this null for a per-cluster lookup
    // batched with the entity fanout below. UI falls back to `cluster-<id>`.
    name: null,
    size: typeof raw.size === "number" ? raw.size : 0,
    threshold: typeof raw.threshold === "number" ? raw.threshold : 0,
    health: normaliseHealth(raw.aggregateHealth),
    regions: Array.isArray(raw.regionDiversity) ? raw.regionDiversity.slice() : [],
    active: raw.active === true,
    entity: entityByCluster.get(raw.clusterId) ?? null,
  };
}

/** Read the chain's cluster directory. Falls back to MOCK_CLUSTERS on any
 *  transport or shape error. */
export async function readClusterDirectory(
  page: number,
  limit: number,
): Promise<StakingResult<ClusterDirectoryPage>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawClusterDirectoryPage>(
      "lyth_clusters",
      [page, limit],
    );
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray(result.clusters)
    ) {
      return { ok: false, reason: "malformed lyth_clusters response" };
    }
    // Best-effort: fan out per-cluster `lyth_getClusterEntity` so each row
    // carries its Foundation / community badge. Failures are silent —
    // entity flag goes null rather than fail-the-whole-directory.
    const entityByCluster = new Map<number, string>();
    await Promise.all(
      result.clusters
        .filter((c): c is RawClusterDirectoryEntry => typeof c?.clusterId === "number")
        .map(async (c) => {
          try {
            const { result: raw } = await sprintnetJsonRpc<RawClusterEntity>(
              "lyth_getClusterEntity",
              [c.clusterId!],
            );
            if (typeof raw?.entity === "string") {
              entityByCluster.set(c.clusterId!, raw.entity);
            }
          } catch {
            // entity lookup is best-effort
          }
        }),
    );
    const clusters = result.clusters
      .map((c) => normaliseDirectoryEntry(c, entityByCluster))
      .filter((c): c is ClusterDirectoryEntry => c !== null);
    return {
      ok: true,
      via,
      data: {
        page: typeof result.page === "number" ? result.page : page,
        limit: typeof result.limit === "number" ? result.limit : limit,
        totalClusters:
          typeof result.totalClusters === "number"
            ? result.totalClusters
            : clusters.length,
        clusters,
      },
    };
  } catch (e) {
    // Sprintnet-offline fallback. Pre-mainnet posture: the UI renders
    // the realistic architecture rather than empty state.
    const _reason = (e as Error)?.message ?? "lyth_clusters unreachable";
    void _reason;
    return {
      ok: true,
      via: "mock",
      data: {
        page,
        limit,
        totalClusters: MOCK_CLUSTERS.length,
        clusters: MOCK_CLUSTERS.slice(),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster status
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: ClusterMemberResponse + ClusterStatusResponse.
// Wire form: bigints are serialised as `string | number` over JSON-RPC;
// the SDK normalises to `bigint`. The wallet stringifies back for IPC
// transparency (popup never sees a bigint). Optional everywhere defends
// against malformed operator responses.
interface RawClusterMember {
  operatorId?: string;
  blsPubkey?: string;
  state?: string;
}

interface RawClusterStatus {
  clusterId?: number;
  threshold?: number;
  size?: number;
  live?: number;
  lagging?: number;
  offline?: number;
  maintenance?: number;
  members?: ReadonlyArray<RawClusterMember>;
  epoch?: string | number | bigint | null;
  round?: string | number | bigint | null;
  quorum?: string;
  reputationScore?: number | null;
  livenessScore?: number | null;
  lastUpdateHeight?: string | number | bigint;
}

function normaliseMember(raw: RawClusterMember): ClusterMember | null {
  if (
    typeof raw.operatorId !== "string" ||
    typeof raw.blsPubkey !== "string" ||
    typeof raw.state !== "string"
  ) {
    return null;
  }
  return {
    operatorId: raw.operatorId,
    blsPubkey: raw.blsPubkey,
    state: raw.state,
  };
}

/** Read the canonical cluster status envelope. */
export async function readClusterStatus(
  clusterId: number,
): Promise<StakingResult<ClusterStatus>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawClusterStatus>(
      "lyth_clusterStatus",
      [clusterId],
    );
    if (!result || typeof result !== "object" || typeof result.clusterId !== "number") {
      return { ok: false, reason: "malformed lyth_clusterStatus response" };
    }
    const members = Array.isArray(result.members)
      ? result.members
          .map(normaliseMember)
          .filter((m): m is ClusterMember => m !== null)
      : [];
    return {
      ok: true,
      via,
      data: {
        clusterId: result.clusterId,
        threshold: result.threshold ?? 7,
        size: result.size ?? 10,
        live: result.live ?? 0,
        lagging: result.lagging ?? 0,
        offline: result.offline ?? 0,
        maintenance: result.maintenance ?? 0,
        members,
        epoch:
          result.epoch === null || result.epoch === undefined
            ? null
            : String(result.epoch),
        round:
          result.round === null || result.round === undefined
            ? null
            : String(result.round),
        quorum: result.quorum ?? `${result.threshold ?? 7}-of-${result.size ?? 10}`,
        reputationScore:
          typeof result.reputationScore === "number" ? result.reputationScore : null,
        livenessScore:
          typeof result.livenessScore === "number" ? result.livenessScore : null,
        lastUpdateHeight: String(result.lastUpdateHeight ?? 0),
      },
    };
  } catch (e) {
    const reason = (e as Error)?.message ?? "lyth_clusterStatus unreachable";
    return { ok: false, reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegations + cap
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: DelegationsResponse + DelegationRow (bindings, not top-
// level exported). Strict chain shape:
//   DelegationsResponse: { wallet, rows: DelegationRow[], totalBps, block }
//   DelegationRow:       { cluster, weightBps }
// `block` is an opaque block selector echoed by the node; the wallet
// doesn't surface it because the popup's chain-status banner already
// covers staleness.
interface RawDelegationsResponse {
  wallet?: string;
  rows?: ReadonlyArray<{ cluster?: number; weightBps?: number }>;
  totalBps?: number;
}

/** Read active delegations for a wallet. Falls back to an empty envelope
 *  on transport error — a wallet with no on-chain delegations is also
 *  empty, so the popup's render path doesn't differentiate. */
export async function readDelegations(
  wallet: string,
): Promise<StakingResult<DelegationsView>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawDelegationsResponse>(
      "lyth_getDelegations",
      [wallet],
    );
    if (!result || typeof result !== "object") {
      return { ok: false, reason: "malformed lyth_getDelegations response" };
    }
    const rows: DelegationRow[] = (Array.isArray(result.rows) ? result.rows : [])
      .filter(
        (r): r is { cluster: number; weightBps: number } =>
          typeof r?.cluster === "number" && typeof r?.weightBps === "number",
      )
      .map((r) => ({ cluster: r.cluster, weightBps: r.weightBps }));
    return {
      ok: true,
      via,
      data: {
        wallet: typeof result.wallet === "string" ? result.wallet : wallet,
        rows,
        totalBps: typeof result.totalBps === "number" ? result.totalBps : 0,
      },
    };
  } catch (e) {
    // Empty delegations is a legitimate read for an unstaked wallet —
    // the popup renders the empty-state CTA. Sprintnet-offline gets the
    // same shape; the user sees "no active delegations" + can still
    // drill into the cluster directory. Log so the SW dev-tools console
    // distinguishes "actually empty" from "chain offline".
    console.warn(
      "[staking-client] readDelegations: chain offline, returning empty —",
      (e as Error)?.message ?? e,
    );
    return {
      ok: true,
      via: "mock",
      data: { wallet, rows: [], totalBps: 0 },
    };
  }
}

// SDK contract: DelegationCapResponse (binding, not top-level exported).
// Strict shape: { capBps: u32, lastChangedAtHeight: bigint, blockNumber: bigint }.
// Wire form receives bigints as `string | number` over JSON; the wallet
// stringifies to preserve precision.
interface RawDelegationCap {
  capBps?: number;
  lastChangedAtHeight?: string | number | bigint;
}

/** Chain encodes "cap disabled" as `u32::MAX`. The wallet normalises that
 *  to `null` so the UI can branch cleanly on `capBps !== null`. */
const CHAIN_CAP_DISABLED = 0xffffffff;

/** Read the per-cluster delegation cap (§23.6). */
export async function readDelegationCap(): Promise<StakingResult<DelegationCap>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawDelegationCap>(
      "lyth_getDelegationCap",
      [],
    );
    if (!result || typeof result !== "object" || typeof result.capBps !== "number") {
      return { ok: false, reason: "malformed lyth_getDelegationCap response" };
    }
    return {
      ok: true,
      via,
      data: {
        capBps: result.capBps === CHAIN_CAP_DISABLED ? null : result.capBps,
        lastChangedAtHeight: String(result.lastChangedAtHeight ?? 0),
      },
    };
  } catch (e) {
    // Pre-mainnet posture: whitepaper §23.6 Phase 12 launch cap = 50%
    // (`5000` bps). Mocking this is the cleanest way to render the
    // stake form's cap-headroom badge during cluster-offline windows;
    // when Sprintnet returns, the chain value supersedes the mock. Log
    // so the SW dev-tools console distinguishes a real chain-side cap
    // from the §23.6 mock fallback.
    console.warn(
      "[staking-client] readDelegationCap: chain offline, returning §23.6 mock —",
      (e as Error)?.message ?? e,
    );
    return {
      ok: true,
      via: "mock",
      data: { capBps: 5000, lastChangedAtHeight: "0" },
    };
  }
}

// SDK contract: DelegationHistoryRecord[] (binding, not top-level exported).
// Strict shape:
//   { blockHeight: bigint, txIndex, logIndex, wallet, cluster,
//     toCluster: number | null, kind, weightBps, walletTotalBps: number | null }
// `lyth_getDelegationHistory` returns the array directly (no envelope).
interface RawDelegationHistoryRow {
  blockHeight?: string | number | bigint;
  txIndex?: number;
  logIndex?: number;
  wallet?: string;
  cluster?: number;
  toCluster?: number | null;
  kind?: string;
  weightBps?: number;
  walletTotalBps?: number | null;
}

function normaliseHistoryRow(
  raw: RawDelegationHistoryRow,
  walletFallback: string,
): DelegationHistoryRow | null {
  if (
    typeof raw.cluster !== "number" ||
    typeof raw.weightBps !== "number" ||
    typeof raw.kind !== "string"
  ) {
    return null;
  }
  return {
    blockHeight: String(raw.blockHeight ?? 0),
    txIndex: typeof raw.txIndex === "number" ? raw.txIndex : 0,
    logIndex: typeof raw.logIndex === "number" ? raw.logIndex : 0,
    wallet: typeof raw.wallet === "string" ? raw.wallet : walletFallback,
    cluster: raw.cluster,
    toCluster: typeof raw.toCluster === "number" ? raw.toCluster : null,
    kind: raw.kind,
    weightBps: raw.weightBps,
    walletTotalBps:
      typeof raw.walletTotalBps === "number" ? raw.walletTotalBps : null,
  };
}

/** Read the per-wallet delegation event timeline (§23.2 + §23.7).
 *
 *  Surfaces in the Delegations page as a "Recent activity" panel — a
 *  delegation-only view distinct from the wallet-wide activity feed
 *  (which merges transfers, swaps, and delegation events). Both
 *  pipelines call `lyth_getDelegationHistory`, but the lean reader here
 *  is cheaper for the Delegations page's per-mount fan-out.
 *
 *  Cluster-offline fallback returns an empty timeline with `via: "mock"`
 *  so the popup branches cleanly on staleness ("history may be stale —
 *  chain offline") without crashing the render.
 */
export async function readDelegationHistory(
  wallet: string,
  limit: number = 50,
  cursor?: string,
): Promise<StakingResult<DelegationHistoryView>> {
  try {
    const params: unknown[] =
      cursor === undefined ? [wallet, limit] : [wallet, limit, cursor];
    const { result, via } = await sprintnetJsonRpc<
      ReadonlyArray<RawDelegationHistoryRow>
    >("lyth_getDelegationHistory", params);
    if (!Array.isArray(result)) {
      return { ok: false, reason: "malformed lyth_getDelegationHistory response" };
    }
    const rows: DelegationHistoryRow[] = [];
    for (const r of result) {
      const row = normaliseHistoryRow(r, wallet);
      if (row !== null) rows.push(row);
    }
    return { ok: true, via, data: { wallet, rows } };
  } catch (e) {
    console.warn(
      "[staking-client] readDelegationHistory: chain offline, returning empty —",
      (e as Error)?.message ?? e,
    );
    return {
      ok: true,
      via: "mock",
      data: { wallet, rows: [] },
    };
  }
}

// SDK contract: ClusterDelegatorsResponse (binding, not top-level exported).
// Strict shape: { cluster: number, delegators: string[], count: number, block: unknown }.
// Wire form drops `block` (the wallet doesn't surface it; chain-status
// banner already covers staleness).
interface RawClusterDelegators {
  cluster?: number;
  delegators?: ReadonlyArray<string>;
  count?: number;
}

/** Read the delegator address list for a single cluster (§23.6 cap
 *  context, §14 community-cluster surface).
 *
 *  Surfaces on the cluster-detail expand panel as "n wallets delegate
 *  here" so the user can see the cluster's demand profile when picking
 *  a target. Addresses themselves are not labeled / linkable today —
 *  the figure is the headline value.
 *
 *  Cluster-offline fallback returns `{ delegators: [], count: 0 }` so
 *  the popup renders a `—` placeholder rather than crashing. */
export async function readClusterDelegators(
  clusterId: number,
): Promise<StakingResult<ClusterDelegatorsView>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawClusterDelegators>(
      "lyth_getClusterDelegators",
      [clusterId],
    );
    if (!result || typeof result !== "object" || typeof result.cluster !== "number") {
      return {
        ok: false,
        reason: "malformed lyth_getClusterDelegators response",
      };
    }
    const delegators = Array.isArray(result.delegators)
      ? result.delegators.filter((d): d is string => typeof d === "string")
      : [];
    return {
      ok: true,
      via,
      data: {
        cluster: result.cluster,
        delegators,
        count:
          typeof result.count === "number" ? result.count : delegators.length,
      },
    };
  } catch (e) {
    console.warn(
      "[staking-client] readClusterDelegators: chain offline, returning empty —",
      (e as Error)?.message ?? e,
    );
    return {
      ok: true,
      via: "mock",
      data: { cluster: clusterId, delegators: [], count: 0 },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewards + redemption queue
// ─────────────────────────────────────────────────────────────────────────────

const BPS_DENOMINATOR = 10_000n;
const MOCK_REWARD_PRINCIPAL_LYTHOSHI = 100n * LYTHOSHI_PER_LYTH;
const MOCK_REWARD_INTERVALS_PER_DAY = 288n;
const MOCK_REWARD_DAYS_PER_YEAR = 365n;

function mockPendingRewardLythoshi(weightBps: number, aprBps: number): bigint {
  return (
    MOCK_REWARD_PRINCIPAL_LYTHOSHI *
    BigInt(weightBps) *
    BigInt(aprBps)
  ) / (
    BPS_DENOMINATOR *
    BPS_DENOMINATOR *
    MOCK_REWARD_DAYS_PER_YEAR *
    MOCK_REWARD_INTERVALS_PER_DAY
  );
}

// Direct RPC contract: `lyth_pendingRewards(wallet)` returns a pending-
// rewards snapshot with canonical lythoshi quantities. The SDK may lag
// the chain binding here, so the wallet calls JSON-RPC directly and
// validates the wire shape locally.
interface RawPendingRewardsResponse {
  wallet?: unknown;
  totalAmountLythoshi?: unknown;
  settledPendingLythoshi?: unknown;
  unsettledAmountLythoshi?: unknown;
  autoCompound?: unknown;
  rows?: unknown;
  block?: unknown;
}

interface RawPendingRewardsRow {
  cluster?: unknown;
  weightBps?: unknown;
  unsettledAmountLythoshi?: unknown;
}

function parseNonNegativeIntegerQuantity(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw >= 0n ? raw : null;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(s) || /^[0-9]+$/.test(s)) {
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function lythoshiHex(amount: bigint): string {
  return "0x" + amount.toString(16);
}

function normalisePendingRewardsRow(raw: unknown): PendingRewardsRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as RawPendingRewardsRow;
  const amount = parseNonNegativeIntegerQuantity(row.unsettledAmountLythoshi);
  if (
    typeof row.cluster !== "number" ||
    !Number.isSafeInteger(row.cluster) ||
    row.cluster < 0 ||
    typeof row.weightBps !== "number" ||
    !Number.isSafeInteger(row.weightBps) ||
    row.weightBps < 0 ||
    row.weightBps > 10_000 ||
    amount === null
  ) {
    return null;
  }
  return {
    cluster: row.cluster,
    weightBps: row.weightBps,
    unsettledAmountLythoshi: amount.toString(10),
    amountWei: lythoshiHex(amount),
    effectiveAprBps: null,
  };
}

function isPendingRewardsUnavailableError(e: unknown): boolean {
  const err = e as Partial<Error> & {
    code?: unknown;
    via?: unknown;
    method?: unknown;
  };
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  const hasAbsenceMessage =
    message.includes("method not found") ||
    message.includes("unknown method") ||
    message.includes("unsupported method") ||
    message.includes("not implemented") ||
    message.includes("no such method");
  if (typeof err.code === "number") return err.code === -32601 || hasAbsenceMessage;
  if (hasAbsenceMessage) return true;
  const isRpcError =
    typeof err.via === "string" || err.method === "lyth_pendingRewards";
  return !isRpcError;
}

function mockPendingRewardsView(
  wallet: string,
  delegations: ReadonlyArray<DelegationRow>,
): PendingRewardsView {
  let totalLythoshi = 0n;
  const rows: PendingRewardsRow[] = [];
  for (const d of delegations) {
    const aprBps = MOCK_CLUSTER_APR_BPS[d.cluster] ?? null;
    if (aprBps === null) {
      rows.push({
        cluster: d.cluster,
        weightBps: d.weightBps,
        unsettledAmountLythoshi: "0",
        amountWei: "0x0",
        effectiveAprBps: null,
      });
      continue;
    }
    const rewardLythoshi = mockPendingRewardLythoshi(d.weightBps, aprBps);
    totalLythoshi += rewardLythoshi;
    rows.push({
      cluster: d.cluster,
      weightBps: d.weightBps,
      unsettledAmountLythoshi: rewardLythoshi.toString(10),
      amountWei: lythoshiHex(rewardLythoshi),
      effectiveAprBps: aprBps,
    });
  }

  return {
    wallet,
    totalAmountLythoshi: totalLythoshi.toString(10),
    settledPendingLythoshi: "0",
    unsettledAmountLythoshi: totalLythoshi.toString(10),
    autoCompound: false,
    totalAmountWei: lythoshiHex(totalLythoshi),
    rows,
    blockHeight: null,
  };
}

/** Per-account pending rewards. The wallet calls the chain's
 *  `lyth_pendingRewards(wallet)` first and preserves the RPC `via` on a
 *  successful parse. If the method is absent on the contacted operator or
 *  Sprintnet is unreachable, it falls back to the old render-shape mock
 *  derived from active delegations + MOCK_CLUSTER_APR_BPS.
 *
 *  Mock derivation: for each active delegation row, the wallet computes
 *  a small fake reward in lythoshi (8-decimal native LYTH) proportional to
 *  a 100 LYTH notional principal × delegation weight × APR / 365 / 288 —
 *  i.e. "as if 5 minutes of accrual at the cluster's nominal APR." */
export async function readPendingRewards(
  wallet: string,
  delegations: ReadonlyArray<DelegationRow>,
): Promise<StakingResult<PendingRewardsView>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawPendingRewardsResponse>(
      "lyth_pendingRewards",
      [wallet],
    );
    if (!result || typeof result !== "object") {
      return { ok: false, reason: "malformed lyth_pendingRewards response" };
    }
    const raw = result as RawPendingRewardsResponse;
    const totalAmount = parseNonNegativeIntegerQuantity(raw.totalAmountLythoshi);
    const settledAmount = parseNonNegativeIntegerQuantity(raw.settledPendingLythoshi);
    const unsettledAmount = parseNonNegativeIntegerQuantity(
      raw.unsettledAmountLythoshi,
    );
    const block = parseNonNegativeIntegerQuantity(raw.block);
    if (
      typeof raw.wallet !== "string" ||
      typeof raw.autoCompound !== "boolean" ||
      !Array.isArray(raw.rows) ||
      totalAmount === null ||
      settledAmount === null ||
      unsettledAmount === null ||
      block === null
    ) {
      return { ok: false, reason: "malformed lyth_pendingRewards response" };
    }

    const rows: PendingRewardsRow[] = [];
    for (const rawRow of raw.rows) {
      const row = normalisePendingRewardsRow(rawRow);
      if (row === null) {
        return { ok: false, reason: "malformed lyth_pendingRewards response" };
      }
      rows.push(row);
    }

    return {
      ok: true,
      via,
      data: {
        wallet: raw.wallet,
        totalAmountLythoshi: totalAmount.toString(10),
        settledPendingLythoshi: settledAmount.toString(10),
        unsettledAmountLythoshi: unsettledAmount.toString(10),
        autoCompound: raw.autoCompound,
        totalAmountWei: lythoshiHex(totalAmount),
        rows,
        blockHeight: block.toString(10),
      },
    };
  } catch (e) {
    if (isPendingRewardsUnavailableError(e)) {
      return {
        ok: true,
        via: "mock",
        data: mockPendingRewardsView(wallet, delegations),
      };
    }
    const reason = (e as Error)?.message ?? "lyth_pendingRewards failed";
    return { ok: false, reason };
  }
}

/** Redemption queue. Per whitepaper §23.2 ("zero unbonding period"),
 *  there is no redemption delay for delegators — direct unstake clears
 *  instantly. The shape exists to cover any future chain-side change to
 *  that policy (which would be a constitutional-layer hard fork per
 *  §30.6 and is therefore unlikely pre-mainnet). For now we return an
 *  empty queue. */
export async function readRedemptionQueue(
  wallet: string,
): Promise<StakingResult<RedemptionQueueView>> {
  // TODO: chain GAP — needs Nayiem
  // ────────────────────────────────
  // No `lyth_redemptionQueue` reader exists in the SDK. Per §23.2 the
  // queue is vestigial; the wallet returns an empty envelope rather
  // than failing the UI render.
  return {
    ok: true,
    via: "mock",
    data: { wallet, rows: [] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers re-exported for service-worker.ts test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Mock reputation table — exposed so the SW IPC handlers can stitch a
 *  per-cluster reputation hint into the directory response when the
 *  chain doesn't surface one. */
export { MOCK_CLUSTER_APR_BPS, MOCK_CLUSTER_REPUTATION };
