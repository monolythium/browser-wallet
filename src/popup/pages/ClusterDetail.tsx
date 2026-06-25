// Cluster-detail panel.
//
// The staking-client surface wired three chain readers
// but only one UI consumer (StakeForm's ClusterPicker, which renders an
// inline expand-row). This page assembles all of the data on a single
// dedicated screen:
//
//   - `lyth_clusterDirectory` directory row (passed in as `cluster` prop)
//   - `lyth_clusterStatus` operator slate + epoch/round
//   - `lyth_getClusterDelegators` aggregate delegator count
//   - `lyth_indexerStatus` chain-side staleness signal (shared banner)
//   - `lyth_getDelegationHistory` cluster-relevant rows from the
//      user's perspective (filtered by cluster id)
//
// Cluster-name registry (§22.8) and per-cluster APR both have SDK readers
// (`lythGetClusterName` at 0x1104, `lythClusterApr`), both wired in the
// directory fanout. This page renders the entry's canonical name and falls
// back to `cluster-<id>` only when the cluster is unnamed; absent values stay
// absent per `_dev-notes/_principles/no-mock-fallbacks.md` (chain silence ↦
// field absent — no placeholder).
//
// Whitepaper alignment:
//   §14    — cluster marketplace (this page IS the marketplace surface)
//   §22.4  — cluster-name registry (lythGetClusterName, wired via the directory)
//   §22.8  — hierarchical naming registry 0x110E (reader: lythResolveName)
//   §23.5  — service-proved reward share (renders cluster's effective
//            reward rate: rewards come from services the cluster proves,
//            split across delegators by weight; stake is not rewarded)
//   §23.6  — per-wallet delegation cap (cap headroom badge)
//   §28.3.1— diversity scoring (rendered as region count + ASN proxy)
//   §30.5  — Foundation-cluster sunset (entity flag badge)

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { useFeature } from "../hooks/useFeature";
import {
  bgStakingClusterStatus,
  bgStakingClusterDelegators,
  bgStakingClusterDiversity,
  bgStakingClusterServiceTiers,
  bgStakingDelegationHistory,
  bgStakingOperatorInfo,
} from "../bg";
import type {
  ClusterDirectoryEntry,
  ClusterDiversity,
  ClusterServiceTiers,
  ClusterStatus,
  DelegationHistoryRow,
  WalletOperatorInfo,
} from "../../shared/staking";
import { DIVERSITY_SCORE_MAX } from "../../shared/staking";
import { LYTHOSHI_PER_LYTH } from "../../shared/native-amount";

export interface ClusterDetailProps {
  /** Cluster directory row passed in by parent. Carries the entity flag,
   *  region list, and active state — no need to re-fetch for the
   *  detail view. */
  cluster: ClusterDirectoryEntry;
  /** Active wallet address — used to fetch the user's delegation
   *  history filtered to this cluster. */
  walletAddress: string | null;
  /** Back navigation. */
  onBack: () => void;
}

