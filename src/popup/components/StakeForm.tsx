// StakeForm. Percent-of-balance input + selected-cluster context +
// cap-headroom check + Continue CTA. Dumb component: the parent
// (Stake page) owns the cluster pick, the wallet balance, and the
// chain submission.
//
// NON-CUSTODIAL delegation: the user chooses a PERCENT of their balance
// to delegate to the cluster (= weightBps). No tokens are escrowed — the
// delegate tx is sent with value = 0 and the LYTH stays fully liquid and
// spendable. The form shows the live EFFECTIVE WEIGHT
// (balance × weightBps / 10000) so the user can see the contribution that
// percent represents at the current balance; if they spend, the effective
// weight tracks the balance down at the next settlement.
//
// Cap-headroom logic (§23.6 + §23.7):
//   - The chain's per-cluster cap binds the bps fraction per wallet.
//     Phase 12 launch = 50% (5000 bps). The form enforces that
//     requested-percent + already-delegated <= cap so the user can't
//     construct a transaction the chain will reject.
//   - Cap can be `null` (chain returned `u32::MAX` = disabled). When
//     disabled, the form skips the cap check entirely.
//
// MOCK fee: the wallet still uses the §22 native fee model for delegation tx;
// the form quotes a standard execution-unit budget plus a small native fee.
// Real fee suggestion arrives from `wallet-fee-suggestion` IPC at the parent.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import type { ClusterDirectoryEntry } from "../../shared/staking";
import { effectiveWeightWei, percentToBps } from "../../shared/staking-tx";
import { LYTHOSHI_PER_LYTH, NATIVE_LYTH_DECIMALS } from "@monolythium/core-sdk";

export interface StakeFormProps {
  /** Cluster the user is about to delegate to. */
  cluster: ClusterDirectoryEntry;
  /** Current percent-of-balance string (0–100). The parent owns this so
   *  it survives state transitions back to the picker. */
  amountStr: string;
  onAmountChange: (next: string) => void;
  /** Native lythoshi balance (18-decimal); null while the SW
   *  wallet-balance fetch is in flight. */
  balanceLythoshi: bigint | null;
  /** Already-delegated weight to THIS cluster (bps). Used for the
   *  cap-headroom check — additions stack on top of existing weight. */
  existingWeightBps: number;
  /** Per-cluster cap in bps from `lyth_getDelegationCap`. `null` when
   *  the chain has disabled the cap (`u32::MAX`). */
  capBps: number | null;
  /** Continue → preview/sign. Parent gates this when `canContinue`
   *  is false; the button is still rendered for keyboard a11y. */
  onContinue: () => void;
  /** Back → cluster picker. */
  onBack: () => void;
}

// LYTHOSHI_PER_LYTH (10^18) is imported from the SDK above — single source of truth.

/** Parse a percent-of-balance string (0–100, optional decimals) into a
 *  number, or `null` when it isn't a valid percent. */
