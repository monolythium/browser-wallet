// Phase 1 — pure types + key builders + caps for the notifications feature.
//
// What this module owns
// =====================
// Pure shape contract for the notifications surface: types, storage-key
// builders, the cap constant + newest-first append helper, and tolerant
// parsers. No `chrome.*`, no DOM, no IPC, no module-scope state — every
// helper here is deterministic and unit-testable in vitest without
// browser shims.
//
// The `chrome.storage.local` round-trip lives in
// `src/background/notifications-store.ts`. The SW chokepoint hook (the
// only caller of `recordNotification` in Phase 1, per §0.4) lives in
// `src/background/service-worker.ts`.
//
// §0 invariants this module helps uphold
// ======================================
// §0.2 status fidelity: `NotificationRecord.status` is `"confirmed" |
//      "failed"`, mirroring the explicit receipt bit — never optimism.
// §0.5 dedupe by canonical inner tx hash: `notificationId` builds the
//      stable per-record key `${chainIdHex}:${txHash}` used both as the
//      record's `id` and the dedupe-set membership key.
// §0.6 local-only history with no secrets in the body: the record's
//      fields are exactly txHash / status / blockNumber / kind /
//      amountDecimal / counterparty / createdAtMs / read /
//      schemaVersion — nothing more.

/** Max notification records retained per (address, chain) — newest-first,
 *  capped via `appendCapped`. 50 covers months of normal use; older
 *  records are dropped silently on append. Matches the precedent set by
 *  `SENT_ADDRESSES_CAP = 500` in `sent-addresses.ts` (smaller because
 *  notifications fire only on terminal transitions, not every send). */
export const NOTIFICATION_HISTORY_CAP = 50;

/** Operation tag attached to a pending row at broadcast time (popup
 *  → IPC → SW handler → `persistPendingRowBackground`'s pending-row
 *  record). The Phase-1 notifications hook reads `row.opKind` and uses
 *  it verbatim as the resulting `NotificationRecord.kind`, which the
 *  toast / notification-center renders via {@link notificationTitle}
 *  to a friendly title.
 *
 *  CRITICAL invariant: `opKind` is **pending-row metadata only** — it
 *  is never plumbed into `submitEncryptedMlDsaTx`'s argument object and
 *  cannot affect the signed tx bytes, the ML-DSA-65 signature, the
 *  encrypted envelope, the nonce, the fee, or the gas. See the
 *  metadata-only invariant test in `service-worker.activity.test.ts`.
 *
 *  `contract_call` is the explicit fallback for untagged paths (legacy
 *  Phase-1 records on disk + any caller that omits `opKind`). */
export type TxOpKind =
  | "send"
  | "delegate"
  | "undelegate"
  | "redelegate"
  | "claim"
  | "complete-redemption"
  | "emergency-key"
  | "agent-policy"
  | "contract_call";

/** Runtime guard for `TxOpKind`. Used by the SW handler to coerce
 *  unknown / malformed literals (e.g. a future popup sending a kind we
 *  don't recognize) to a safe fallback rather than propagating
 *  garbage into the pending-row record. */
export function isTxOpKind(v: unknown): v is TxOpKind {
  return (
    v === "send" ||
    v === "delegate" ||
    v === "undelegate" ||
    v === "redelegate" ||
    v === "claim" ||
    v === "complete-redemption" ||
    v === "emergency-key" ||
    v === "agent-policy" ||
    v === "contract_call"
  );
}

/** One persisted notification — the row a Phase-3 list / detail-popup
 *  renders, and the row Phase-2's `chrome.notifications.create` derives
 *  its title + body from. Phase 1 only fills this shape; nothing reads
 *  it back yet outside of unit tests. */
