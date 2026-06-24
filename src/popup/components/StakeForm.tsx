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
import { useMemo, useState } from "react";
import { Icon } from "../Icon";
import { hoverBg } from "../hover";
import type { ClusterDirectoryEntry } from "../../shared/staking";
import {
  bindingPerClusterCapBps,
  dualCapHeadroomBps,
  exceedsPerClusterCap,
} from "../../shared/staking";
import {
  effectiveWeightWholeLythoshi,
  isInertDelegation,
  minNonInertBps,
  percentToBps,
} from "../../shared/staking-tx";
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
  /** Total weight already delegated across ALL clusters (bps). The global
   *  100%-of-balance ceiling: requested + total must stay ≤ 10000 bps. */
  totalDelegatedBps: number;
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

/** Binding bps headroom for an additional delegation to a cluster: the smaller
 *  of the per-cluster cap headroom and the global 100%-of-balance headroom
 *  (total weight across ALL clusters ≤ 10000 bps). Never negative. Pure bps —
 *  delegation is non-custodial (value = 0), so there is no balance subtraction.
 *
 *  Thin wrapper over the shared `dualCapHeadroomBps` so the per-cluster term is
 *  the fail-closed §16.7 floor: a null aggregate cap (disabled on v2) yields the
 *  5000 per-cluster floor, NOT an unlimited cluster headroom. */
export function bindingHeadroomBps(
  capBps: number | null,
  existingWeightBps: number,
  totalDelegatedBps: number,
): number {
  return dualCapHeadroomBps(capBps, existingWeightBps, totalDelegatedBps);
}

/** The "X% delegated · Y% available" line escalates to the prominent warn
 *  treatment only when NO global headroom remains (0% available); otherwise it
 *  stays a quiet hint. Exported for unit coverage. */
