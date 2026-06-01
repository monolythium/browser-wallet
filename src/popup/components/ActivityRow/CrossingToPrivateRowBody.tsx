/// §25.4 public→private crossing. CHAIN-GATED — Sprintnet's indexer
/// does NOT emit `kind === "crossing"` (or equivalent) on
/// `lyth_getAddressActivity` sender-side today. This body never
/// instantiates at runtime on the current testnet; the union member
/// exists so the row renders automatically when the indexer ships
/// the kind. No wallet code change needed at that point.
///
/// The whitepaper §25.4 specifies a `CrossingEvent { amount,
/// sender_public_address, stealth_address }`. The recipient stealth
/// address is opaque (not derivable without view_sk) so the body
/// renders "to private space" rather than a counterparty.

import { Icon } from "../../Icon.js";
import { txTypeLabel } from "../../../shared/tx-type-label.js";
import type { CrossingToPrivateRow } from "../../../shared/activity.js";

export interface CrossingToPrivateRowBodyProps {
  row: CrossingToPrivateRow;
}

export function CrossingToPrivateRowBody({ row }: CrossingToPrivateRowBodyProps) {
  return (
    <div className="ext-act-row">
      <div className="dir out" style={{ position: "relative" }}>
        <Icon name="send" size={13} />
        <span
          aria-label="private"
          style={{
            position: "absolute",
            bottom: -2,
            right: -2,
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "var(--bg-100, #1a1a24)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="lock" size={8} />
        </span>
      </div>
      <div className="ext-act-row__main">
        <div className="ext-act-row__who">
          Sent {row.amountDecimal ?? "?"} LYTH to private space
        </div>
        <div className="ext-act-row__meta">
          <span>{txTypeLabel(row)}</span>
          <span>·</span>
          <span>block {row.blockHeight.toLocaleString("en-US")}</span>
          <span>·</span>
          <span>crossing</span>
        </div>
      </div>
      <div className="ext-act-row__right">
        <div className="amt">{row.amountDecimal ? `-${row.amountDecimal}` : "—"}</div>
        <div className="sym">LYTH</div>
      </div>
    </div>
  );
}
