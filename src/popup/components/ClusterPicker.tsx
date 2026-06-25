// ClusterPicker. Renders the cluster directory with the metadata a
// delegator needs to choose informed: APR, health, regions, member
// count, Foundation badge. APR is the real `lyth_clusterApr` value
// off `cluster.aprBps`; reputation renders "—" until the
// chain surfaces a per-cluster reputation reader — the
// wallet refuses to display synthesised values as chain truth (issue #1).
//
// Two interaction patterns:
//   - Tap a cluster row to select it (border flips to gold, calls
//     `onSelect(clusterId)` so the parent can advance to the form).
//   - Tap the chevron / "Details" affordance to expand the row in
//     place and surface the cap-headroom, threshold, region tags,
//     and the per-member operator state.
//
// Filters:
//   - Free-text search across cluster name + numeric id + region tags.
//   - Sort by APR (real lyth_clusterApr, default-yield) or
//     decentralization (geographic-diversity + entity-independence,
//     both chain-sourced). Reputation sort stays dropped (no reader).

import { useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { hoverBg } from "../hover";
import { type ClusterDirectoryEntry } from "../../shared/staking";

type SortMode = "apr" | "decentralization";

interface ClusterPickerProps {
  /** Full cluster list to render. Empty list shows the empty state. */
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  /** Currently-selected cluster id, or null when nothing is selected. */
  selectedClusterId: number | null;
  /** Called when a row is tapped — the parent advances to the stake-
   *  form step or, in autovote mode, records the toggle. */
  onSelect: (clusterId: number) => void;
  /** When supplied, the expanded row gets a
   *  "View details" link that navigates to the dedicated cluster-detail
   *  page. Optional so consumers that don't have a navigation surface
   *  (e.g. autovote picker, multisig flows) opt out cleanly. */
  onShowDetails?: (cluster: ClusterDirectoryEntry) => void;
}

/** Compute a coarse decentralization score for sort-by-decentralization.
 *  Higher = more decentralized. Weights three signals:
 *   - region count (Linux-style geographic spread)
 *   - inverse-reputation (penalise mega-clusters that already attract
 *     concentrated delegation — decentralization hint, not a reward signal)
 *   - independent-entity bonus over Foundation entities (§30.5
 *     sunset trajectory). */
function decentralizationScore(c: ClusterDirectoryEntry): number {
  // Reputation factor dropped — the chain doesn't yet expose a
  // per-cluster reputation primitive, and synthesising one would be
  // chain-truth dishonesty (issue #1). Score is region count + an
  // independent-entity bonus over Foundation entities; when reputation
  // lands as a real reader, fold it back in here.
  const regionCount = c.regions.length;
  const independenceBonus = c.entity === "mono-labs" ? 0 : 0.15;
  return regionCount * 1.0 + independenceBonus;
}

export function ClusterPicker({
  clusters,
  selectedClusterId,
  onSelect,
  onShowDetails,
}: ClusterPickerProps) {
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("apr");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? clusters.slice()
        : clusters.filter((c) => {
            if (String(c.clusterId).includes(q)) return true;
            if (c.name && c.name.toLowerCase().includes(q)) return true;
            for (const r of c.regions) {
              if (r.toLowerCase().includes(q)) return true;
            }
            return false;
          });
    return filtered.sort((a, b) => {
      // APR sort reads the real `lyth_clusterApr` value off
      // `cluster.aprBps`. Reputation sort stays dropped — no
      // chain per-cluster reputation reader yet.
      switch (sortMode) {
        case "apr": {
          const aa = a.aprBps ?? 0;
          const bb = b.aprBps ?? 0;
          return bb - aa;
        }
        case "decentralization": {
          return decentralizationScore(b) - decentralizationScore(a);
        }
      }
    });
  }, [clusters, search, sortMode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Search + sort */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Icon name="search" size={12} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clusters…"
            spellCheck={false}
            autoComplete="off"
            style={searchInputStyle}
          />
        </div>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          style={sortSelectStyle}
        >
          {/* APR sorts on the real lyth_clusterApr value.
              Reputation sort stays dropped — no chain reader. */}
          <option value="apr">APR</option>
          <option value="decentralization">Decentralization</option>
        </select>
      </div>

      {/* Cluster cards */}
      {visible.length === 0 ? (
        <div
          style={{
            padding: 18,
            textAlign: "center",
            fontSize: 11.5,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          No clusters match.
        </div>
      ) : (
        visible.map((c) => (
          <ClusterRow
            key={c.clusterId}
            cluster={c}
            selected={c.clusterId === selectedClusterId}
            expanded={c.clusterId === expandedId}
            onSelect={() => onSelect(c.clusterId)}
            onToggleExpand={() =>
              setExpandedId((prev) => (prev === c.clusterId ? null : c.clusterId))
            }
            {...(onShowDetails
              ? { onShowDetails: () => onShowDetails(c) }
              : {})}
          />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-row component
// ─────────────────────────────────────────────────────────────────────────────

interface ClusterRowProps {
  cluster: ClusterDirectoryEntry;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  /** Optional "View details →" link. When provided,
   *  the expanded row footer renders a button that calls this with the
   *  cluster row, surfacing the dedicated cluster-detail page. */
  onShowDetails?: () => void;
}

function ClusterRow({
  cluster,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
  onShowDetails,
}: ClusterRowProps) {
  // APR is the real chain value (`lyth_clusterApr` → `cluster.aprBps`);
  // `null` (failed/absent call) renders "—". Reputation stays
  // null ("—") — no per-cluster reputation reader yet; the
  // synthesised mock was dropped in v0.1.1 (issue #1).
  const aprBps = cluster.aprBps ?? null;
  const reputation: number | null = null;
  const isFoundation = cluster.entity === "mono-labs";

  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: selected
          ? "1px solid var(--gold)"
          : "1px solid var(--fg-700)",
        background: selected
          ? "var(--gold-bg)"
          : "rgba(255,255,255,0.03)",
        cursor: "pointer",
        transition: "all 100ms var(--e-out)",
      }}
      onClick={onSelect}
      onMouseEnter={(e) => {
        e.currentTarget.style.filter = "brightness(1.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
      }}
    >
      {/* Top row: name + health dot + APR */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <HealthDot health={cluster.health} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--fg-100)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span>{cluster.name ?? `cluster-${cluster.clusterId}`}</span>
            {isFoundation && <FoundationBadge />}
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.04em",
              marginTop: 2,
            }}
          >
            id #{cluster.clusterId} · {cluster.threshold}-of-{cluster.size}
            {cluster.regions.length > 0 && (
              <> · {cluster.regions.join(" / ")}</>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 13,
              fontWeight: 600,
              color: aprBps === null ? "var(--fg-500)" : "var(--ok)",
            }}
          >
            {aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`}
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 9,
              color: "var(--fg-500)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            APR
          </div>
        </div>
      </div>

      {/* Reputation + details toggle */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <ReputationBar score={reputation} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          style={detailsBtnStyle}
          {...hoverBg("transparent")}
        >
          {expanded ? "Hide" : "Details"}{" "}
          <Icon name={expanded ? "chev-d" : "chev"} size={10} />
        </button>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "rgba(0,0,0,0.25)",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.05)",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-300)",
            lineHeight: 1.7,
          }}
        >
          <KV k="Health" v={cluster.health} />
          <KV
            k="Quorum"
            v={`${cluster.threshold}-of-${cluster.size} (BFT 7-of-10)`}
          />
          <KV
            k="Regions"
            v={cluster.regions.length === 0 ? "—" : cluster.regions.join(", ")}
          />
          <KV
            k="Entity"
            v={
              cluster.entity ?? "unknown"
            }
          />
          <KV
            k="Reputation"
            v={
              reputation === null
                ? "not yet computed"
                : `${(reputation * 100).toFixed(1)}% aggregate`
            }
          />
          <div
            style={{
              marginTop: 6,
              fontSize: 9.5,
              color: "var(--fg-500)",
              lineHeight: 1.5,
            }}
          >
            Per-operator self-bond and cluster-level service-tier
            badges (RPC, Indexer, Archive, Oracle, Bridge) are
            rendered on the dedicated cluster-detail page — open via
            "View details" below.
          </div>
          {/* Link to dedicated cluster-detail page
              for the full operator slate, delegator demand, and your
              history with this cluster. */}
          {onShowDetails && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShowDetails();
              }}
              style={{
                marginTop: 8,
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: "0.04em",
                color: "var(--fg-200)",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid var(--fg-700)",
                padding: "4px 10px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "background 120ms",
              }}
              {...hoverBg("rgba(255,255,255,0.05)")}
              aria-label={`View details for ${cluster.name ?? `cluster-${cluster.clusterId}`}`}
            >
              View details →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function HealthDot({ health }: { health: ClusterDirectoryEntry["health"] }) {
  const color =
    health === "healthy"
      ? "var(--ok)"
      : health === "degraded"
        ? "var(--warn)"
        : health === "offline"
          ? "var(--err)"
          : "var(--fg-500)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
      aria-label={`health: ${health}`}
      title={`health: ${health}`}
    />
  );
}

function FoundationBadge() {
  return (
    <span
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 8.5,
        fontWeight: 600,
        padding: "1px 5px",
        borderRadius: 3,
        background: "rgba(var(--gold-glow), 0.12)",
        color: "var(--gold)",
        border: "1px solid rgba(var(--gold-glow), 0.4)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
      title="Foundation cluster — sunset trajectory; rewards burnt."
    >
      foundation
    </span>
  );
}

function ReputationBar({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
        }}
      >
        rep: —
      </span>
    );
  }
  const pct = Math.max(0, Math.min(1, score)) * 100;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}
      title={`Reputation ${(pct).toFixed(1)}%`}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          color: "var(--fg-400)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        rep
      </span>
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
          maxWidth: 120,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background:
              pct >= 75
                ? "var(--ok)"
                : pct >= 50
                  ? "var(--gold)"
                  : "var(--warn)",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-200)",
        }}
      >
        {pct.toFixed(0)}
      </span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "70px 1fr",
        gap: 8,
        alignItems: "baseline",
      }}
    >
      <span style={{ color: "var(--fg-500)" }}>{k}</span>
      <span style={{ color: "var(--fg-200)" }}>{v}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const searchInputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px 8px 26px",
  borderRadius: 8,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 11.5,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
};

const sortSelectStyle: CSSProperties = {
  padding: "8px 8px",
  borderRadius: 8,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 11,
  fontFamily: "var(--f-sans)",
  cursor: "pointer",
};

const detailsBtnStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-300)",
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  padding: "4px 8px",
  borderRadius: 6,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  flexShrink: 0,
  transition: "background 120ms",
};
