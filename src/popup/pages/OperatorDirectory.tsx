// Operators directory — a dedicated, minimized operators surface reached
// from the hamburger menu. It collapses the verbose operator readout (which
// also lives on the About page) into four buttons:
//
//   1. Operators           — accordion list; each row expands to show the
//                            capability surfaces the operator reported
//                            (cluster_directory, cluster_status,
//                            indexer_history, …) via lyth_operatorCapabilities.
//   2. Reported attributes — aggregate "n/total operators serve surface X".
//   3. Risk legend         — the OPERATOR_RISK_LEGEND glossary; any risk that
//                            currently affects ≥1 operator shows a red count
//                            badge that expands to the affected operators.
//   4. Manage operators    — navigates to the RPC-override editor (the
//                            existing Operators page).
//
// All data comes from the existing bgOperatorsHealth() probe — no new IPC.
// Risk classification reuses shared/operator-risk.ts verbatim so this page
// and the About page stay in lock-step.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../Icon";
import { bgOperatorsHealth, type OperatorHealthRow } from "../bg";
import {
  classifyOperatorRisk,
  OPERATOR_RISK_LEGEND,
  type OperatorRiskBadge,
  type OperatorRiskInput,
  type OperatorRiskKind,
} from "../../shared/operator-risk";

interface OperatorDirectoryProps {
  onBack: () => void;
  /** Navigate to the existing operator RPC-override editor (Operators page). */
  onManageOperators: () => void;
}

type OpenSection = "list" | "attrs" | "legend" | null;

export function OperatorDirectory({
  onBack,
  onManageOperators,
}: OperatorDirectoryProps) {
  // null = still probing; [] = probed, none configured.
  const [operators, setOperators] = useState<OperatorHealthRow[] | null>(null);
  // Single-open accordion. Starts closed so the page opens on the four
  // buttons (per the requested layout).
  const [open, setOpen] = useState<OpenSection>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgOperatorsHealth();
      if (cancelled) return;
      setOperators(r.ok ? r.operators : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = operators?.length ?? 0;
  const live = operators?.filter((o) => o.ok).length ?? 0;
  const trusted = operators?.filter((o) => o.trustedGenesis).length ?? 0;

  // Group operators by the risk kinds they currently exhibit (drives the
  // per-legend-entry "N affected" badge + expandable list).
  const byRisk = useMemo(() => {
    const m = new Map<OperatorRiskKind, OperatorHealthRow[]>();
    for (const op of operators ?? []) {
      for (const badge of classifyOperatorRisk(toRiskInput(op))) {
        const arr = m.get(badge.kind) ?? [];
        arr.push(op);
        m.set(badge.kind, arr);
      }
    }
    return m;
  }, [operators]);

  const capSummary = useMemo(
    () => summariseCapabilities(operators ?? []),
    [operators],
  );

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Operators
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-400)",
            lineHeight: 1.5,
            marginBottom: 12,
          }}
        >
          {operators === null
            ? "Probing Monolythium Testnet operators…"
            : `${total} operator${total === 1 ? "" : "s"} · ${live} live · ${trusted} trusted genesis. Probed live from each round-trip.`}
        </div>

        {/* 1. Operator list */}
        <Section
          title="Operators"
          meta={operators === null ? "…" : String(total)}
          open={open === "list"}
          onToggle={() => setOpen((p) => (p === "list" ? null : "list"))}
        >
          {operators === null ? (
            <Muted>Probing…</Muted>
          ) : total === 0 ? (
            <Muted>No operators configured.</Muted>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {operators.map((op) => (
                <OperatorAccordionRow key={op.rpc} op={op} />
              ))}
            </div>
          )}
        </Section>

        {/* 2. Reported attributes */}
        <Section
          title="Reported attributes"
          meta={capSummary.length ? `${capSummary.length} surfaces` : undefined}
          open={open === "attrs"}
          onToggle={() => setOpen((p) => (p === "attrs" ? null : "attrs"))}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-400)",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            Capability surfaces operators report via{" "}
            <Mono>lyth_operatorCapabilities</Mono> — e.g. cluster_directory,
            cluster_status, indexer_history. The count is how many operators
            currently serve each surface.
          </div>
          {operators === null ? (
            <Muted>Probing…</Muted>
          ) : capSummary.length === 0 ? (
            <Muted>No operator reported capability surfaces.</Muted>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {capSummary.map((e, i) => (
                <div
                  key={e.surface}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    padding: "7px 0",
                    borderBottom:
                      i < capSummary.length - 1
                        ? "1px solid var(--fg-700)"
                        : "none",
                  }}
                >
                  <Mono>{e.surface}</Mono>
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 10,
                      color:
                        e.available === total && total > 0
                          ? "var(--ok)"
                          : e.available === 0
                            ? "var(--fg-500)"
                            : "var(--fg-300)",
                    }}
                  >
                    {e.available}/{total}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* 3. Risk legend */}
        <Section
          title="Risk legend"
          open={open === "legend"}
          onToggle={() => setOpen((p) => (p === "legend" ? null : "legend"))}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-400)",
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            Each chip on an operator row decodes a signal the wallet collected
            from its probe round-trip. Most are advisory — the wallet's RPC
            dispatcher already routes around offline / untrusted operators.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {OPERATOR_RISK_LEGEND.map((entry, i) => (
              <LegendEntry
                key={entry.kind}
                label={entry.label}
                body={entry.body}
                affected={byRisk.get(entry.kind) ?? []}
                last={i === OPERATOR_RISK_LEGEND.length - 1}
              />
            ))}
          </div>
        </Section>

        {/* 4. Manage operators -> the existing RPC-override editor */}
        <button type="button" onClick={onManageOperators} style={NAV_BTN}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="settings" size={14} />
            Manage operators
          </span>
          <Icon name="chev" size={12} />
        </button>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-500)",
            lineHeight: 1.5,
            marginTop: 6,
          }}
        >
          Override the operator RPC list with your own nodes.
        </div>
      </div>
    </>
  );
}

