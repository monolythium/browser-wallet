// Phase 4.4 — typed activity-cache schema, row-kind union, and pure helpers
// shared between the service worker (which fetches + caches indexer data and
// writes synthetic pending rows on Send broadcast) and the popup (which reads
// the cache via chrome.storage.onChanged + IPC).
//
// Two storage keys per (address, chainId):
//   mono.activity.<addrLower>.<chainIdHex>            — confirmed-row cache
//   mono.activity.pending.<addrLower>.<chainIdHex>    — wallet-synthesized pending rows
//
// The split lets pending rows survive an indexer outage and lets each side be
// validated/evicted independently. Both keys round-trip through chrome.storage
// (structured-clone) so every field is plain JSON-clonable (no bigints).
//
// Row-kind union is the wallet's domain shape. We do NOT import the SDK's
// ts-rs bindings here for runtime use — the SW layer converts upstream RPC
// shapes (which nominally use bigint per AddressActivityEntry.ts etc., but
// arrive as plain numbers over the JSON-RPC wire) into the shapes defined
// below before persisting. The union stays extensible to §24 agent-commerce
// row types without redesign.
//
// Whitepaper alignment:
//   §22.7  — bech32m display happens at the popup render layer; cache stores
//            lowercase 0x form as the canonical identity.
//   §22.8  — naming enrichment happens via shared/name-resolution.ts; not in
//            this module.
//   §23.6  — delegation rows distinct from generic tx rows.
//   §23.7  — RebalanceRow kind reserved for future cap-tightening events.
//   §25.4  — CrossingToPrivateRow defined but never client-synthesized; only
//            renders when the indexer emits the kind on Sprintnet.

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Rolling window of confirmed rows kept in cache per (address, chainId). */
export const ACTIVITY_ROLLING_WINDOW = 100;

/** Pending-row TTL backstop: a synthetic pending row is dropped this long
 *  after broadcast regardless of whether a confirmed match was found.
 *  Five minutes covers slow blocks + bounded indexer lag; longer pending rows
 *  become user-confusing rather than informative. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** Heuristic match window for pending-row reconciliation: when a confirmed
 *  entry's blockHeight falls within ±this many blocks of the pending row's
 *  anchor and counterparty + amount + direction match, treat the pair as
 *  the same on-chain event and evict the pending row. ±10 at 3-second
 *  block cadence is ±30 seconds — wider than the gap between broadcast and
 *  block landing, narrower than a typical "user sends another identical tx"
 *  interval. */
export const PENDING_MATCH_BLOCK_WINDOW = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys
// ─────────────────────────────────────────────────────────────────────────────

/** Per-address, per-chain confirmed-row cache key. */
export function activityCacheKey(addressLower: string, chainIdHex: string): string {
  return `mono.activity.${addressLower}.${chainIdHex}`;
}

