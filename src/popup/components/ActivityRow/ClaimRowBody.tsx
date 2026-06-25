// Confirmed reward-claim row (#3 / upstream #74): the indexer's
// `subKind:"claimed"` activity entry, mapped to a ClaimRow. Mirrors the
// receipt-bridged claim render in PendingTxRowBody (incoming / "receive",
// "Rewards claimed" + the claimed reward) so the durable indexer claim and the
// immediate local receipt-claim look consistent. The local copy auto-retires
// (applyLocalClaims) once this confirmed row appears at the same (block,
// txIndex), so the two never double-render.
//
// No fiat sibling: the indexer carries no captured rate/currency (unlike the
// local-claim, which froze them at claim time), and per the no-mock rule a
// missing rate renders nothing rather than a fabricated value.

import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import { formatLythDecimalDisplay } from "../../../shared/lyth-units.js";
import type { ClaimRow } from "../../../shared/activity.js";

export interface ClaimRowBodyProps {
  row: ClaimRow;
}

export function ClaimRowBody({ row }: ClaimRowBodyProps) {
  // The claimed reward in LYTH (the mapper already converted lythoshi → LYTH).
  // Treat null / "" / "0" as "no figure" — never render a fabricated 0.
  const figure =
    row.amountDecimal && row.amountDecimal !== "0" ? row.amountDecimal : null;
  const display = figure !== null ? formatLythDecimalDisplay(figure, 4) : null;
  const label = `Rewards claimed${display ? ` +${display} LYTH` : ""}`;
  return (
    <div className="ext-act-row">
      <div className="dir in">
        <Icon name="reward" size={13} />
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who" title={label}>
          {label}
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        {display !== null ? (
          <>
            <div className="amt in">+{display}</div>
            <div className="sym">LYTH</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
