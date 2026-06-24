// Canonical, user-facing "type" vocabulary for an Activity/transaction row.
//
// One source of truth so the Activity detail popup (and any future surface)
// names a row by WHAT IT IS — direction + on-chain operation — instead of the
// developer-facing "tx index" / raw kind string. Confirmed-row direction is
// already encoded in the row KIND (`tx_send` = out, `tx_receive` = in, the
// delegation kinds, etc.), so this is a pure switch with no chain lookup.
//
// Vocabulary (present-tense nouns), aligned with `notificationTitle` in
// shared/notifications.ts:
//   Outgoing transfer · Incoming transfer · Token transfer · Delegate ·
//   Undelegate · Redelegate · Claim rewards · Redemption · Backup key · Agent policy ·
//   Contract call · Auto-rebalance · Private transfer · Transaction (fallback).
//
// "Transaction" is reserved for the genuinely-unclassifiable — a pending row
// with no recognisable opKind tag — never used to paper over a known kind.

import type { ActivityRow } from "./activity.js";
import type { TxOpKind } from "./notifications.js";

/** Friendly type label for the broadcast-time op tag carried on a pending row
 *  (and, in C4, on a NotificationRecord). Exported so the notification surface
 *  can label a record by the same vocabulary without re-deriving it. */
export function txTypeLabelForOpKind(opKind: TxOpKind | undefined): string {
  switch (opKind) {
    case "send":
      return "Outgoing transfer";
    case "receive":
      return "Incoming transfer";
    case "delegate":
      return "Delegate";
    case "undelegate":
      return "Undelegate";
    case "redelegate":
      return "Redelegate";
    case "claim":
      return "Claim rewards";
    case "complete-redemption":
      return "Redemption";
    case "emergency-key":
      return "Backup key";
    case "agent-policy":
      return "Agent policy";
    case "contract_call":
      return "Contract call";
    case undefined:
    default:
      // Untagged pending broadcast — the wallet only synthesizes pending rows
      // for its own outgoing txs, so "Outgoing transfer" is the honest default
      // (never the bare "Transaction").
      return "Outgoing transfer";
  }
}

/** Canonical type label for any rendered Activity row. */
export function txTypeLabel(row: ActivityRow): string {
  switch (row.kind) {
    case "pending_tx":
      return txTypeLabelForOpKind(row.opKind);
    case "tx_send":
      return "Outgoing transfer";
    case "tx_receive":
      return "Incoming transfer";
    case "token_transfer":
      return row.direction === "in"
        ? "Incoming transfer"
        : row.direction === "out"
          ? "Outgoing transfer"
          : "Token transfer";
    case "delegate":
      return "Delegate";
    case "undelegate":
      return "Undelegate";
    case "redelegate":
      return "Redelegate";
    case "rebalance":
      return "Auto-rebalance";
    case "crossing_to_private":
      return "Private transfer";
    case "claim":
      return "Claim rewards";
  }
}
