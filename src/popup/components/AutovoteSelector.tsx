// AutovoteSelector. Renders the §23.9 four-button taxonomy
// as a 2×2 grid of mode pills with active-mode indicator + per-mode
// description tooltip. The whitepaper calls out the default-UI
// commitment: "the chain rewards diversification, and the wallet should
// make that the easy path" — so the visual hierarchy and copy frame
// Max Decentralization + Max Diversity above Max Yield, and Custom
// is rendered last as the advanced-user path.

import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { hoverBright } from "../hover";
import type { AutovoteMode } from "../../shared/autovote";

interface AutovoteSelectorProps {
  /** Currently-active mode. */
  mode: AutovoteMode;
  /** Called when the user selects a different pill. */
  onChange: (mode: AutovoteMode) => void;
  /** Optional: render in a compact one-row layout instead of 2×2 grid.
   *  The Stake page uses the full grid; the Delegations page may use
   *  the compact form. */
  compact?: boolean;
}

interface ModeMeta {
  mode: AutovoteMode;
  label: string;
  /** One-sentence rationale shown under the pill (hover-title attribute
   *  for compact mode). Phrased to match whitepaper §23.9 verbatim
   *  where possible. */
  description: string;
  iconHint: "stake" | "shield" | "settings" | "swap";
}

const MODES: ReadonlyArray<ModeMeta> = [
  {
    mode: "max-decentralization",
    label: "Max Decentralization",
    description:
      "Actively route delegation away from clusters with high correlated-preference scores, geographic concentration, or shared operator membership. Recommended default.",
    iconHint: "shield",
  },
  {
    mode: "max-diversity",
    label: "Max Diversity",
    description:
      "Spread allocation across as many independent clusters as the cap allows, weighted by reputation and uptime.",
    iconHint: "swap",
  },
  {
    mode: "max-yield",
    label: "Max Yield",
    description: "Allocate to the highest-APR clusters consistent with the per-cluster cap.",
    iconHint: "stake",
  },
  {
    mode: "custom",
    label: "Custom",
    description:
      "Manual per-cluster allocation. The wallet enforces the cap at submission time and warns before any out-of-policy distribution is signed.",
    iconHint: "settings",
  },
];

export function AutovoteSelector({
  mode,
  onChange,
  compact,
}: AutovoteSelectorProps) {
  const gridStyle: CSSProperties = compact
    ? { display: "flex", gap: 6, flexWrap: "wrap" }
    : { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Autovote</span>
        <span
          style={{
            fontSize: 9,
            color: "var(--fg-500)",
            letterSpacing: "0.08em",
            textTransform: "none",
          }}
          title="Per-user entropy in the autovote algorithm samples from the eligible bracket using a per-user seed derived from your ML-DSA-65 public key, so two delegators picking the same mode don't end up at the same cluster set."
        >
          per-user entropy
        </span>
      </div>
      <div style={gridStyle}>
        {MODES.map((m) => (
          <ModePill
            key={m.mode}
            meta={m}
            selected={m.mode === mode}
            onClick={() => onChange(m.mode)}
            compact={compact === true}
          />
        ))}
      </div>
    </div>
  );
}

interface ModePillProps {
  meta: ModeMeta;
  selected: boolean;
  onClick: () => void;
  compact: boolean;
}

function ModePill({ meta, selected, onClick, compact }: ModePillProps) {
  return (
    <button
      onClick={onClick}
      title={meta.description}
      {...hoverBright}
      style={{
        padding: compact ? "6px 10px" : "10px 12px",
        borderRadius: 10,
        border: selected
          ? "1px solid var(--gold)"
          : "1px solid var(--fg-700)",
        background: selected
          ? "var(--gold-bg)"
          : "rgba(255,255,255,0.03)",
        color: selected ? "var(--gold)" : "var(--fg-100)",
        cursor: "pointer",
        fontFamily: "var(--f-sans)",
        textAlign: "left",
        display: "flex",
        flexDirection: compact ? "row" : "column",
        gap: compact ? 6 : 4,
        alignItems: compact ? "center" : "flex-start",
        transition: "all 100ms var(--e-out)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={meta.iconHint} size={11} />
        <span style={{ fontSize: 11.5, fontWeight: 600 }}>{meta.label}</span>
      </div>
      {!compact && (
        <div
          style={{
            fontSize: 9.5,
            lineHeight: 1.4,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
            letterSpacing: "0.02em",
          }}
        >
          {meta.description}
        </div>
      )}
    </button>
  );
}