export interface NotificationRecord {
  /** `${chainIdHex}:${txHash}` — also the dedupe-set membership key. */
  id: string;
  /** Canonical inner-tx hash (`innerTxHashHex` from
   *  `submitEncryptedMlDsaTx`). 0x-prefixed. */
  txHash: string;
  /** Real on-chain receipt status — explicit `1` ⇒ "confirmed",
   *  explicit `0` ⇒ "failed". Anything else upstream is treated as
   *  "kept" and never reaches this record (so this string is always
   *  one of these two literals — never silently coerced). */
  status: "confirmed" | "failed";
  /** Block number from the receipt (or matched `tx_send.blockHeight`
   *  for heuristic-matched sends). `null` on `lyth_txStatus="found"`
   *  fast-path or when the receipt didn't carry a parseable value. */
  blockNumber: number | null;
  /** Operation classification used to render the friendly title via
   *  {@link notificationTitle}. The Phase-1 hook prefers the pending row's
   *  broadcast-time `opKind` tag and falls back to the coarse `"send"`
   *  (step-1 heuristic match) / `"contract_call"` (step-2 status-RPC) for
   *  legacy / untagged rows. Both fallbacks are valid `TxOpKind` literals,
   *  so Phase-1 records already on disk parse and render unchanged. */
  kind: TxOpKind;
  /** Canonical 2-dp LYTH string — already the formatted decimal that
   *  the pending-row + confirmed-row sides share via the
   *  `shared/lyth-units.ts` formatter. NEVER a BigInt; chrome.storage
   *  serializes JSON only. */
  amountDecimal: string;
  /** Lowercase 0x counterparty — the `to` address from the
   *  pending-row (what the user intended to send to, or the precompile
   *  address for contract calls). */
  counterparty: string;
  /** Total tx fee in lythoshi (decimal string), captured at the confirmed
   *  terminal transition from `lyth_nativeReceipt.fee.total_lythoshi`
   *  (lythoshi, NOT wei). OPTIONAL + only set for confirmed self-paid txs
   *  with a non-zero fee: failed/reverted/pruned txs have no native receipt,
   *  and a zero-fee (near-zero-gas testnet) tx leaves it unset. Display
   *  formats it as `- <amount> LYTH`; absent ⇒ no fee line (no-mock).
   *  Migration-safe: records written before this field just omit it. */
  feeLythoshi?: string;
  /** Cluster a delegation tx (delegate / undelegate / redelegate) targeted,
   *  captured at send time from the pending row. `clusterId` is the numeric
   *  directory id; `clusterName` is the directory display name when known.
   *  There is NO `monok1` cluster address in the data model, so the detail
   *  surfaces name + #id (or just #id). Both optional; absent on non-delegation
   *  kinds + legacy records. */
  clusterId?: number;
  clusterName?: string;
  /** Epoch ms at the moment the SW observed the terminal transition.
   *  This is the notification's fire-time — distinct from the
   *  pending-row's `broadcastedAtMs` (which is broadcast time). */
  createdAtMs: number;
  /** Read state. `false` on insert; Phase 3's `markAllRead` flips
   *  per-scope. */
  read: boolean;
  /** Bump on shape change. */
  schemaVersion: 0;
}

/** Per-(address, chain) history blob persisted under
 *  `mono.notifications.history.<addrLower>.<chainIdHex>.v1`.
 *  Newest-first, capped. */
export interface NotificationsHistoryEnvelope {
  schemaVersion: 0;
  entries: NotificationRecord[];
}

/** Per-(address, chain) dedupe set persisted under
 *  `mono.notifications.notified.<addrLower>.<chainIdHex>.v1`. Stored as
 *  an array (not a `Set` — chrome.storage is JSON only) of
 *  `notificationId` strings. Kept separate from the history blob so a
 *  hypothetical "clear history" wouldn't lose dedupe state and re-fire
 *  for txs the user already saw. */
export interface NotifiedSetEnvelope {
  schemaVersion: 0;
  ids: string[];
}

/** Per-(address, chain) history key. */
export function notificationsHistoryKey(
  addressLower: string,
  chainIdHex: string,
): string {
  return `mono.notifications.history.${addressLower}.${chainIdHex}.v1`;
}

/** Per-(address, chain) dedupe-set key. */
export function notifiedSetKey(addressLower: string, chainIdHex: string): string {
  return `mono.notifications.notified.${addressLower}.${chainIdHex}.v1`;
}

/** Stable per-record id = dedupe-set membership key. `chainIdHex`
 *  disambiguates the same txHash across chains. */
export function notificationId(chainIdHex: string, txHash: string): string {
  return `${chainIdHex}:${txHash}`;
}

/** Insert a record newest-first and slice to the cap. Pure. */
export function appendCapped(
  entries: NotificationRecord[],
  record: NotificationRecord,
  cap: number = NOTIFICATION_HISTORY_CAP,
): NotificationRecord[] {
  const next = [record, ...entries];
  return next.length > cap ? next.slice(0, cap) : next;
}

function asNotificationStatus(v: unknown): "confirmed" | "failed" | undefined {
  return v === "confirmed" || v === "failed" ? v : undefined;
}

function asNotificationKind(v: unknown): TxOpKind | undefined {
  return isTxOpKind(v) ? v : undefined;
}

