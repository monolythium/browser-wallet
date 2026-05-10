// Operators — Sprintnet operator override management.
//
// Sprintnet is a single chain with multiple operator RPC endpoints. Power
// users can override the published 7-operator default list with their
// own validator URLs, or pin a single operator to bypass round-robin.
//
// Storage flow: edits are local until [Save] writes via bgOperatorsSet.
// The SW's chrome.storage.onChanged listener invalidates the operator-
// probe cache so the next chain-health tick (~8s) picks up the new list
// without a popup or SW restart.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import {
  bgOperatorsGet,
  bgOperatorsSet,
  type OperatorEntryWire,
} from "../bg";

interface OperatorsProps {
  onBack: () => void;
}

interface DraftOperator extends OperatorEntryWire {
  /** Local row id so React keys stay stable across moves/edits even when
   *  the user has two rows with the same name (e.g. duplicates during
   *  paste-then-edit). */
  rid: string;
}

let RID_COUNTER = 0;
const newRid = () => `op-${RID_COUNTER++}`;

export function Operators({ onBack }: OperatorsProps) {
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

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Sprintnet operators
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
          placeholder="val-1"
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