/** Per-address, per-chain pending-row cache key. */
export function activityPendingKey(addressLower: string, chainIdHex: string): string {
  return `mono.activity.pending.${addressLower}.${chainIdHex}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row-kind union
// ─────────────────────────────────────────────────────────────────────────────

/** Wallet-synthesized row for a just-broadcast Send. Reconciled against the
 *  confirmed stream by heuristic match (counterparty + amount + direction
 *  within PENDING_MATCH_BLOCK_WINDOW of the anchor), with PENDING_TTL_MS as
 *  the backstop. `broadcastBlockHeight` is null when the SW's async
 *  eth_blockNumber fetch failed — in that case only the TTL evicts. */
export interface PendingTxRow {
  kind: "pending_tx";
  txHash: string;
  to: string;                          // 0x address, lowercase
  amountDecimal: string;               // decimal LYTH (canonical lythoshi → decimal LYTH conversion)
  broadcastedAtMs: number;
  broadcastBlockHeight: number | null;
  via: string;                         // operator name that accepted the encrypted envelope
}

/** Common shape every confirmed row carries — the on-chain ordering key. */
interface ConfirmedAnchor {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
}

/** Native-LYTH send from the queried account. */
export interface TxSendRow extends ConfirmedAnchor {
  kind: "tx_send";
  counterparty: string | null;         // 0x address (lowercase) or null when unknown
  amountDecimal: string | null;        // decimal LYTH or null when not present on the source row
}

/** Native-LYTH receive to the queried account. */
export interface TxReceiveRow extends ConfirmedAnchor {
  kind: "tx_receive";
  counterparty: string | null;
  amountDecimal: string | null;
}

/** Token (non-native) transfer involving the queried account. */
export interface TokenTransferRow extends ConfirmedAnchor {
  kind: "token_transfer";
  direction: "in" | "out" | null;
  counterparty: string | null;
  tokenId: string;                     // 0x-hex 32-byte id
  amountDecimal: string | null;
}

/** Delegation event, surfaced canonically from lyth_getDelegationHistory.
 *  When only the activity stream has the event (no delegation-history match),
 *  the fallback mapper produces a DelegateRow with the same shape but may
 *  leave `weightBps === null` if AddressActivityEntry.weightBps was null. */
export interface DelegateRow extends ConfirmedAnchor {
  kind: "delegate";
  cluster: number;
  weightBps: number | null;
}

export interface UndelegateRow extends ConfirmedAnchor {
  kind: "undelegate";
  cluster: number;
  weightBps: number | null;
}

/** Redelegate carries source + destination cluster. When the row is mapped
 *  from the AddressActivityEntry fallback (no delegation-history match), the
 *  destination is unknown and `toCluster` is null — render layer handles. */
export interface RedelegateRow extends ConfirmedAnchor {
  kind: "redelegate";
  cluster: number;                     // source
  toCluster: number | null;            // destination (null only on activity-stream fallback)
  weightBps: number | null;
}

/** §23.7 auto-rebalance row — reserved for future cap-tightening events.
 *  The chain does not emit these today; kind is in the union for forward
 *  compatibility so the storage shape doesn't change when they land. */
export interface RebalanceRow extends ConfirmedAnchor {
  kind: "rebalance";
  weightBps: number | null;
}

/** §25.4 public→private crossing. Chain-gated: the Sprintnet indexer does
 *  not surface this kind on sender-side activity today. The row union ships
 *  the type so when the chain begins emitting it, no wallet code change is
 *  needed. */
export interface CrossingToPrivateRow extends ConfirmedAnchor {
  kind: "crossing_to_private";
  amountDecimal: string | null;
}

/** Union over every confirmed row kind (no pending). */
export type ConfirmedRow =
  | TxSendRow
  | TxReceiveRow
  | TokenTransferRow
  | DelegateRow
  | UndelegateRow
  | RedelegateRow
  | RebalanceRow
  | CrossingToPrivateRow;

/** Union over everything an `ActivityList` ever renders. */
export type ActivityRow = PendingTxRow | ConfirmedRow;

// ─────────────────────────────────────────────────────────────────────────────
// Cache shape
// ─────────────────────────────────────────────────────────────────────────────

/** Persisted shape under `mono.activity.<addr>.<chain>`. Confirmed rows are
 *  newest-first by (blockHeight, txIndex, logIndex). Pending rows live in
 *  a separate storage key (see activityPendingKey) so they can be written
 *  independently from the indexer-snapshot refresh cycle. */
export interface ActivityCache {
  confirmed: ConfirmedRow[];
  lastFetchedAtMs: number;
}

/** Persisted shape under `mono.activity.pending.<addr>.<chain>`. Always a
 *  short list (one entry per outstanding Send, evicted at PENDING_TTL_MS). */
export interface PendingActivityCache {
  pending: PendingTxRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}

/** Validate a single row (any kind). Returns the typed row on success, null
 *  on any structural failure. Defense-in-depth on top of SW-side validation. */
export function validateActivityRow(input: unknown): ActivityRow | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  switch (r.kind) {
    case "pending_tx":
      if (!isNonEmptyString(r.txHash)) return null;
      if (!isNonEmptyString(r.to)) return null;
      if (typeof r.amountDecimal !== "string") return null;
      if (!isFiniteNumber(r.broadcastedAtMs)) return null;
      if (!isNumberOrNull(r.broadcastBlockHeight)) return null;
      if (typeof r.via !== "string") return null;
      return {
        kind: "pending_tx",
        txHash: r.txHash,
        to: r.to,
        amountDecimal: r.amountDecimal,
        broadcastedAtMs: r.broadcastedAtMs,
        broadcastBlockHeight: r.broadcastBlockHeight,
        via: r.via,
      };

    case "tx_send":
    case "tx_receive": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isStringOrNull(r.counterparty)) return null;
      if (!isStringOrNull(r.amountDecimal)) return null;
      return {
        kind: r.kind,
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        counterparty: r.counterparty,
        amountDecimal: r.amountDecimal,
      };
    }

    case "token_transfer": {
      if (!validateConfirmedAnchor(r)) return null;
      if (r.direction !== "in" && r.direction !== "out" && r.direction !== null) {
        return null;
      }
      if (!isStringOrNull(r.counterparty)) return null;
      if (!isNonEmptyString(r.tokenId)) return null;
      if (!isStringOrNull(r.amountDecimal)) return null;
      return {
        kind: "token_transfer",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        direction: r.direction,
        counterparty: r.counterparty,
        tokenId: r.tokenId,
        amountDecimal: r.amountDecimal,
      };
    }

    case "delegate":
    case "undelegate": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isFiniteNumber(r.cluster)) return null;
      if (!isNumberOrNull(r.weightBps)) return null;
      return {
        kind: r.kind,
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        cluster: r.cluster,
        weightBps: r.weightBps,
      };
    }

    case "redelegate": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isFiniteNumber(r.cluster)) return null;
      if (!isNumberOrNull(r.toCluster)) return null;
      if (!isNumberOrNull(r.weightBps)) return null;
      return {
        kind: "redelegate",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        cluster: r.cluster,
        toCluster: r.toCluster,
        weightBps: r.weightBps,
      };
    }

    case "rebalance": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isNumberOrNull(r.weightBps)) return null;
      return {
        kind: "rebalance",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        weightBps: r.weightBps,
      };
    }

    case "crossing_to_private": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isStringOrNull(r.amountDecimal)) return null;
      return {
        kind: "crossing_to_private",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        amountDecimal: r.amountDecimal,
      };
    }

    default:
      return null;
  }
}

function validateConfirmedAnchor(r: Record<string, unknown>): boolean {
  return (
    isFiniteNumber(r.blockHeight) &&
    isFiniteNumber(r.txIndex) &&
    isFiniteNumber(r.logIndex)
  );
}

/** Validate the full ActivityCache shape (the value stored under the
 *  confirmed-row key). Returns null on any failure. Unknown rows in the
 *  list are dropped silently — partial data is preferred over null cache. */
export function validateActivityCache(input: unknown): ActivityCache | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNumber(r.lastFetchedAtMs)) return null;
  if (!Array.isArray(r.confirmed)) return null;
  const confirmed: ConfirmedRow[] = [];
  for (const raw of r.confirmed) {
    const row = validateActivityRow(raw);
    if (row && row.kind !== "pending_tx") confirmed.push(row);
  }
  return { confirmed, lastFetchedAtMs: r.lastFetchedAtMs };
}

/** Validate the pending-row cache shape. Returns null on any failure. */
export function validatePendingActivityCache(
  input: unknown,
): PendingActivityCache | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.pending)) return null;
  const pending: PendingTxRow[] = [];
  for (const raw of r.pending) {
    const row = validateActivityRow(raw);
    if (row && row.kind === "pending_tx") pending.push(row);
  }
  return { pending };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — wallet-internal raw shape → typed rows
// ─────────────────────────────────────────────────────────────────────────────

/** SW-internal shape after JSON-RPC parse + validation. Mirrors
 *  WalletAddressActivityRow in src/popup/bg.ts. Block heights are `number`
 *  on the wire even though the SDK's ts-rs binding labels them bigint. */
export interface RawAddressActivity {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  kind: string;
  direction: "in" | "out" | null;
  counterparty: string | null;
  tokenId: string | null;
  amount: string | null;               // decimal LYTH for native rows; token decimal for token rows
  cluster: number | null;
  weightBps: number | null;
  subKind: string | null;
}

/** SW-internal shape mirroring WalletDelegationHistoryRow in bg.ts. */
export interface RawDelegationHistory {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  wallet: string;
  cluster: number;
  toCluster: number | null;
  kind: string;
  weightBps: number;
  walletTotalBps: number | null;
}

/** Map the rich `lyth_getDelegationHistory` stream to the canonical delegation
 *  row kinds. This is the preferred source — when both streams surface the
 *  same on-chain event, mergeIndexerSnapshot uses these rows. */
export function mapDelegationHistoryToRows(
  entries: RawDelegationHistory[],
): Array<DelegateRow | UndelegateRow | RedelegateRow> {
  const out: Array<DelegateRow | UndelegateRow | RedelegateRow> = [];
  for (const e of entries) {
    switch (e.kind) {
      case "delegated":
        out.push({
          kind: "delegate",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          cluster: e.cluster,
          weightBps: e.weightBps,
        });
        break;
      case "undelegated":
        out.push({
          kind: "undelegate",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          cluster: e.cluster,
          weightBps: e.weightBps,
        });
        break;
      case "redelegated":
        out.push({
          kind: "redelegate",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          cluster: e.cluster,
          toCluster: e.toCluster,
          weightBps: e.weightBps,
        });
        break;
      default:
        // Unknown delegation kind — drop. Forward-compat: when a new kind
        // lands on chain (e.g. "rebalanced"), extend this switch + add a
        // row kind to the union.
        break;
    }
  }
  return out;
}

/** Map the unified `lyth_getAddressActivity` stream. Caller provides the set
 *  of (blockHeight, txIndex, logIndex) keys already represented in the
 *  delegation-history stream so this mapper can suppress duplicates.
 *  Unknown / unsupported kinds (swap, staking, etc.) are dropped — they're
 *  not part of Phase 4.4's render surface. */
export function mapAddressActivityToRows(
  entries: RawAddressActivity[],
  delegationKeys: Set<string>,
): ConfirmedRow[] {
  const out: ConfirmedRow[] = [];
  for (const e of entries) {
    const anchorKey = `${e.blockHeight}.${e.txIndex}.${e.logIndex}`;

    if (e.kind === "transfer") {
      if (e.tokenId !== null && e.tokenId.length > 0) {
        out.push({
          kind: "token_transfer",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          direction: e.direction,
          counterparty: e.counterparty,
          tokenId: e.tokenId,
          amountDecimal: e.amount,
        });
      } else if (e.direction === "out") {
        out.push({
          kind: "tx_send",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          counterparty: e.counterparty,
          amountDecimal: e.amount,
        });
      } else if (e.direction === "in") {
        out.push({
          kind: "tx_receive",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          counterparty: e.counterparty,
          amountDecimal: e.amount,
        });
      }
      // direction null + no tokenId — drop (shouldn't happen on a transfer).
      continue;
    }

    if (e.kind === "delegation") {
      // Dedupe per the Phase 4.4 plan: when the delegation-history stream
      // already has this anchor, drop the activity-stream copy (richer
      // fields live on the history-stream row). Otherwise produce a
      // fallback row from subKind.
      if (delegationKeys.has(anchorKey)) continue;
      if (e.cluster === null) continue;
      switch (e.subKind) {
        case "delegated":
          out.push({
            kind: "delegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            weightBps: e.weightBps,
          });
          break;
        case "undelegated":
          out.push({
            kind: "undelegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            weightBps: e.weightBps,
          });
          break;
        case "redelegated":
          out.push({
            kind: "redelegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            toCluster: null,             // activity stream doesn't carry destination
            weightBps: e.weightBps,
          });
          break;
        default:
          // Unknown subKind — drop.
          break;
      }
      continue;
    }

    // §25.4 — public→private crossing. Chain doesn't emit this on Sprintnet
    // today; the branch exists for forward compatibility. When/if the
    // indexer ships a "crossing" kind (or analogous), it renders without
    // a wallet update.
    if (e.kind === "crossing" || e.kind === "cross_to_private") {
      out.push({
        kind: "crossing_to_private",
        blockHeight: e.blockHeight,
        txIndex: e.txIndex,
        logIndex: e.logIndex,
        amountDecimal: e.amount,
      });
      continue;
    }

    // Other kinds (swap, staking, future unknowns) — not part of Phase 4.4
    // render surface. Drop silently to keep the union closed; future phases
    // extend the switch + the row union together.
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge / dedupe / eviction
// ─────────────────────────────────────────────────────────────────────────────

/** Newest-first comparator on (blockHeight, txIndex, logIndex). */
function compareConfirmedNewestFirst(a: ConfirmedRow, b: ConfirmedRow): number {
  if (a.blockHeight !== b.blockHeight) return b.blockHeight - a.blockHeight;
  if (a.txIndex !== b.txIndex) return b.txIndex - a.txIndex;
  return b.logIndex - a.logIndex;
}

/** Drop pending rows past the TTL backstop. */
export function evictExpiredPending(
  pending: PendingTxRow[],
  now: number,
): PendingTxRow[] {
  return pending.filter((p) => now - p.broadcastedAtMs < PENDING_TTL_MS);
}

/** Heuristic match: returns true when `confirmed` plausibly represents the
 *  same on-chain event as `pending`. Used to evict the pending row once the
 *  indexer surfaces the confirmation.
 *
 *  Match conditions (all required):
 *   - Confirmed row is `tx_send` (pending rows are always sends).
 *   - Counterparty matches (case-insensitive 0x address compare).
 *   - Amount decimal matches exactly.
 *   - Confirmed `blockHeight` is within ±PENDING_MATCH_BLOCK_WINDOW of the
 *     pending row's `broadcastBlockHeight` anchor. When the anchor is
 *     null (eth_blockNumber fetch failed), no heuristic match is possible
 *     and the TTL backstop is the sole eviction path. */
function pendingMatchesConfirmed(
  pending: PendingTxRow,
  confirmed: ConfirmedRow,
): boolean {
  if (confirmed.kind !== "tx_send") return false;
  if (pending.broadcastBlockHeight === null) return false;
  if (confirmed.counterparty === null) return false;
  if (confirmed.counterparty.toLowerCase() !== pending.to.toLowerCase()) {
    return false;
  }
  if (confirmed.amountDecimal !== pending.amountDecimal) return false;
  const delta = Math.abs(confirmed.blockHeight - pending.broadcastBlockHeight);
  return delta <= PENDING_MATCH_BLOCK_WINDOW;
}

/** Drop pending rows that have a matching confirmed entry in the freshly
 *  merged confirmed list. */
export function reconcilePending(
  pending: PendingTxRow[],
  confirmed: ConfirmedRow[],
): PendingTxRow[] {
  return pending.filter(
    (p) => !confirmed.some((c) => pendingMatchesConfirmed(p, c)),
  );
}

/** Build the dedupe key-set from delegation-history rows. Exposed for the
 *  SW handler / tests so they can drive mapAddressActivityToRows. */
export function delegationKeySet(
  rows: Array<DelegateRow | UndelegateRow | RedelegateRow>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    out.add(`${r.blockHeight}.${r.txIndex}.${r.logIndex}`);
  }
  return out;
}

/** Merge a fresh indexer snapshot into the previous cache. Pure function:
 *
 *  1. Map delegation-history rows (canonical source — full richness).
 *  2. Build dedupe key-set from those rows.
 *  3. Map address-activity rows, suppressing kind="delegation" entries
 *     whose anchor is already in the delegation-stream key-set.
 *  4. Sort merged confirmed list newest-first by (blockHeight, txIndex,
 *     logIndex). Within the merged list, an exact `(blockHeight, txIndex,
 *     logIndex)` collision is rare but possible — keep the first
 *     (delegation-history rows are pushed first, so they win).
 *  5. Cap at ACTIVITY_ROLLING_WINDOW newest rows. */
export function mergeIndexerSnapshot(
  fresh: {
    activity: RawAddressActivity[];
    delegation: RawDelegationHistory[];
  },
  now: number,
): ActivityCache {
  const delegationRows = mapDelegationHistoryToRows(fresh.delegation);
  const keys = delegationKeySet(delegationRows);
  const activityRows = mapAddressActivityToRows(fresh.activity, keys);

  const merged: ConfirmedRow[] = [];
  const seen = new Set<string>();
  for (const r of delegationRows) {
    const k = `${r.blockHeight}.${r.txIndex}.${r.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  for (const r of activityRows) {
    const k = `${r.blockHeight}.${r.txIndex}.${r.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  merged.sort(compareConfirmedNewestFirst);
  const capped = merged.slice(0, ACTIVITY_ROLLING_WINDOW);

  return { confirmed: capped, lastFetchedAtMs: now };
}
