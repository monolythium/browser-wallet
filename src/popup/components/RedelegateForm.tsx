// RedelegateForm. Move weight from one cluster to another in
// a single tx. Uses the `be79a2f` redelegation precompile method:
//
//   redelegate(uint32 srcCluster, uint32 dstCluster, uint16 weightBps)
//
// Per whitepaper §23.2, redelegation is instant for delegators — no
// unbonding period, no cluster-side cooldown. The form's UX language
// reflects this explicitly: "Instant cluster swap" rather than the
// Cosmos-style 21-day-redelegation-window framing.
//
// NON-CUSTODIAL: the move is expressed as a PERCENT of balance (weightBps);
// no tokens are escrowed at either cluster — the redelegate tx is sent with
// value = 0.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import type { ClusterDirectoryEntry } from "../../shared/staking";
import { percentToBps } from "../../shared/staking-tx";
import { LYTHOSHI_PER_LYTH, NATIVE_LYTH_DECIMALS } from "@monolythium/core-sdk";

export interface RedelegateFormProps {
  /** Cluster the weight is moving from. Must have current weight. */
  srcCluster: ClusterDirectoryEntry;
  srcWeightBps: number;
  /** Cluster the weight is moving to. Null while the user is still
   *  picking from the directory. */
  dstCluster: ClusterDirectoryEntry | null;
  /** Existing weight at the destination cluster — the cap check stacks
   *  the incoming amount on top of this. */
  dstExistingWeightBps: number;
  /** Per-cluster cap (§23.6). */
  capBps: number | null;
  amountStr: string;
  onAmountChange: (next: string) => void;
  /** Open the destination picker. The parent handles cluster picking
   *  via the same ClusterPicker the stake flow uses. */
  onPickDestination: () => void;
  /** Native lythoshi balance (18-decimal); null while the SW
   *  wallet-balance fetch is in flight. */
  balanceLythoshi: bigint | null;
  onContinue: () => void;
  onBack: () => void;
}

// LYTHOSHI_PER_LYTH (10^18) is imported from the SDK above — single source of truth.

export function lythToLythoshi(amountStr: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
  const dot = amountStr.indexOf(".");
  const intPart = dot < 0 ? amountStr : amountStr.slice(0, dot);
  const fracPart = dot < 0 ? "" : amountStr.slice(dot + 1);
  if (fracPart.length > NATIVE_LYTH_DECIMALS) return null;
  const padded =
    fracPart + "0".repeat(NATIVE_LYTH_DECIMALS - fracPart.length);
  try {
    return (
      BigInt(intPart) * LYTHOSHI_PER_LYTH +
      (padded.length > 0 ? BigInt(padded) : 0n)
    );
  } catch {
    return null;
  }
}

export function lythoshiToLyth(lythoshi: bigint, decimals = 4): string {
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const rem = lythoshi % LYTHOSHI_PER_LYTH;
  if (rem === 0n || decimals === 0) return whole.toString();
  const remStr = rem
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, decimals);
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

