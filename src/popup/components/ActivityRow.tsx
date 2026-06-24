// Top-level dispatch for ActivityRow rendering. Mirrors the
// approval-kind dispatch in components.tsx PendingShelf
// (switch (req.kind) → kind-specific view). Each body returns the
// same .ext-act-row grid structure so a uniform list height + column
// alignment hold regardless of row kind.
//
// Counterparty resolution is plumbed through from the parent. The
// dispatcher (and the bodies it routes to) treat:
//   undefined = "not yet resolved, render bech32m"
//   null      = "checked, no label, render bech32m"
//   record    = "render displayName + CategoryBadge"

import type { ReactNode } from "react";
import { CategoryBadge } from "./CategoryBadge.js";
import type { ActivityRow as ActivityRowType } from "../../shared/activity.js";
import { parseMonoName, type NameLabel } from "../../shared/name-resolution.js";
import { shortBech32m } from "../../shared/bech32m.js";
import { PendingTxRowBody } from "./ActivityRow/PendingTxRowBody.js";
import { TxSendRowBody } from "./ActivityRow/TxSendRowBody.js";
import { TxReceiveRowBody } from "./ActivityRow/TxReceiveRowBody.js";
import { TokenTransferRowBody } from "./ActivityRow/TokenTransferRowBody.js";
import { DelegateRowBody } from "./ActivityRow/DelegateRowBody.js";
import { UndelegateRowBody } from "./ActivityRow/UndelegateRowBody.js";
import { RedelegateRowBody } from "./ActivityRow/RedelegateRowBody.js";
import { RebalanceRowBody } from "./ActivityRow/RebalanceRowBody.js";
import { CrossingToPrivateRowBody } from "./ActivityRow/CrossingToPrivateRowBody.js";
import { ClaimRowBody } from "./ActivityRow/ClaimRowBody.js";

export interface ActivityRowProps {
  row: ActivityRowType;
  /** Resolved label for `row.counterparty` (or `row.to` on pending rows).
   *  `undefined` = not yet resolved, `null` = checked-no-label.
   *  Bodies that don't show a counterparty (delegate / rebalance /
   *  crossing) ignore this prop. */
  counterpartyLabel: NameLabel | undefined;
  /** Cluster directory (id → name) for the delegate/undelegate/redelegate
   *  bodies — resolves the numeric cluster id to its real name, else
   *  `Cluster #<id>` (no-mock). Other kinds ignore it. */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
}

export function ActivityRow({ row, counterpartyLabel, clusterNameById }: ActivityRowProps) {
  switch (row.kind) {
    case "pending_tx":
      return <PendingTxRowBody row={row} counterpartyLabel={counterpartyLabel} />;
    case "tx_send":
      return <TxSendRowBody row={row} counterpartyLabel={counterpartyLabel} />;
    case "tx_receive":
      return <TxReceiveRowBody row={row} counterpartyLabel={counterpartyLabel} />;
    case "token_transfer":
      return <TokenTransferRowBody row={row} counterpartyLabel={counterpartyLabel} />;
    case "delegate":
      return <DelegateRowBody row={row} clusterNameById={clusterNameById} />;
    case "undelegate":
      return <UndelegateRowBody row={row} clusterNameById={clusterNameById} />;
    case "redelegate":
      return <RedelegateRowBody row={row} clusterNameById={clusterNameById} />;
    case "rebalance":
      return <RebalanceRowBody row={row} />;
    case "crossing_to_private":
      return <CrossingToPrivateRowBody row={row} />;
    case "claim":
      return <ClaimRowBody row={row} />;
  }
}

// Shared helper used by TxSend / TxReceive / TokenTransfer to render
// a counterparty with optional CategoryBadge. The fallback is bech32m
// (truncated to 6 body chars) via shared/bech32m.ts:shortBech32m.
//
// Badge category resolution prefers §22.8 TLD when the displayName
// parses as a `.mono` hierarchical name (e.g. "treasury.contract.mono"
// renders with the TLD palette and "contract" badge); otherwise falls
// back to the indexer's pragmatic category (`label.category`). The two
// share "contract" so the visual is identical when both agree.
//
// Exported so the row body components can compose it; not part of the
// public hook surface.
export function renderCounterparty(
  addr: string | null,
  label: NameLabel | undefined,
): ReactNode {
  if (!addr) return "unknown";
  if (label && label.displayName) {
    const monoParse = parseMonoName(label.displayName);
    const badgeCategory = monoParse !== null ? monoParse.tld : label.category;
    return (
      <>
        {label.displayName}
        <CategoryBadge category={badgeCategory} />
      </>
    );
  }
  // Fallback: bech32m short form. shortBech32m handles non-0x input
  // defensively (returns the input unchanged); the indexer always
  // surfaces 0x form so this is the common path.
  try {
    return shortBech32m(addr, 6);
  } catch {
    return addr;
  }
}