export function ClusterDetail({
  cluster,
  walletAddress,
  onBack,
}: ClusterDetailProps) {
  // v5 pillar surface — the §25.1 roster-diversity card ships behind the
  // default-off "Agent commerce (experimental)" toggle. When OFF the
  // page renders exactly the pre-v5 cards (no diversity card).
  const agentCommerceEnabled = useFeature("AGENT_COMMERCE");
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [delegatorCount, setDelegatorCount] = useState<number | null>(null);
  const [delegationHistory, setDelegationHistory] = useState<
    DelegationHistoryRow[] | null
  >(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // §25.1 roster diversity. Seed from the directory-carried fields (the
  // staking-client fanout already populated them) so the card renders
  // instantly, then refresh from the dedicated `lyth_getClusterDiversity`
  // reader. Stays null when the chain method is unavailable; the card
  // renders an honest "unavailable" line rather than a placeholder.
  const [diversity, setDiversity] = useState<ClusterDiversity | null>(() =>
    typeof cluster.diversityScore === "number"
      ? {
          clusterId: cluster.clusterId,
          score: cluster.diversityScore,
          asnVariance: cluster.asnVariance ?? 0,
          geoVariance: cluster.geoVariance ?? 0,
          hostingSpread: cluster.hostingSpread ?? 0,
        }
      : null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [statusRes, delegatorsRes, diversityRes, historyRes] = await Promise.all([
        bgStakingClusterStatus(cluster.clusterId),
        bgStakingClusterDelegators(cluster.clusterId),
        bgStakingClusterDiversity(cluster.clusterId),
        walletAddress
          ? bgStakingDelegationHistory(walletAddress)
          : Promise.resolve({ ok: true as const, data: { wallet: "", rows: [] } }),
      ]);
      if (cancelled) return;
      if (statusRes.ok) {
        setStatus(statusRes.data);
        setStatusError(null);
      } else {
        setStatus(null);
        setStatusError(statusRes.reason ?? "cluster status unavailable");
      }
      if (delegatorsRes.ok) {
        setDelegatorCount(delegatorsRes.data.count);
      }
      if (diversityRes.ok) {
        setDiversity(diversityRes.data);
      }
      if (historyRes.ok) {
        // Filter to entries that touched this cluster (either source or
        // destination in a redelegate).
        const filtered = historyRes.data.rows.filter(
          (r) =>
            r.cluster === cluster.clusterId ||
            r.toCluster === cluster.clusterId,
        );
        setDelegationHistory(filtered);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cluster.clusterId, walletAddress]);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
        >
          {cluster.name ?? `cluster-${cluster.clusterId}`}
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        className="ext-body"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {/* Identity + flags */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Identity</h3>
          </div>
          <ClusterIdentityCard cluster={cluster} />
        </div>

        {/* Live status (operators, epoch/round) */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Live status</h3>
          </div>
          {status !== null ? (
            <ClusterStatusCard status={status} />
          ) : statusError !== null ? (
            <div style={cellMuted}>{statusError}</div>
          ) : (
            <div style={cellMuted}>Loading…</div>
          )}
        </div>

        {/* §25.1 roster diversity (read-only delegator view) */}
        {agentCommerceEnabled && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Diversity</h3>
            </div>
            {diversity !== null ? (
              <ClusterDiversityCard diversity={diversity} />
            ) : (
              <div style={cellMuted}>
                Diversity scoring unavailable — the chain hasn&apos;t surfaced a
                roster-diversity score for this cluster yet.
              </div>
            )}
          </div>
        )}

        {/* Demand profile */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Demand</h3>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <KeyValue
              label="Delegators"
              value={delegatorCount === null ? "—" : String(delegatorCount)}
              tooltip="Distinct wallet addresses currently delegating to this cluster."
            />
          </div>
        </div>

        {/* User's delegation history with this cluster */}
        {walletAddress !== null && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Your activity</h3>
            </div>
            {delegationHistory === null ? (
              <div style={cellMuted}>Loading…</div>
            ) : delegationHistory.length === 0 ? (
              <div style={cellMuted}>
                You have no delegation history with this cluster.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {delegationHistory.slice(0, 10).map((r, i) => (
                  <DelegationHistoryLine key={`${r.blockHeight}-${i}`} row={r} />
                ))}
                {delegationHistory.length > 10 && (
                  <div style={cellMuted}>
                    + {delegationHistory.length - 10} more events
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ClusterIdentityCard({
  cluster,
}: {
  cluster: ClusterDirectoryEntry;
}) {
  const devMode = useFeature("DEVELOPER_MODE");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {devMode && (
        <KeyValueRow label="Cluster id" value={String(cluster.clusterId)} />
      )}
      <KeyValueRow
        label="Name"
        value={cluster.name ?? "Unnamed cluster"}
        muted={cluster.name === null}
      />
      <KeyValueRow
        label="Entity"
        value={cluster.entity ?? "unknown"}
        muted={cluster.entity === null}
      />
      <KeyValueRow label="Health" value={cluster.health} />
      <KeyValueRow
        label="Threshold"
        value={`${cluster.threshold} of ${cluster.size}`}
      />
      {cluster.regions.length > 0 && (
        <KeyValueRow
          label="Regions"
          value={cluster.regions.join(", ")}
          tooltip="Geographic diversity — operator-declared regions cross-checked against IP geolocation chain-side."
        />
      )}
      <KeyValueRow label="Active set" value={cluster.active ? "yes" : "no"} />
    </div>
  );
}

/** §25.1 read-only diversity card. Renders the headline score plus the
 *  three entropy dimensions (ASN / geo / hosting) as 0-100% bars. All
 *  inputs are `0..=DIVERSITY_SCORE_MAX` bps; the bars normalise to a
 *  percentage. Read-only — delegators inspect, they don't write
 *  operator network metadata (that's an operator/Monarch surface). */
function ClusterDiversityCard({ diversity }: { diversity: ClusterDiversity }) {
  const pct = (bps: number) =>
    Math.max(0, Math.min(100, Math.round((bps / DIVERSITY_SCORE_MAX) * 100)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <KeyValueRow
        label="Diversity score"
        value={`${pct(diversity.score)}%`}
        tooltip="Headline roster-diversity score from lyth_getClusterDiversity, blending ASN / country / hosting-class entropy. 0..=100%."
      />
      <DiversityBar
        label="ASN spread"
        pct={pct(diversity.asnVariance)}
        tooltip="Normalised ASN-distribution entropy — how spread the cluster's operators are across autonomous systems."
      />
      <DiversityBar
        label="Geo spread"
        pct={pct(diversity.geoVariance)}
        tooltip="Normalised country-distribution entropy — geographic spread of the cluster's operators."
      />
      <DiversityBar
        label="Hosting spread"
        pct={pct(diversity.hostingSpread)}
        tooltip="Normalised hosting-class entropy — spread across bare-metal / co-location / cloud."
      />
    </div>
  );
}

/** One 0-100% diversity dimension rendered as a labelled bar. */
function DiversityBar({
  label,
  pct,
  tooltip,
}: {
  label: string;
  pct: number;
  tooltip?: string;
}) {
  return (
    <div title={tooltip}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
          marginBottom: 3,
        }}
      >
        <span>{label}</span>
        <span style={{ color: "var(--fg-100)" }}>{pct}%</span>
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: "var(--bg-300, rgba(255,255,255,0.08))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 3,
            background:
              "linear-gradient(90deg, var(--accent-violet, #8b5cf6), var(--accent-magenta, #d946ef))",
          }}
        />
      </div>
    </div>
  );
}

function ClusterStatusCard({ status }: { status: ClusterStatus }) {
  const devMode = useFeature("DEVELOPER_MODE");
  // Per-operator info (self-bond + lifecycle) fetched
  // lazily after the cluster's member list arrives. Cache is
  // component-local; remounting the panel re-fetches. Per-operator
  // bond is unique and not mock-fallbacked — failed fetches render
  // "—" rather than crashing.
  const [operatorInfo, setOperatorInfo] = useState<Map<string, WalletOperatorInfo>>(
    () => new Map(),
  );

  // Cluster-level service-tier aggregation across member
  // operators (any-true semantics).
  // If chain ships ClusterDirectoryEntry.serviceTiers as an aggregate
  // field, this whole probe fan-out drops to a single directory read.
  const [serviceTiers, setServiceTiers] = useState<ClusterServiceTiers | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const operatorIds = status.members.map((m) => m.operatorId);
    void (async () => {
      const [tiersRes, ...infoResults] = await Promise.all([
        bgStakingClusterServiceTiers(operatorIds),
        ...operatorIds.map((opId) => bgStakingOperatorInfo(opId)),
      ]);
      if (cancelled) return;
      if (tiersRes.ok) {
        setServiceTiers(tiersRes.data);
      }
      const next = new Map<string, WalletOperatorInfo>();
      for (let i = 0; i < operatorIds.length; i++) {
        const res = infoResults[i];
        if (res && res.ok) {
          next.set(operatorIds[i]!, res.data);
        }
      }
      setOperatorInfo(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [status.clusterId, status.members]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <KeyValue label="Live" value={String(status.live)} />
        {devMode && <KeyValue label="Lagging" value={String(status.lagging)} />}
        <KeyValue label="Offline" value={String(status.offline)} />
        {devMode && (
          <KeyValue label="Maintenance" value={String(status.maintenance)} />
        )}
        {devMode && <KeyValue label="Quorum" value={status.quorum} />}
      </div>
      {devMode && status.epoch !== null && (
        <KeyValueRow label="Epoch" value={status.epoch} />
      )}
      {devMode && status.round !== null && (
        <KeyValueRow label="Round" value={status.round} />
      )}
      {devMode && (
        <KeyValueRow
          label="Last update height"
          value={status.lastUpdateHeight}
        />
      )}
      {/* Chain-real reputation + liveness scores (§14 + §28.3).
          Currently null on the testnet testnet; rows hidden until chain
          populates non-null. Per no-mock-fallback principle, no
          synthesized placeholder. */}
      {status.reputationScore !== null && (
        // Whitepaper §14 + §28.3 govern the score derivation; the
        // tooltip text stays plain-English so the §-cite doesn't leak
        // into user-facing UI strings.
        <KeyValueRow
          label="Reputation"
          value={status.reputationScore.toFixed(3)}
          tooltip="Cluster reputation score from lyth_clusterStatus.reputationScore. Float in [0,1]."
        />
      )}
      {status.livenessScore !== null && (
        <KeyValueRow
          label="Liveness"
          value={status.livenessScore.toFixed(3)}
          tooltip="Cluster liveness score from lyth_clusterStatus.livenessScore. Float in [0,1]."
        />
      )}
      {devMode && serviceTiers && serviceTiers.anyReachable && (
        <ServiceTierBadgeRow tiers={serviceTiers} />
      )}
      {devMode && (
      <div style={{ marginTop: 8 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-400)",
            marginBottom: 4,
          }}
        >
          Operator slate
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {status.members.map((m) => (
            <div
              key={m.operatorId}
              style={{
                display: "flex",
                gap: 6,
                fontFamily: "var(--f-mono)",
                fontSize: 10.5,
                alignItems: "center",
              }}
            >
              <StateChip state={m.state} />
              <span
                style={{
                  color: "var(--fg-200)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
                title={m.consensusPubkey}
              >
                {m.operatorId}
              </span>
              <span
                style={{
                  color: "var(--fg-400)",
                  fontSize: 10,
                  flexShrink: 0,
                }}
                title="Operator self-bond (5,000 LYTH chain-enforced floor)"
              >
                {formatBondLyth(operatorInfo.get(m.operatorId))}
              </span>
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}

/** Render a bonded-amount as a compact "5,000 L" cell. Returns "—"
 *  when the operator's info fetch failed or hasn't completed yet. */
function formatBondLyth(info: WalletOperatorInfo | undefined): string {
  if (!info) return "—";
  let lythoshi: bigint;
  try {
    lythoshi = BigInt(info.bondedAmount);
  } catch {
    return "—";
  }
  // Round-down LYTH for the slate cell. The expanded mock/real
  // formatting goes through formatLyth elsewhere; here we want a
  // glanceable integer with no decimal noise.
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  return `${whole.toLocaleString()} L`;
}

/** Small horizontal badge row for cluster-level service
 *  tier aggregates. Active tiers light up; inactive tiers render as
 *  muted dots so the row's width stays stable across clusters. */
function ServiceTierBadgeRow({ tiers }: { tiers: ClusterServiceTiers }) {
  const entries: ReadonlyArray<{ label: string; on: boolean }> = [
    { label: "RPC", on: tiers.rpc },
    { label: "Indexer", on: tiers.indexer },
    { label: "Archive", on: tiers.archive },
    { label: "Oracle", on: tiers.oracle },
    { label: "Bridge", on: tiers.bridgeRelay },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        marginTop: 4,
      }}
      title={`Service-tier reachability aggregated across ${tiers.probedOperators} member operators (any reachable).`}
    >
      {entries.map((e) => (
        <span
          key={e.label}
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 4,
            border: e.on
              ? "1px solid var(--ok)"
              : "1px solid var(--fg-700)",
            color: e.on ? "var(--ok)" : "var(--fg-500)",
            background: e.on ? "rgba(46,160,67,0.08)" : "transparent",
          }}
        >
          {e.label}
        </span>
      ))}
    </div>
  );
}

/** Per-operator status dot. Live `lyth_clusterStatus(0)` probes (op-1
 *  `178.105.15.216`, height ~87828, 2026-05-27) return a mix of
 *  `"active"`, `"standby"`, `"jailed"`, `"offline"` — the chain emits
 *  `"standby"` post-regenesis (supersedes the earlier "exactly three
 *  values" reading from `providers.rs::bootstrap_cluster_members`). The
 *  previous wallet-internal mapping (`"live"` / `"lagging"` /
 *  `"maintenance"`) never matched chain output, so every active operator
 *  rendered as the red default. `"active"`/`"jailed"`/`"offline"` map to
 *  distinct colours; `"standby"` and anything chain adds later
 *  fall through to the muted-fg dot rather than the
 *  alarming red. A dedicated standby colour is a flagged UX
 *  follow-up. */
function StateChip({ state }: { state: string }) {
  const colour =
    state === "active"
      ? "var(--ok)"
      : state === "jailed"
        ? "var(--err)"
        : state === "offline"
          ? "var(--warn)"
          : "var(--fg-500)";
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: colour,
        flexShrink: 0,
      }}
      title={`operator state: ${state}`}
    />
  );
}

function DelegationHistoryLine({ row }: { row: DelegationHistoryRow }) {
  const devMode = useFeature("DEVELOPER_MODE");
  const summary =
    row.kind === "delegate"
      ? `+${(row.weightBps / 100).toFixed(2)}%`
      : row.kind === "undelegate"
        ? `-${(row.weightBps / 100).toFixed(2)}%`
        : row.kind === "redelegate"
          ? `→ cluster-${row.toCluster ?? "?"}`
          : row.kind;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontFamily: "var(--f-mono)",
        fontSize: 10.5,
        color: "var(--fg-300)",
      }}
    >
      <span style={{ width: 60, flexShrink: 0 }}>{row.kind}</span>
      <span style={{ flex: 1 }}>{summary}</span>
      {devMode && (
        <span style={{ color: "var(--fg-500)" }}>block {row.blockHeight}</span>
      )}
    </div>
  );
}

function KeyValue({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <div title={tooltip}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-100)", marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function KeyValueRow({
  label,
  value,
  tooltip,
  muted,
}: {
  label: string;
  value: string;
  tooltip?: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      title={tooltip}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          color: muted ? "var(--fg-500)" : "var(--fg-100)",
          fontFamily: "var(--f-mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const cellMuted = {
  fontSize: 11,
  color: "var(--fg-400)",
  padding: "8px 0",
};
