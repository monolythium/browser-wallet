// Operators — the testnet operator override management.
//
// The testnet is a single chain with multiple operator RPC endpoints. Power
// users can override the published 7-operator default list with their
// own operator URLs, or pin a single operator to bypass round-robin.
//
// Storage flow: edits are local until [Save] writes via bgOperatorsSet.
// The SW's chrome.storage.onChanged listener invalidates the operator-
// probe cache so the next chain-health tick (~8s) picks up the new list
// without a popup or SW restart.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import { useFeature } from "../hooks/useFeature";
import {
  bgChainOperatorRisk,
  bgChainSigningActivity,
  bgChainUpcomingDuties,
  bgOperatorsGet,
  bgOperatorsSet,
  type ChainOperatorRiskOutcome,
  type ChainSigningActivityOutcome,
  type ChainUpcomingDutiesOutcome,
  type OperatorEntryWire,
} from "../bg";
import {
  deriveOperatorRiskTier,
  isJailStatusAvailable,
  isKeyRotationAvailable,
  summarizeSigningActivity,
  type OperatorRiskTier,
  type OperatorRiskWire,
  type OperatorSigningActivity,
  type SigningEntryStatus,
  type UpcomingDuties,
} from "../../shared/audit-followup-types";

interface OperatorsProps {
  onBack: () => void;
  /** Opens Settings / About — surfaced as buttons on the dev-mode-required
   *  stub so the user can reach the developer-mode toggle. */
  onOpenSettings?: () => void;
  onOpenAbout?: () => void;
}

// Gold-accent pill with a ↗ affordance, used on the dev-mode-required stub
// to send the user to the pages that host the developer-mode toggle.
const devModeNavBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg, rgba(212,160,60,0.12))",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

interface DraftOperator extends OperatorEntryWire {
  /** Local row id so React keys stay stable across moves/edits even when
   *  the user has two rows with the same name (e.g. duplicates during
   *  paste-then-edit). */
  rid: string;
}

let RID_COUNTER = 0;
const newRid = () => `op-${RID_COUNTER++}`;