/** One of the four collapsible buttons. Closed by default; the chevron
 *  swaps right → down when open (same idiom as ClusterPicker). */
export function Section({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta?: string | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={sectionBtn(open)}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          {meta !== undefined && (
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
              }}
            >
              {meta}
            </span>
          )}
        </span>
        <Icon name={open ? "chev-d" : "chev"} size={13} />
      </button>
      {open && <div style={{ padding: "10px 12px 2px" }}>{children}</div>}
    </div>
  );
}

/** A single operator row: summary line by default, expands to the operator's
 *  reported capability surfaces + genesis/probe detail. */
function OperatorAccordionRow({ op }: { op: OperatorHealthRow }) {
  const [open, setOpen] = useState(false);
  const badges = classifyOperatorRisk(toRiskInput(op));
  const danger = !op.trustedGenesis || !op.ok;
  const host = op.rpc.replace(/^https?:\/\//, "");
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--fg-700)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "var(--fg-100)",
          fontFamily: "var(--f-sans)",
        }}
      >
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 0,
            flex: 1,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: danger ? "var(--err)" : "var(--ok)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 600 }}>{op.name}</span>
            <span style={{ fontSize: 10.5, color: "var(--fg-300)" }}>
              {op.region}
            </span>
          </span>
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10.5,
              color: "var(--fg-200)",
              wordBreak: "break-all",
            }}
          >
            {host}
            {op.ok && ` · ${op.latencyMs}ms`}
            {op.ok && op.blockHex && ` · #${parseHex(op.blockHex)}`}
            {op.indexerHeight !== null && ` · idx #${op.indexerHeight}`}
            {!op.ok && ` · ${op.reason}`}
          </span>
          {badges.length > 0 && (
            <span
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 2,
              }}
            >
              {badges.map((b) => (
                <RiskBadgeChip key={b.kind} badge={b} />
              ))}
            </span>
          )}
        </span>
        <span style={{ color: "var(--fg-400)", flexShrink: 0, marginTop: 2 }}>
          <Icon name={open ? "chev-d" : "chev"} size={12} />
        </span>
      </button>
      {open && <OperatorDetail op={op} />}
    </div>
  );
}

/** Expanded panel: the operator's reported capability surfaces plus
 *  genesis/probe context. "What they reported" = the lyth_operatorCapabilities
 *  surfaces map (cluster_directory / cluster_status / indexer_history / …). */
