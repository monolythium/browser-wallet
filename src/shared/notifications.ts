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
  /** Coarse classification at the chokepoint. Phase 1 emits "send" for
   *  rows matched by the indexer's `tx_send` reconcile path, and
   *  "contract_call" for rows dropped by the status-RPC path
   *  (delegate / undelegate / redelegate / claim / token transfers /
   *  emergency-key registration). Finer per-precompile classification
   *  is deferred to a later phase that decodes the calldata selector. */
  kind: "send" | "contract_call";
  /** Canonical 2-dp LYTH string — already the formatted decimal that
   *  the pending-row + confirmed-row sides share via the
   *  `shared/lyth-units.ts` formatter. NEVER a BigInt; chrome.storage
   *  serializes JSON only. */
  amountDecimal: string;
  /** Lowercase 0x counterparty — the `to` address from the
   *  pending-row (what the user intended to send to, or the precompile
   *  address for contract calls). */
  counterparty: string;
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

function asNotificationKind(v: unknown): "send" | "contract_call" | undefined {
  return v === "send" || v === "contract_call" ? v : undefined;
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