export function Operators({
  onBack,
  onOpenSettings,
  onOpenAbout,
}: OperatorsProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  const [defaults, setDefaults] = useState<OperatorEntryWire[]>([]);
  const [originalOverride, setOriginalOverride] = useState<OperatorEntryWire[] | null>(null);
  const [draft, setDraft] = useState<DraftOperator[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const r = await bgOperatorsGet();
    setDefaults(r.defaults);
    setOriginalOverride(r.override);
    setDraft(
      r.effective.map((e) => ({ ...e, rid: newRid() })),
    );
    setLoaded(true);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const overrideActive = originalOverride !== null;
  const dirty = !sameOperators(
    draft.map((d) => ({ name: d.name, region: d.region, rpc: d.rpc })),
    originalOverride ?? defaults,
  );

  const draftValid = draft.length > 0 && draft.every(isValidDraftEntry);

  const handleAddRow = () => {
    setDraft((prev) => [...prev, { rid: newRid(), name: "", region: "", rpc: "" }]);
  };

  const handleDeleteRow = (rid: string) => {
    setDraft((prev) => prev.filter((d) => d.rid !== rid));
  };

  const handleMove = (rid: string, dir: -1 | 1) => {
    setDraft((prev) => {
      const idx = prev.findIndex((d) => d.rid === rid);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[idx]!;
      next[idx] = next[target]!;
      next[target] = tmp;
      return next;
    });
  };

  const handlePatch = (rid: string, patch: Partial<OperatorEntryWire>) => {
    setDraft((prev) =>
      prev.map((d) => (d.rid === rid ? { ...d, ...patch } : d)),
    );
  };

  const handleSave = async () => {
    if (submitting || !draftValid) return;
    setSubmitting(true);
    setSubmitError(null);
    const wire = draft.map((d) => ({ name: d.name.trim(), region: d.region.trim(), rpc: d.rpc.trim() }));
    const r = await bgOperatorsSet(wire);
    setSubmitting(false);
    if (!r.ok) {
      setSubmitError(r.reason ?? "save failed");
      return;
    }
    await refresh();
  };

  const handleReset = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const r = await bgOperatorsSet(null);
    setSubmitting(false);
    if (!r.ok) {
      setSubmitError(r.reason ?? "reset failed");
      return;
    }
    await refresh();
  };

  // The operator-management page (RPC-override editor + chain-signing /
  // authority / upcoming-duties consensus cards) is developer-only. Reached
  // via the (kept-discoverable) "Manage operators" entry; gate the destination.
  if (!devMode) {
    return (
      <>
        <div className="ext-top">
          <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={15} />
          </button>
          <div
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            Operators
          </div>
          <div style={{ width: 28 }} />
        </div>
        <div className="ext-body">
          <div
            className="ext-card"
            style={{ textAlign: "center", padding: "32px 18px" }}
          >
            <Icon name="code" size={28} />
            <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600 }}>
              Developer mode required
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.5,
              }}
            >
              Operator management (custom RPC endpoints and consensus-authority
              details) is a developer tool. Turn on developer mode to use it.
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "center",
                marginTop: 14,
              }}
            >
              {onOpenSettings && (
                <button type="button" onClick={onOpenSettings} style={devModeNavBtn}>
                  Settings <Icon name="external" size={11} />
                </button>
              )}
              {onOpenAbout && (
                <button type="button" onClick={onOpenAbout} style={devModeNavBtn}>
                  About <Icon name="external" size={11} />
                </button>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Monolythium Testnet operators
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {!loaded ? (
          <div style={{ padding: 18, color: "var(--fg-300)", fontSize: 12 }}>
            Loading…
          </div>
        ) : (
          <>
            <div
              className="ext-card"
              style={{
                padding: "10px 12px",
                background: overrideActive
                  ? "rgba(80,200,120,0.08)"
                  : "rgba(124,127,255,0.06)",
                border: overrideActive
                  ? "1px solid rgba(80,200,120,0.4)"
                  : "1px solid rgba(124,127,255,0.3)",
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: overrideActive ? "var(--ok)" : "var(--fg-400)",
                  flexShrink: 0,
                }}
              />
              <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-100)" }}>
                {overrideActive
                  ? "Custom operator list active"
                  : "Using default operators"}
              </div>
            </div>

            <ChainSigningHealthCard />

            <AuthorityRiskCard />

            <UpcomingDutiesCard />

            <div className="ext-card" style={{ padding: "8px 10px" }}>
              {draft.length === 0 ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--fg-400)",
                    padding: "12px 8px",
                    fontStyle: "italic",
                  }}
                >
                  No operators. Add at least one before saving.
                </div>
              ) : (
                draft.map((d, idx) => (
                  <OperatorRow
                    key={d.rid}
                    entry={d}
                    isFirst={idx === 0}
                    isLast={idx === draft.length - 1}
                    onMoveUp={() => handleMove(d.rid, -1)}
                    onMoveDown={() => handleMove(d.rid, 1)}
                    onDelete={() => handleDeleteRow(d.rid)}
                    onPatch={(patch) => handlePatch(d.rid, patch)}
                  />
                ))
              )}

              <button
                className="ext-act"
                onClick={handleAddRow}
                style={{
                  width: "100%",
                  padding: "10px",
                  flexDirection: "row",
                  gap: 8,
                  marginTop: draft.length === 0 ? 0 : 8,
                }}
              >
                <Icon name="plus" size={13} /> Add operator
              </button>
            </div>

            {submitError && (
              <div
                className="ext-card"
                style={{
                  padding: "10px 12px",
                  background: "rgba(220,80,80,0.08)",
                  border: "1px solid rgba(220,80,80,0.4)",
                  fontSize: 12,
                  color: "var(--err)",
                }}
              >
                {submitError}
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <button
                onClick={() => void handleReset()}
                disabled={submitting || !overrideActive}
                style={{
                  ...secondaryBtn,
                  opacity: submitting || !overrideActive ? 0.4 : 1,
                }}
              >
                Reset to defaults
              </button>
              <button
                className="ext-act prim"
                onClick={() => void handleSave()}
                disabled={submitting || !dirty || !draftValid}
                style={{
                  padding: "12px",
                  flexDirection: "row",
                  gap: 8,
                  opacity: submitting || !dirty || !draftValid ? 0.5 : 1,
                  cursor: submitting || !dirty || !draftValid ? "default" : "pointer",
                }}
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>

            <div
              style={{
                fontSize: 10.5,
                color: "var(--fg-500)",
                lineHeight: 1.5,
                marginTop: 8,
                fontFamily: "var(--f-mono)",
              }}
            >
              RPC dispatch iterates this list in order, falling through on
              transport failure. Order matters — the first responding
              operator wins.
            </div>
          </>
        )}
      </div>
    </>
  );
}

interface OperatorRowProps {
  entry: DraftOperator;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onPatch: (patch: Partial<OperatorEntryWire>) => void;
}