function OperatorDetail({ op }: { op: OperatorHealthRow }) {
  const surfaces = op.capabilities ? Object.entries(op.capabilities) : [];
  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "rgba(0,0,0,0.25)",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.05)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <DetailKv k="endpoint" v={<Mono>{op.rpc}</Mono>} />
      <DetailKv
        k="genesis"
        title={op.observedGenesis ?? undefined}
        v={
          op.trustedGenesis ? (
            <span style={{ color: "var(--ok)" }}>trusted ✓</span>
          ) : (
            <span style={{ color: "var(--err)" }}>untrusted</span>
          )
        }
      />
      {op.ok ? (
        <>
          <DetailKv k="chain id" v={<Mono>{op.chainIdDec ?? "—"}</Mono>} />
          <DetailKv k="latency" v={<Mono>{op.latencyMs}ms</Mono>} />
        </>
      ) : (
        <DetailKv
          k="probe"
          v={<span style={{ color: "var(--err)" }}>{op.reason}</span>}
        />
      )}
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          color: "var(--fg-400)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          marginTop: 2,
        }}
      >
        Reported surfaces
      </div>
      {surfaces.length === 0 ? (
        <Muted>
          Operator did not report capability surfaces (may be a pre-uplift
          binary).
        </Muted>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {surfaces.map(([surface, status]) => (
            <div
              key={surface}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                fontSize: 10.5,
              }}
            >
              <Mono>{surface}</Mono>
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9.5,
                  color: status === "available" ? "var(--ok)" : "var(--fg-400)",
                }}
              >
                {status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A risk-legend row. When operators currently exhibit this risk, a red
 *  "N affected" badge expands to list them. */
function LegendEntry({
  label,
  body,
  affected,
  last,
}: {
  label: string;
  body: string;
  affected: OperatorHealthRow[];
  last?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasAffected = affected.length > 0;
  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: last ? "none" : "1px solid var(--fg-700)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{ fontSize: 11.5, fontWeight: 600, color: "var(--fg-100)" }}
        >
          {label}
        </div>
        {hasAffected && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={`${affected.length} operator${affected.length === 1 ? "" : "s"} affected`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(220,80,80,0.12)",
              border: "1px solid rgba(220,80,80,0.4)",
              borderRadius: 4,
              padding: "1px 5px",
              cursor: "pointer",
              color: "var(--err)",
              fontFamily: "var(--f-mono)",
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.06em",
              flexShrink: 0,
            }}
          >
            {affected.length} affected
            <Icon name={open ? "chev-d" : "chev"} size={9} />
          </button>
        )}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-300)",
          lineHeight: 1.5,
          marginTop: 2,
        }}
      >
        {body}
      </div>
      {hasAffected && open && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "rgba(220,80,80,0.06)",
            border: "1px solid rgba(220,80,80,0.2)",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {affected.map((op) => (
            <div
              key={op.rpc}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                fontSize: 10.5,
              }}
            >
              <span style={{ fontWeight: 600 }}>{op.name}</span>
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9,
                  color: "var(--fg-400)",
                }}
              >
                {op.region} · {op.rpc.replace(/^https?:\/\//, "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Coloured risk chip with a hover tooltip. Mirrors the About-page chip so
 *  the two surfaces decode identically (severity → colour). */
function RiskBadgeChip({ badge }: { badge: OperatorRiskBadge }) {
  const colour =
    badge.severity === "err"
      ? "var(--err)"
      : badge.severity === "warn"
        ? "var(--warn)"
        : "var(--fg-300)";
  const bg =
    badge.severity === "err"
      ? "rgba(220,80,80,0.12)"
      : badge.severity === "warn"
        ? "rgba(220,180,80,0.12)"
        : "rgba(120,160,220,0.08)";
  const borderColour =
    badge.severity === "err"
      ? "rgba(220,80,80,0.4)"
      : badge.severity === "warn"
        ? "rgba(220,180,80,0.4)"
        : "rgba(120,160,220,0.3)";
  return (
    <span
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: colour,
        background: bg,
        border: `1px solid ${borderColour}`,
        padding: "1px 5px",
        borderRadius: 3,
      }}
      title={badge.tooltip}
    >
      {badge.label}
    </span>
  );
}

function DetailKv({
  k,
  v,
  title,
}: {
  k: string;
  v: ReactNode;
  title?: string | undefined;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 11,
      }}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-400)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {k}
      </span>
      <span
        style={{ color: "var(--fg-100)", wordBreak: "break-all", textAlign: "right" }}
        title={title}
      >
        {v}
      </span>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>{children}</span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--fg-400)", lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

/** Map an OperatorHealthRow into the dependency-free classifier input.
 *  Mirrors the mapping the About page does. pendingChange stays null until
 *  the SDK exposes the chain pending-change reader. */
function toRiskInput(op: OperatorHealthRow): OperatorRiskInput {
  return {
    ok: op.ok,
    trustedGenesis: op.trustedGenesis,
    capabilities: op.capabilities,
    indexerHeight: op.indexerHeight,
    indexerLatest: op.indexerLatest,
    latencyMs: op.ok ? op.latencyMs : null,
    pendingChange: null,
  };
}

function parseHex(hex: string): string {
  try {
    return BigInt(hex).toString();
  } catch {
    return "?";
  }
}

interface CapEntry {
  surface: string;
  available: number;
}

/** Reduce per-operator capability maps to "n operators serve surface X".
 *  Only surfaces seen on at least one operator are counted (pre-uplift
 *  operators contribute nothing rather than dragging the denominator). */
function summariseCapabilities(
  operators: ReadonlyArray<OperatorHealthRow>,
): CapEntry[] {
  const counts = new Map<string, number>();
  for (const op of operators) {
    if (op.capabilities === null) continue;
    for (const [surface, status] of Object.entries(op.capabilities)) {
      if (status === "available") {
        counts.set(surface, (counts.get(surface) ?? 0) + 1);
      } else if (!counts.has(surface)) {
        counts.set(surface, 0);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([surface, available]) => ({ surface, available }))
    .sort(
      (a, b) =>
        b.available - a.available || a.surface.localeCompare(b.surface),
    );
}

const sectionBtn = (open: boolean): CSSProperties => ({
  width: "100%",
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid var(--fg-700)",
  background: open ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
});

const NAV_BTN: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
