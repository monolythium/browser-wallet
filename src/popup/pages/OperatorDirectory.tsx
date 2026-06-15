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
import { Modal } from "../components/Modal";
import { useFeature } from "../hooks/useFeature";
import {
  bgOperatorsHealth,
  bgOperatorsGet,
  bgOperatorsSet,
  bgProbeOperator,
  type OperatorHealthRow,
} from "../bg";
import {
  classifyOperatorRisk,
  operatorConnectBlockReason,
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

// Upper bound on the operator-health probe. The SW probe is parallel +
// timeout-bounded now, so this rarely fires — but a wedged SW used to leave
// this page stuck on "Probing…" forever; the deadline forces a definite state.
const OPERATOR_PROBE_TIMEOUT_MS = 6_000;

export function OperatorDirectory({
  onBack,
  onManageOperators,
}: OperatorDirectoryProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  // null = still probing; [] = probed, none configured.
  const [operators, setOperators] = useState<OperatorHealthRow[] | null>(null);
  // Single-open accordion. Starts closed so the page opens on the four
  // buttons (per the requested layout).
  const [open, setOpen] = useState<OpenSection>(null);
  // true when the probe didn't resolve (timeout/throw) — distinguishes
  // "couldn't reach the wallet service" from a genuine "no operators".
  const [probeError, setProbeError] = useState(false);

  // The operator a prior "Use this operator" pinned to the FRONT of the
  // override (null = automatic across all operators). Drives the "In use" mark.
  const [activeRpc, setActiveRpc] = useState<string | null>(null);
  // The rpc currently being switched to (button spinner) + any switch error.
  const [usingRpc, setUsingRpc] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  // B (dev connect-flow): the operator awaiting a "Connect?" confirm, plus a
  // success banner after a clean switch.
  const [pendingUse, setPendingUse] = useState<OperatorHealthRow | null>(null);
  const [useSuccess, setUseSuccess] = useState<string | null>(null);
  // Bumped after a switch / reset to re-probe health + re-read the override.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Bounded probe: a non-resolving bgOperatorsHealth() (a wedged SW) must not
    // strand the page on "Probing…" forever — fall to a definite state.
    const timer = setTimeout(() => {
      if (cancelled) return;
      setProbeError(true);
      setOperators([]);
    }, OPERATOR_PROBE_TIMEOUT_MS);
    void (async () => {
      try {
        const [health, ov] = await Promise.all([
          bgOperatorsHealth(),
          bgOperatorsGet().catch(() => null),
        ]);
        if (cancelled) return;
        clearTimeout(timer);
        setProbeError(false);
        setOperators(health.ok ? health.operators : []);
        setActiveRpc(ov && ov.ok ? (ov.override?.[0]?.rpc ?? null) : null);
      } catch {
        if (cancelled) return;
        clearTimeout(timer);
        setProbeError(true);
        setOperators([]);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reloadKey]);

  // "Use this operator": probe the choice first; only a reachable + genesis-
  // trusted operator is moved to the FRONT of the override (the rest stay as
  // fallback, so a later quarantine can't strand the wallet). Mirrors the
  // Operators editor's handler — same bgProbeOperator + bgOperatorsSet path.
  // B1: clicking "Use this operator" opens a confirm — the health/security
  // check + switch run only on Confirm (confirmUse).
  const handleUse = (op: OperatorHealthRow) => {
    if (usingRpc || operators === null) return;
    setUseError(null);
    setUseSuccess(null);
    setPendingUse(op);
  };

  const confirmUse = async (op: OperatorHealthRow) => {
    if (usingRpc || operators === null) return;
    setPendingUse(null);
    setUsingRpc(op.rpc);
    setUseError(null);
    setUseSuccess(null);
    try {
      // B3: block an err-severity operator (quarantined / untrusted-genesis /
      // transport-error) with the reason from the risk legend — never PIN a bad
      // operator. Dispatch re-verifies genesis on every call regardless; this
      // is the UI guard, not the security boundary.
      const block = operatorConnectBlockReason(toRiskInput(op));
      if (block) {
        setUseError(
          `Can't connect to ${op.name} — ${block} Left your operator unchanged.`,
        );
        return;
      }
      // B2: fresh reachability + genesis check.
      const probe = await bgProbeOperator(op.rpc);
      if (!probe.ok || !probe.usable) {
        setUseError(
          `Couldn't switch to ${op.name} — it's unreachable or on a different chain. Left your operator unchanged.`,
        );
        return;
      }
      const reordered = [op, ...operators.filter((o) => o.rpc !== op.rpc)];
      const wire = reordered.map((o) => ({
        name: o.name,
        region: o.region,
        rpc: o.rpc,
      }));
      const r = await bgOperatorsSet(wire);
      if (!r.ok) {
        setUseError(r.reason ?? "Couldn't save the operator choice.");
        return;
      }
      // B4: success feedback.
      setUseSuccess(`Connected to ${op.name}.`);
      setReloadKey((k) => k + 1);
    } finally {
      setUsingRpc(null);
    }
  };

  // Revert to automatic round-robin across all published operators.
  const handleAuto = async () => {
    if (usingRpc) return;
    setUseError(null);
    await bgOperatorsSet(null);
    setReloadKey((k) => k + 1);
  };

  const total = operators?.length ?? 0;
  const live = operators?.filter((o) => o.ok).length ?? 0;
  const trusted = operators?.filter((o) => o.trustedGenesis).length ?? 0;

  // Best-first ordering for the picker: healthy + genesis-trusted operators
  // by latency (fastest first), then everything degraded (untrusted / offline /
  // quarantined) after them. Pure display — RPC dispatch order is unchanged.
  const sortedOperators = useMemo(() => {
    if (operators === null) return null;
    const rank = (o: OperatorHealthRow) => (o.ok && o.trustedGenesis ? 0 : 1);
    const lat = (o: OperatorHealthRow) =>
      o.ok ? o.latencyMs : Number.POSITIVE_INFINITY;
    return [...operators].sort((a, b) => rank(a) - rank(b) || lat(a) - lat(b));
  }, [operators]);

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
            : probeError
              ? "Couldn't reach the wallet service — try reopening the wallet."
              : `${total} operator${total === 1 ? "" : "s"} · ${live} reachable · ${trusted} verified`}
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 10.5,
                  color: "var(--fg-400)",
                  padding: "0 2px 2px",
                }}
              >
                <span>
                  {activeRpc === null
                    ? "Automatic — fastest verified operator"
                    : "Pinned to your chosen operator"}
                </span>
                {activeRpc !== null && (
                  <button
                    type="button"
                    onClick={handleAuto}
                    disabled={usingRpc !== null}
                    style={pickerResetBtn}
                  >
                    Use automatic
                  </button>
                )}
              </div>
              {useError && (
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--err)",
                    lineHeight: 1.4,
                    padding: "0 2px",
                  }}
                >
                  {useError}
                </div>
              )}
              {useSuccess && (
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--ok)",
                    lineHeight: 1.4,
                    padding: "0 2px",
                  }}
                >
                  {useSuccess}
                </div>
              )}
              {pendingUse && (
                <Modal
                  open
                  onClose={() => setPendingUse(null)}
                  title="Connect to this operator?"
                  showClose
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--fg-300)",
                      lineHeight: 1.5,
                    }}
                  >
                    You&apos;re{" "}
                    {activeRpc
                      ? "on another operator"
                      : "on automatic operator selection"}
                    . Connect to{" "}
                    <strong style={{ color: "var(--fg-100)" }}>
                      {pendingUse.name}
                    </strong>
                    ? The wallet runs a health &amp; security check first.
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button
                      type="button"
                      onClick={() => setPendingUse(null)}
                      style={pickerResetBtn}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmUse(pendingUse)}
                      style={pickerUseBtn}
                    >
                      Connect
                    </button>
                  </div>
                </Modal>
              )}
              {sortedOperators!.map((op) => (
                <OperatorAccordionRow
                  key={op.rpc}
                  op={op}
                  isActive={op.rpc === activeRpc}
                  using={usingRpc === op.rpc}
                  busy={usingRpc !== null}
                  onUse={() => handleUse(op)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* 2. Reported attributes — developer-only capability telemetry. */}
        {devMode && (
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
        )}

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
            {OPERATOR_RISK_LEGEND.filter(
              (entry) => devMode || !entry.devOnly,
            ).map((entry, i, visible) => (
              <LegendEntry
                key={entry.kind}
                label={entry.label}
                body={entry.body}
                affected={byRisk.get(entry.kind) ?? []}
                last={i === visible.length - 1}
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

const pickerUseBtn: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 7,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const pickerResetBtn: CSSProperties = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-sans)",
  fontSize: 10,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** A single operator row: summary line by default, expands to the operator's
 *  reported capability surfaces + genesis/probe detail. */
function OperatorAccordionRow({
  op,
  isActive,
  using,
  busy,
  onUse,
}: {
  op: OperatorHealthRow;
  isActive: boolean;
  using: boolean;
  busy: boolean;
  onUse: () => void;
}) {
  const devMode = useFeature("DEVELOPER_MODE");
  const [open, setOpen] = useState(false);
  const badges = classifyOperatorRisk(toRiskInput(op));
  const danger = !op.trustedGenesis || !op.ok;
  const host = op.rpc.replace(/^https?:\/\//, "");
  // Plain-language status shown to every user (the host/latency line below is
  // developer-only). Quarantined = the operator self-reported a checkpoint
  // state-root mismatch and refuses RPC, so it must not be chosen.
  const quarantined = op.quarantined || (!op.ok && /quarantin/i.test(op.reason));
  const status = op.ok
    ? op.quarantined
      ? { label: "Quarantined", color: "#d9a441" }
      : op.trustedGenesis
        ? { label: `Live · ${op.latencyMs} ms`, color: "var(--ok)" }
        : { label: "Untrusted", color: "var(--err)" }
    : quarantined
      ? { label: "Quarantined", color: "#d9a441" }
      : { label: "Offline", color: "var(--err)" };
  const canUse = op.ok && op.trustedGenesis && !isActive;
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
          {devMode && (
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
          )}
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            fontWeight: 600,
            color: status.color,
            letterSpacing: "0.02em",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: status.color,
            }}
          />
          {status.label}
        </span>
        {isActive ? (
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ok)" }}>
            ✓ In use
          </span>
        ) : canUse ? (
          <button
            type="button"
            onClick={onUse}
            disabled={busy}
            style={{ ...pickerUseBtn, opacity: busy ? 0.5 : 1 }}
          >
            {using ? "Switching…" : "Use this operator"}
          </button>
        ) : null}
      </div>
      {open && <OperatorDetail op={op} />}
    </div>
  );
}

/** Expanded panel: the operator's reported capability surfaces plus
 *  genesis/probe context. "What they reported" = the lyth_operatorCapabilities
 *  surfaces map (cluster_directory / cluster_status / indexer_history / …). */
function OperatorDetail({ op }: { op: OperatorHealthRow }) {
  const devMode = useFeature("DEVELOPER_MODE");
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
      {devMode && <DetailKv k="endpoint" v={<Mono>{op.rpc}</Mono>} />}
      <DetailKv
        k="Chain"
        title={devMode ? (op.observedGenesis ?? undefined) : undefined}
        v={
          op.trustedGenesis ? (
            <span style={{ color: "var(--ok)" }}>Verified</span>
          ) : (
            <span style={{ color: "var(--err)" }}>
              Not verified — the wallet won&apos;t trust this operator
            </span>
          )
        }
      />
      {devMode &&
        (op.ok ? (
          <>
            <DetailKv k="chain id" v={<Mono>{op.chainIdDec ?? "—"}</Mono>} />
            <DetailKv k="latency" v={<Mono>{op.latencyMs}ms</Mono>} />
          </>
        ) : (
          <DetailKv
            k="probe"
            v={<span style={{ color: "var(--err)" }}>{op.reason}</span>}
          />
        ))}
      {devMode && (
        <>
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
        </>
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
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--fg-700)",
        background: "rgba(255,255,255,0.02)",
        marginBottom: last ? 0 : 6,
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
    quarantined: op.quarantined,
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