function OperatorRow({
  entry,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDelete,
  onPatch,
}: OperatorRowProps) {
  const rpcInvalid = entry.rpc.length > 0 && !isParseableUrl(entry.rpc);
  const nameMissing = entry.name.trim().length === 0;
  return (
    <div
      style={{
        padding: "10px 4px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <FieldLabel>Name</FieldLabel>
        <input
          type="text"
          value={entry.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="operator-1"
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label="Move up"
          style={{ ...iconBtnStyle, opacity: isFirst ? 0.3 : 1 }}
        >
          ↑
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          aria-label="Move down"
          style={{ ...iconBtnStyle, opacity: isLast ? 0.3 : 1 }}
        >
          ↓
        </button>
        <button
          onClick={onDelete}
          aria-label="Delete operator"
          style={{ ...iconBtnStyle, color: "var(--err)" }}
        >
          ×
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <FieldLabel>Region</FieldLabel>
        <input
          type="text"
          value={entry.region}
          onChange={(e) => onPatch({ region: e.target.value })}
          placeholder="fsn1 (optional)"
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <FieldLabel>RPC</FieldLabel>
        <input
          type="text"
          value={entry.rpc}
          onChange={(e) => onPatch({ rpc: e.target.value })}
          placeholder="http://… or https://…"
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
      {(rpcInvalid || nameMissing) && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--err)",
            marginTop: 6,
            paddingLeft: 60,
          }}
        >
          {nameMissing ? "Name is required. " : ""}
          {rpcInvalid ? "RPC must be a valid URL." : ""}
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 9,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--fg-400)",
        width: 54,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 8,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 11,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
  minWidth: 0,
};

const iconBtnStyle: CSSProperties = {
  width: 26,
  height: 26,
  display: "grid",
  placeItems: "center",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontSize: 12,
  fontFamily: "var(--f-sans)",
  cursor: "pointer",
  flexShrink: 0,
};

const secondaryBtn: CSSProperties = {
  padding: "12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

// ---- helpers ----

function isParseableUrl(s: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function isValidDraftEntry(d: DraftOperator): boolean {
  return d.name.trim().length > 0 && isParseableUrl(d.rpc);
}

function sameOperators(
  a: ReadonlyArray<OperatorEntryWire>,
  b: ReadonlyArray<OperatorEntryWire>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name) return false;
    if (a[i]!.region !== b[i]!.region) return false;
    if (a[i]!.rpc !== b[i]!.rpc) return false;
  }
  return true;
}

/** Chain-wide signing-health sample. Calls
 *  `lyth_signingActivity` (MD-CORE-0004) for the canonical first
 *  authority slot, renders a single-line status pill + signer count
 *  + a reservedStatuses footnote when the chain reports subsystems
 *  with partial wiring. Hidden entirely on any mock-* outcome so
 *  older operators (pre-mono-core @dd05511) don't see a broken card.
 *
 *  Per-RPC-endpoint attribution is intentionally out of scope: the
 *  wallet's Operators page manages transport-layer RPC URLs, while
 *  `lyth_signingActivity` is keyed on the consensus BLS authority
 *  slot. Mapping the two would require chaining
 *  `lyth_resolveOperatorAuthority` over `lyth_clusterStatus.members`
 *  per row, which is deferred. The card title is explicit about that
 *  scope so users don't misread it as per-RPC health. */
function ChainSigningHealthCard() {
  const [outcome, setOutcome] = useState<ChainSigningActivityOutcome | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgChainSigningActivity();
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setOutcome(r.outcome);
      else setOutcome(null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div
        className="ext-card"
        style={{
          padding: "10px 12px",
          background: "rgba(124,127,255,0.04)",
          border: "1px dashed rgba(124,127,255,0.2)",
          height: 28,
        }}
        aria-hidden="true"
      />
    );
  }
  if (!outcome || outcome.kind !== "live") return null;
  return <SigningHealthLive activity={outcome.data} />;
}