export function headroomExhausted(globalHeadroomBps: number): boolean {
  return globalHeadroomBps <= 0;
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
  totalDelegatedBps,
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
    balanceLythoshi !== null
      ? effectiveWeightWholeLythoshi(additionalBps, balanceLythoshi)
      : null;

  // The §16.7 per-wallet floor (5000 bps) ALWAYS binds — even when the queryable
  // AGGREGATE cap (`capBps`, from lyth_getDelegationCap) is disabled/null on v2.
  // Fail-closed: a null cap does NOT lift the per-cluster cap.
  const overCap = exceedsPerClusterCap(existingWeightBps, additionalBps, capBps);
  const bindingCapBps = bindingPerClusterCapBps(capBps);
  // Global ceiling: total delegated weight across ALL clusters ≤ 100%. The
  // binding headroom is the smaller of the per-cluster cap headroom and this.
  const globalHeadroomBps = Math.max(0, 10000 - totalDelegatedBps);
  const headroomBps = bindingHeadroomBps(
    capBps,
    existingWeightBps,
    totalDelegatedBps,
  );
  const overGlobal = additionalBps > globalHeadroomBps;
  const percentIsZero = percent === null || additionalBps === 0;
  // Additive >100% feedback: parsePercent collapses >100 to null (= empty),
  // so read the raw input to disambiguate WITHOUT touching the parser.
  const exceedsHundred =
    /^\d+(\.\d+)?$/.test(amountStr) && Number(amountStr) > 100;
  // A positive percent that rounds to 0 bps (sub-0.01%) would revert ZeroWeight
  // on chain — surface it explicitly instead of a silently-disabled button.
  const roundsToZeroBps = percent !== null && percent > 0 && additionalBps === 0;
  // The chain ACCEPTS a bps >= 1 that floors to 0 whole-LYTH effective weight,
  // but it's INERT (earns nothing / no vote) until the balance grows — warn +
  // block. The real minimum is balance-dependent (minNonInertBps).
  const inert =
    balanceLythoshi !== null && isInertDelegation(additionalBps, balanceLythoshi);
  const minBps = balanceLythoshi !== null ? minNonInertBps(balanceLythoshi) : null;

  const canContinue =
    percent !== null &&
    additionalBps > 0 &&
    !overCap &&
    !overGlobal &&
    !inert &&
    balanceLythoshi !== null;

  const [presetWarning, setPresetWarning] = useState<string | null>(null);

  const handleMax = () => {
    // Fill up to the BINDING headroom — the smaller of the per-cluster cap
    // headroom and the global 100%-of-balance headroom. Purely a bps fraction;
    // no balance math, because nothing is escrowed.
    setPresetWarning(null);
    onAmountChange((headroomBps / 100).toString());
  };

  // A quick-fill preset: enter it as-is when it fits the headroom; otherwise
  // clamp the INPUT to the headroom and surface a small warning (never
  // silently rewrite the intent).
  const handlePreset = (p: number) => {
    if (percentToBps(p) <= headroomBps) {
      setPresetWarning(null);
      onAmountChange(String(p));
    } else {
      setPresetWarning(
        `Only ${(headroomBps / 100).toFixed(2)}% left to delegate — set to max.`,
      );
      onAmountChange((headroomBps / 100).toString());
    }
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
          <button
            onClick={onBack}
            style={changeBtnStyle}
            {...hoverBg("rgba(255,255,255,0.04)")}
          >
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
            onChange={(e) => {
              setPresetWarning(null);
              onAmountChange(e.target.value.trim());
            }}
            placeholder="0"
            inputMode="decimal"
            style={amountInputStyle}
          />
          {[25, 50].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handlePreset(p)}
              style={{ ...inlineBtnStyle, padding: "8px 10px" }}
              {...hoverBg("rgba(255,255,255,0.04)")}
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
            {...hoverBg("rgba(255,255,255,0.04)")}
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
        <div style={fromHint}>
          {balanceLythoshi === null ? (
            "Balance loading…"
          ) : (
            <>
              {/* Live effective weight = balance × weightBps. */}
              effective weight{" "}
              <strong style={amountStrong}>
                {effectiveWeightLythoshi === null
                  ? "—"
                  : `${lythoshiToLyth(effectiveWeightLythoshi)} LYTH`}
              </strong>{" "}
              ({(additionalBps / 100).toFixed(2)}% of{" "}
              <strong style={amountStrongMuted}>
                {lythoshiToLyth(balanceLythoshi)} LYTH
              </strong>
              )
              {existingWeightBps > 0 && (
                <>
                  {" "}
                  · existing {(existingWeightBps / 100).toFixed(2)}%{" "}
                  <strong style={amountStrongMuted}>
                    ({lythoshiToLyth(
                      effectiveWeightWholeLythoshi(existingWeightBps, balanceLythoshi),
                    )}{" "}
                    LYTH)
                  </strong>{" "}
                  in this cluster
                </>
              )}
              {" "}
              · cap {(bindingCapBps / 100).toFixed(0)}%
            </>
          )}
        </div>
        <div style={liquidNote}>
          Your LYTH stays in your wallet and remains spendable — nothing is
          locked or sent to a delegation contract. The effective weight tracks
          your live balance at the next settlement.
        </div>
        {/* Limit/clamp warnings + the headroom line sit LAST in the card, right
            above the Continue action, so they're seen just before submitting. */}
        {overCap && (
          <div className="ext-warn-prominent">
            Delegation would exceed the {(bindingCapBps / 100).toFixed(0)}%
            per-wallet cap for one cluster by{" "}
            {((totalAfterBps - bindingCapBps) / 100).toFixed(2)}%.
          </div>
        )}
        {exceedsHundred && (
          <div className="ext-warn-prominent">
            Enter a percent between 0.01% and 100% of your balance.
          </div>
        )}
        {overGlobal && !overCap && (
          <div className="ext-warn-prominent">
            You can delegate at most {(globalHeadroomBps / 100).toFixed(2)}% more
            — total delegation across all clusters can&apos;t exceed 100%.
          </div>
        )}
        {presetWarning !== null && (
          <div className="ext-warn-prominent">{presetWarning}</div>
        )}
        {roundsToZeroBps && (
          <div className="ext-warn-prominent">
            Enter a larger percent — the minimum delegation weight is 0.01%.
          </div>
        )}
        {inert && !roundsToZeroBps && (
          <div className="ext-warn-prominent">
            Too small to delegate at your balance — minimum ≈ 1 LYTH
            {minBps !== null ? ` (≈ ${(minBps / 100).toFixed(2)}%)` : ""}. It
            won&apos;t earn until your balance grows.
          </div>
        )}
        {/* Active / remaining delegation headroom across ALL clusters — escalates
            to the prominent warn treatment only when fully delegated (0% left). */}
        <div
          className={headroomExhausted(globalHeadroomBps) ? "ext-warn-prominent" : undefined}
          style={headroomExhausted(globalHeadroomBps) ? undefined : fromHint}
        >
          {(totalDelegatedBps / 100).toFixed(2)}% delegated ·{" "}
          {(globalHeadroomBps / 100).toFixed(2)}% available
        </div>
      </div>

      {/* Continue */}
      <button
        className="ext-act prim-soft"
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
            : overGlobal
              ? "Reduce to available"
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
  transition: "background 120ms",
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
  transition: "background 120ms",
};

const fromHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 12,
  color: "var(--fg-500)",
  marginTop: 8,
  lineHeight: 1.5,
};

// Emphasized LYTH amounts inside the effective-weight hint — bigger + the
// wallet's mono numeric font so the figures stand out from the prose.
const amountStrong: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 14,
  color: "var(--gold)",
};

const amountStrongMuted: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 13,
  color: "var(--fg-200)",
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