export function RedelegateForm({
  srcCluster,
  srcWeightBps,
  dstCluster,
  dstExistingWeightBps,
  capBps,
  amountStr,
  onAmountChange,
  onPickDestination,
  balanceLythoshi,
  onContinue,
  onBack,
}: RedelegateFormProps) {
  // `amountStr` is a PERCENT of balance (weightBps) being moved.
  const movePercent = useMemo(() => {
    if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
    const n = Number(amountStr);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }, [amountStr]);
  const moveBps = movePercent !== null ? percentToBps(movePercent) : 0;

  const exceedsSource = moveBps > srcWeightBps;
  const totalAtDstAfter = dstExistingWeightBps + moveBps;
  const exceedsDstCap = capBps !== null && totalAtDstAfter > capBps;

  const amountIsZero = movePercent === null || moveBps === 0;
  const dstChosen = dstCluster !== null;
  const sameAsSrc = dstCluster?.clusterId === srcCluster.clusterId;
  const canContinue =
    !amountIsZero &&
    !exceedsSource &&
    !exceedsDstCap &&
    dstChosen &&
    !sameAsSrc &&
    balanceLythoshi !== null;

  const handleMax = () => {
    if (srcWeightBps <= 0) return;
    // Max from source = full source weight, then capped by the
    // destination's headroom if applicable. All in bps fractions now —
    // no balance math, because nothing is escrowed.
    let limitBps = srcWeightBps;
    if (capBps !== null) {
      const headroomBps = Math.max(0, capBps - dstExistingWeightBps);
      limitBps = Math.min(srcWeightBps, headroomBps);
    }
    onAmountChange((limitBps / 100).toString());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Source + destination row */}
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardLabel}>Cluster swap</div>
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            gap: 6,
            alignItems: "center",
          }}
        >
          {/* Source */}
          <div style={{ textAlign: "left", minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 9,
                color: "var(--fg-500)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              From
            </div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--fg-100)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {srcCluster.name ?? `cluster-${srcCluster.clusterId}`}
            </div>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 9.5,
                color: "var(--fg-400)",
                marginTop: 2,
              }}
            >
              {(srcWeightBps / 100).toFixed(2)}%
            </div>
          </div>

          {/* Arrow */}
          <div style={{ color: "var(--gold)", fontSize: 14, padding: "0 6px" }}>
            →
          </div>

          {/* Destination */}
          {dstCluster === null ? (
            <button onClick={onPickDestination} style={pickDstBtnStyle}>
              Pick cluster
            </button>
          ) : (
            <button
              onClick={onPickDestination}
              style={dstChosenBtnStyle}
              title="Tap to change destination"
            >
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9,
                  color: "var(--fg-500)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  textAlign: "left",
                }}
              >
                To
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--fg-100)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "left",
                }}
              >
                {dstCluster.name ?? `cluster-${dstCluster.clusterId}`}
              </div>
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9.5,
                  color: "var(--fg-400)",
                  marginTop: 2,
                  textAlign: "left",
                }}
              >
                APR{" "}
                {dstCluster.aprBps === undefined || dstCluster.aprBps === null
                  ? "—"
                  : `${(dstCluster.aprBps / 100).toFixed(2)}%`}
              </div>
            </button>
          )}
        </div>
        {sameAsSrc && (
          <div style={inlineErr}>
            Source and destination must be different clusters.
          </div>
        )}
      </div>

      {/* Percent-of-balance input */}
      <div className="ext-card" style={{ padding: 14 }}>
        <div style={cardLabel}>Weight to move (% of balance)</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
          }}
        >
          <input
            type="text"
            value={amountStr}
            onChange={(e) => onAmountChange(e.target.value.trim())}
            placeholder="0"
            inputMode="decimal"
            style={amountInputStyle}
          />
          <button
            onClick={handleMax}
            disabled={srcWeightBps <= 0 || dstCluster === null}
            style={{
              ...inlineBtnStyle,
              opacity: srcWeightBps <= 0 || dstCluster === null ? 0.5 : 1,
            }}
            type="button"
          >
            Max
          </button>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 13,
              color: "var(--fg-400)",
            }}
          >
            %
          </div>
        </div>
        {exceedsSource && (
          <div style={inlineErr}>
            Exceeds your current delegation at the source cluster (
            {(srcWeightBps / 100).toFixed(2)}%).
          </div>
        )}
        {exceedsDstCap && capBps !== null && (
          <div style={inlineErr}>
            Would push the destination over the per-cluster cap (
            {(capBps / 100).toFixed(0)}%) by{" "}
            {((totalAtDstAfter - capBps) / 100).toFixed(2)}%.
          </div>
        )}
        <div style={fromHint}>
          Instant cluster swap — no cooldown between source and destination.
          Your LYTH stays in your wallet the whole time; only the cluster
          weighting moves.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button onClick={onBack} style={secondaryBtnStyle}>
          Back
        </button>
        <button
          className="ext-act prim"
          onClick={onContinue}
          disabled={!canContinue}
          style={{
            padding: "12px",
            flexDirection: "row",
            gap: 8,
            opacity: canContinue ? 1 : 0.5,
            cursor: canContinue ? "pointer" : "default",
          }}
        >
          <Icon name="check" size={12} />
          {amountIsZero
            ? "Enter amount"
            : !dstChosen
              ? "Pick destination"
              : sameAsSrc
                ? "Pick different"
                : exceedsSource
                  ? "Reduce amount"
                  : exceedsDstCap
                    ? "Reduce to cap"
                    : "Review swap"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const amountInputStyle: CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 13,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
};

const inlineBtnStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const inlineErr: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 6,
};

const fromHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-500)",
  marginTop: 8,
  lineHeight: 1.5,
};

const pickDstBtnStyle: CSSProperties = {
  padding: "12px 10px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
  textAlign: "center",
  width: "100%",
};

const dstChosenBtnStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  cursor: "pointer",
  width: "100%",
  minWidth: 0,
};

const secondaryBtnStyle: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};