function SigningHealthLive({ activity }: { activity: OperatorSigningActivity }) {
  const summary = summarizeSigningActivity(activity);
  const { dotColor, label } = statusPillStyle(summary.latestStatus);
  return (
    <div
      className="ext-card"
      style={{
        padding: "10px 12px",
        background: "rgba(124,127,255,0.05)",
        border: "1px solid rgba(124,127,255,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        Chain signing — authority {activity.authorityIndex} · round{" "}
        {activity.currentRound}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--fg-100)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
          title={`Latest signing status: ${summary.latestStatus}`}
        />
        <span style={{ fontWeight: 600 }}>{label}</span>
        {summary.latestSignersCount !== null && (
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-400)" }}>
            · {summary.latestSignersCount} signers
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-500)",
          }}
        >
          {activity.entries.length} / {activity.limit}
        </span>
      </div>
      {activity.reservedStatuses.length > 0 && (
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-400)",
            lineHeight: 1.4,
            paddingTop: 4,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <span style={{ color: "var(--warn, #f2b441)" }}>
            {activity.reservedStatuses.length} reserved status
            {activity.reservedStatuses.length === 1 ? "" : "es"}
          </span>{" "}
          — primitives partially wired (
          {activity.reservedStatuses
            .slice(0, 3)
            .map((r) => r.code)
            .join(", ")}
          {activity.reservedStatuses.length > 3 ? ", …" : ""}
          ).
        </div>
      )}
    </div>
  );
}

/** Chain-wide authority-risk snapshot. Calls
 *  `lyth_operatorRisk` (MD-CORE-0006 / 017cab9) for the canonical
 *  first authority slot, renders a single-row "miss rate × headroom
 *  × jail" tier card. Hidden on any mock-* outcome so older
 *  operators (pre-mono-core @dd05511) don't see a broken card.
 *
 *  Swap rationale (see operator-risk-client.ts module header):
 *  lyth_getServiceProbe requires a peerId per row the wallet
 *  doesn't track; lyth_operatorRisk is the sibling surface that
 *  delivers the same "real chain-side health" intent without that
 *  extra resolution step. */
function AuthorityRiskCard() {
  const [outcome, setOutcome] = useState<ChainOperatorRiskOutcome | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgChainOperatorRisk();
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setOutcome(r.outcome);
      else setOutcome(null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div
        className="ext-card"
        style={{
          padding: "10px 12px",
          background: "rgba(124,127,255,0.04)",
          border: "1px dashed rgba(124,127,255,0.2)",
          height: 28,
        }}
        aria-hidden="true"
      />
    );
  }
  if (!outcome || outcome.kind !== "live") return null;
  return <AuthorityRiskLive risk={outcome.data} />;
}