export function parsePercent(amountStr: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
  const n = Number(amountStr);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** Lythoshi → LYTH display string. Used for the
 *  balance + effective-weight hint strings. */
export function lythoshiToLyth(lythoshi: bigint, decimals = 4): string {
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const remainder = lythoshi % LYTHOSHI_PER_LYTH;
  if (decimals === 0 || remainder === 0n) return whole.toString();
  const remStr = remainder
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, decimals);
  // Trim trailing zeros for compact display.
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

export function StakeForm({
  cluster,
  amountStr,
  onAmountChange,
  balanceLythoshi,
  existingWeightBps,
  capBps,
  onContinue,
  onBack,
}: StakeFormProps) {
  const percent = useMemo(() => parsePercent(amountStr), [amountStr]);

  // The requested weight in bps and the would-be total after this stake.
  const additionalBps = percent !== null ? percentToBps(percent) : 0;
  const totalAfterBps = existingWeightBps + additionalBps;

  // Live effective weight this percent represents at the current balance.
  const effectiveWeightLythoshi =
    balanceLythoshi !== null ? effectiveWeightWei(additionalBps, balanceLythoshi) : null;

  const overCap = capBps !== null && totalAfterBps > capBps;
  const percentIsZero = percent === null || additionalBps === 0;
  // Additive >100% feedback: parsePercent collapses >100 to null (= empty),
  // so read the raw input to disambiguate WITHOUT touching the parser.
  const exceedsHundred =
    /^\d+(\.\d+)?$/.test(amountStr) && Number(amountStr) > 100;

  const canContinue =
    percent !== null &&
    additionalBps > 0 &&
    !overCap &&
    balanceLythoshi !== null;

  const handleMax = () => {
    // Cap-aware max: fill up to the per-cluster cap headroom (or 100% when
    // the cap is disabled). Headroom is purely a bps fraction now — no
    // balance math, because nothing is escrowed.
    if (capBps === null) {
      onAmountChange("100");
      return;
    }
    const headroomBps = Math.max(0, capBps - existingWeightBps);
    onAmountChange((headroomBps / 100).toString());
  };

  const aprBps = cluster.aprBps ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Selected-cluster summary */}
      <div style={selectedClusterCardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Delegating to
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--fg-100)",
                marginTop: 2,
              }}
            >
              {cluster.name ?? `cluster-${cluster.clusterId}`}
            </div>
          </div>
          <button onClick={onBack} style={changeBtnStyle}>
            Change
          </button>
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            lineHeight: 1.6,
          }}
        >
          APR {aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`} ·{" "}
          {cluster.threshold}-of-{cluster.size} threshold · health{" "}
          {cluster.health}
        </div>
      </div>

      {/* Percent input */}
      <div className="ext-card" style={{ padding: 14 }}>
        <div style={cardLabel}>Delegate percent of balance</div>
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
          {[25, 50, 75].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onAmountChange(String(p))}
              style={{ ...inlineBtnStyle, padding: "8px 10px" }}
            >
              {p}%
            </button>
          ))}
          <button
            onClick={handleMax}
            disabled={balanceLythoshi === null}
            style={{
              ...inlineBtnStyle,
              opacity: balanceLythoshi === null ? 0.5 : 1,
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
        {overCap && capBps !== null && (
          <div style={inlineErr}>
            Delegation would exceed the per-cluster cap (
            {(capBps / 100).toFixed(0)}%) by{" "}
            {((totalAfterBps - capBps) / 100).toFixed(2)}%.
          </div>
        )}
        {exceedsHundred && (
          <div style={inlineErr}>
            Enter a percent between 0.01% and 100% of your balance.
          </div>
        )}
        <div style={fromHint}>
          {balanceLythoshi === null ? (
            "Balance loading…"
          ) : (
            <>
              {/* Live effective weight = balance × weightBps. */}
              effective weight{" "}
              <strong style={{ color: "var(--gold)" }}>
                {effectiveWeightLythoshi === null
                  ? "—"
                  : `${lythoshiToLyth(effectiveWeightLythoshi)} LYTH`}
              </strong>{" "}
              ({(additionalBps / 100).toFixed(2)}% of {lythoshiToLyth(balanceLythoshi)} LYTH)
              {existingWeightBps > 0 && (
                <>
                  {" "}
                  · existing {(existingWeightBps / 100).toFixed(2)}% in this cluster
                </>
              )}
              {capBps !== null && (
                <>
                  {" "}
                  · cap {(capBps / 100).toFixed(0)}%
                </>
              )}
            </>
          )}
        </div>
        <div style={liquidNote}>
          Your LYTH stays in your wallet and remains spendable — nothing is
          locked or sent to a staking contract. The effective weight tracks
          your live balance at the next settlement.
        </div>
      </div>

      {/* Continue */}
      <button
        className="ext-act prim"
        onClick={onContinue}
        disabled={!canContinue}
        style={{
          width: "100%",
          padding: "12px",
          flexDirection: "row",
          gap: 8,
          opacity: canContinue ? 1 : 0.5,
          cursor: canContinue ? "pointer" : "default",
        }}
      >
        <Icon name="check" size={12} />
        {percentIsZero
          ? "Enter a percent"
          : overCap
            ? "Reduce to cap"
            : "Review delegation"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const selectedClusterCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(244,201,122,0.06)",
  border: "1px solid rgba(244,201,122,0.4)",
};

const changeBtnStyle: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const amountInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  maxWidth: 110,
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

const liquidNote: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-500)",
  marginTop: 8,
  lineHeight: 1.5,
  paddingTop: 8,
  borderTop: "1px solid var(--fg-700)",
};