/** Friendly title strings for each operation kind × status. Phase 2's
 *  OS toast and Phase 3's notification-center row both call
 *  {@link notificationTitle} (the helper below) so the wording stays
 *  centralized here — no magic strings at the consumer sites. */
export const NOTIFICATION_LABELS: Record<
  TxOpKind,
  { confirmed: string; failed: string }
> = {
  send: { confirmed: "Sent", failed: "Send failed" },
  delegate: { confirmed: "Staked", failed: "Stake failed" },
  undelegate: { confirmed: "Unstaked", failed: "Unstake failed" },
  redelegate: { confirmed: "Restaked", failed: "Restake failed" },
  claim: { confirmed: "Rewards claimed", failed: "Claim failed" },
  "complete-redemption": {
    confirmed: "Redemption completed",
    failed: "Redemption failed",
  },
  "emergency-key": {
    confirmed: "Backup key registered",
    failed: "Backup registration failed",
  },
  "agent-policy": {
    confirmed: "Agent policy updated",
    failed: "Agent policy failed",
  },
  contract_call: {
    confirmed: "Transaction confirmed",
    failed: "Transaction failed",
  },
};

/** Render the friendly title for a notification. Used by Phase 2's toast
 *  (`chrome.notifications.create` title) and Phase 3's row title. */
export function notificationTitle(
  kind: TxOpKind,
  status: "confirmed" | "failed",
): string {
  return NOTIFICATION_LABELS[kind][status];
}

function asNotificationRecord(raw: unknown): NotificationRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = asNotificationStatus(r.status);
  const kind = asNotificationKind(r.kind);
  if (status === undefined || kind === undefined) return null;
  if (typeof r.id !== "string") return null;
  if (typeof r.txHash !== "string") return null;
  if (typeof r.amountDecimal !== "string") return null;
  if (typeof r.counterparty !== "string") return null;
  if (typeof r.createdAtMs !== "number" || !Number.isFinite(r.createdAtMs)) {
    return null;
  }
  if (typeof r.read !== "boolean") return null;
  const blockNumber =
    r.blockNumber === null
      ? null
      : typeof r.blockNumber === "number" && Number.isFinite(r.blockNumber)
        ? r.blockNumber
        : undefined;
  if (blockNumber === undefined) return null;
  // Optional fee — tolerate absent (legacy) + ignore a malformed value rather
  // than rejecting the whole record (the fee is non-essential metadata).
  const feeLythoshi =
    typeof r.feeLythoshi === "string" && /^[0-9]+$/.test(r.feeLythoshi)
      ? r.feeLythoshi
      : undefined;
  // Optional cluster metadata — tolerate absent + ignore malformed.
  const clusterId =
    typeof r.clusterId === "number" && Number.isFinite(r.clusterId)
      ? r.clusterId
      : undefined;
  const clusterName =
    typeof r.clusterName === "string" && r.clusterName.length > 0
      ? r.clusterName
      : undefined;
  return {
    id: r.id,
    txHash: r.txHash,
    status,
    blockNumber,
    kind,
    amountDecimal: r.amountDecimal,
    counterparty: r.counterparty,
    createdAtMs: r.createdAtMs,
    read: r.read,
    schemaVersion: 0,
    ...(feeLythoshi !== undefined ? { feeLythoshi } : {}),
    ...(clusterId !== undefined ? { clusterId } : {}),
    ...(clusterName !== undefined ? { clusterName } : {}),
  };
}

/** Tolerant parse of the per-scope history envelope. Malformed → null
 *  (caller treats as empty + heals on next write). Mirrors the posture of
 *  `parseSentAddresses` + `parseWalletUpdateCache`: garbage in, defensive
 *  default out. */
export function parseHistoryEnvelope(
  raw: unknown,
): NotificationsHistoryEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 0) return null;
  if (!Array.isArray(r.entries)) return null;
  const entries: NotificationRecord[] = [];
  for (const e of r.entries) {
    const rec = asNotificationRecord(e);
    if (rec !== null) entries.push(rec);
  }
  return { schemaVersion: 0, entries };
}

/** Tolerant parse of the per-scope dedupe-set envelope. */
export function parseNotifiedSetEnvelope(
  raw: unknown,
): NotifiedSetEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 0) return null;
  if (!Array.isArray(r.ids)) return null;
  const ids = r.ids.filter((x): x is string => typeof x === "string");
  return { schemaVersion: 0, ids };
}