function AuthorityRiskLive({ risk }: { risk: OperatorRiskWire }) {
  const tier = deriveOperatorRiskTier(risk);
  const tierStyle = tierBadgeStyle(tier);
  const missPct = (risk.missRateBps / 100).toFixed(2);
  const headroomPct = (risk.remainingHeadroomBps / 100).toFixed(2);
  const thresholdPct = (risk.thresholdBps / 100).toFixed(0);
  const jail = risk.jailStatus;
  return (
    <div
      className="ext-card"
      style={{
        padding: "10px 12px",
        background: tierStyle.bg,
        border: `1px solid ${tierStyle.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        Authority risk — authority {risk.authorityIndex} · height{" "}
        {risk.dataHeight}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          fontSize: 12,
          color: "var(--fg-100)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: tierStyle.dot,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600 }}>{tierStyle.label}</span>
        <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-400)" }}>
          miss {missPct}% / headroom {headroomPct}% (slash {thresholdPct}%)
        </span>
      </div>
      {isJailStatusAvailable(jail) && (jail.jailed || jail.tombstoned) && (
        <div style={{ fontSize: 11, color: "var(--err)" }}>
          {jail.tombstoned
            ? "Tombstoned — equivocation slash, permanently barred."
            : `Jailed until height ${jail.jailedUntilHeight} (${jail.unjailCount} prior unjails).`}
        </div>
      )}
      {risk.reasons.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--fg-300)" }}>
          Reasons: {risk.reasons.join(", ")}
        </div>
      )}
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-500)",
        }}
      >
        Sampled over {risk.windowRounds} rounds · {risk.observedRounds}{" "}
        observed
      </div>
    </div>
  );
}

/** Chain-wide upcoming-duties snapshot. Calls
 *  `lyth_upcomingDuties` (MD-CORE-0005) for the canonical first
 *  authority slot, renders a compact card showing attestation
 *  window + key-rotation epoch boundary + committee context. Hidden
 *  on any mock-* outcome so older operators don't see a broken
 *  card.
 *
 *  Block production + sync duties are typed-null with reasons on
 *  Starfish-C (leader election unpredictable), per the chain doc
 *  at protocore.rs:354-358. The card shows them as one-liner
 *  reason rows rather than scheduling targets. */
function UpcomingDutiesCard() {
  const [outcome, setOutcome] = useState<ChainUpcomingDutiesOutcome | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgChainUpcomingDuties();
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setOutcome(r.outcome);
      else setOutcome(null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div
        className="ext-card"
        style={{
          padding: "10px 12px",
          background: "rgba(124,127,255,0.04)",
          border: "1px dashed rgba(124,127,255,0.2)",
          height: 28,
        }}
        aria-hidden="true"
      />
    );
  }
  if (!outcome || outcome.kind !== "live") return null;
  return <UpcomingDutiesLive duties={outcome.data} />;
}

function UpcomingDutiesLive({ duties }: { duties: UpcomingDuties }) {
  const { attestation, blockProduction, sync, keyRotation } = duties.duties;
  const attestationOpen =
    attestation.endRound >= duties.currentRound &&
    attestation.startRound <= duties.currentRound + duties.horizonRounds;
  const keyRotation_ = keyRotation;
  return (
    <div
      className="ext-card"
      style={{
        padding: "10px 12px",
        background: "rgba(124,127,255,0.05)",
        border: "1px solid rgba(124,127,255,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        Upcoming duties — authority {duties.authorityIndex} · round{" "}
        {duties.currentRound}
      </div>
      <DutyRow
        label="Attestation"
        value={
          attestationOpen
            ? `rounds ${attestation.startRound}–${attestation.endRound} · ${attestation.kind}`
            : `next window: rounds ${attestation.startRound}–${attestation.endRound}`
        }
        tone="ok"
      />
      <DutyRow
        label="Key rotation"
        value={
          isKeyRotationAvailable(keyRotation_)
            ? `next round ${keyRotation_.nextRound} · epoch ${keyRotation_.epochLengthRounds} rounds`
            : `not scheduled: ${keyRotation_.reason}`
        }
        tone={isKeyRotationAvailable(keyRotation_) ? "ok" : "info"}
      />
      <DutyRow
        label="Block production"
        value={blockProduction.reason}
        tone="info"
      />
      <DutyRow label="Sync" value={sync.reason} tone="info" />
      {duties.committee && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-500)",
            paddingTop: 4,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          Committee: {duties.committee.authoritySetSize} authorities · quorum{" "}
          {duties.committee.quorumThreshold} · recovery{" "}
          {duties.committee.recoveryFloor}
          {duties.committee.authorityInCurrentSet
            ? " · in current set"
            : " · NOT in current set"}
        </div>
      )}
    </div>
  );
}

function DutyRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "info";
}) {
  const dot = tone === "ok" ? "var(--ok)" : "var(--fg-500)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        fontSize: 11.5,
        color: "var(--fg-100)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dot,
          flexShrink: 0,
          alignSelf: "center",
        }}
      />
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
          width: 78,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          fontFamily: "var(--f-mono)",
          color: "var(--fg-300)",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function tierBadgeStyle(tier: OperatorRiskTier): {
  dot: string;
  label: string;
  bg: string;
  border: string;
} {
  switch (tier) {
    case "ok":
      return {
        dot: "var(--ok)",
        label: "Healthy",
        bg: "rgba(80,200,120,0.06)",
        border: "rgba(80,200,120,0.3)",
      };
    case "warn":
      return {
        dot: "var(--warn, #f2b441)",
        label: "Near threshold",
        bg: "rgba(242,180,65,0.06)",
        border: "rgba(242,180,65,0.3)",
      };
    case "err":
      return {
        dot: "var(--err)",
        label: "At risk",
        bg: "rgba(244,99,99,0.06)",
        border: "rgba(244,99,99,0.3)",
      };
  }
}

function statusPillStyle(status: SigningEntryStatus): {
  dotColor: string;
  label: string;
} {
  switch (status) {
    case "signed":
      return { dotColor: "var(--ok)", label: "Signing (latest cert healthy)" };
    case "maintenance":
      return { dotColor: "var(--info, #7c7fff)", label: "Maintenance window" };
    case "delayed":
      return { dotColor: "var(--warn, #f2b441)", label: "Delayed — round behind" };
    case "missed":
      return { dotColor: "var(--warn, #f2b441)", label: "Missed round" };
    case "offline":
      return { dotColor: "var(--err)", label: "Offline" };
    case "no_cert":
      return { dotColor: "var(--fg-500)", label: "No cert this round" };
    case "unavailable_history":
      return { dotColor: "var(--fg-500)", label: "History unavailable" };
    default:
      return {
        dotColor: "var(--fg-500)",
        label: `Status: ${status}`,
      };
  }
}
