// Typed activity-cache schema, row-kind union, and pure helpers
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
//            renders when the indexer emits the kind on the testnet.

import { bech32mToAddress } from "./bech32m.js";
import { lythoshiDecimalToLythDecimal } from "./lyth-units.js";
import { isCurrencyCode, type CurrencyCode } from "./iso4217.js";
import { isTxOpKind, type NotificationRecord, type TxOpKind } from "./notifications.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Rolling window of confirmed rows kept in cache per (address, chainId). */
export const ACTIVITY_ROLLING_WINDOW = 100;

/** Pending-row TTL backstop: a synthetic pending row is dropped this long
 *  after broadcast regardless of whether a confirmed match was found.
 *  Five minutes covers slow blocks + bounded indexer lag; longer pending rows
 *  become user-confusing rather than informative.
 *  DEPRECATED for non-claim rows: the blind TTL silently dropped txs slower
 *  than 5 min (the ~7-8 min undelegate). Superseded by the nonce+receipt
 *  lifecycle (`transitionPending`/`classifyStalePending`); retained only for the
 *  legacy `evictExpiredPending` shim + its tests. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** A pending row past this age (with no terminal receipt/indexer verdict) is
 *  flagged "taking longer than usual" — a hint, not a removal. */
export const PENDING_SLOW_MS = 3 * 60 * 1000;

/** Debounce before declaring a nonce-passed row `dropped`: the committed nonce
 *  advancing past the row's nonce can momentarily race a confirming receipt
 *  (nonce advanced, receipt lagging). Require the nonce-passed-without-receipt
 *  condition to persist this long (≈2 polls) before the `dropped` verdict, so a
 *  just-confirmed tx surfaces its receipt within the grace instead of a wrong
 *  terminal. MUST be paired with a persisted `noncePassedAtMs` (else the grace
 *  re-stamps every poll and never elapses). */
export const PENDING_DROP_GRACE_MS = 30 * 1000;

/** Absolute last-resort cap: a row that never reaches a receipt/indexer/nonce
 *  verdict transitions to a VISIBLE `expired` ("status unknown") state — far
 *  longer than the old 5 min, and a state, not a silent vanish. */
export const PENDING_ABSOLUTE_CAP_MS = 45 * 60 * 1000;

/** Bounded display window for a TERMINAL (`dropped`/`expired`) row: it stays
 *  VISIBLE as its terminal state until this age, then is removed (the user can
 *  also dismiss it sooner). A `pending`/`slow` row is NEVER removed by this —
 *  removal only ever follows an explicit terminal verdict + this generous
 *  window, so a possibly-live tx never vanishes. */
export const PENDING_TERMINAL_RETAIN_MS = 60 * 60 * 1000;

/** Cap on the durable local-claim store per (address, chainId). Reward claims
 *  are infrequent manual actions, so a small newest-N window bounds the store
 *  without ever evicting a recent claim. Distinct from ACTIVITY_ROLLING_WINDOW
 *  (which caps confirmed rows only). */
export const LOCAL_CLAIMS_CAP = 50;

/** Heuristic match window for pending-row reconciliation: when a confirmed
 *  entry's blockHeight falls within ±this many blocks of the pending row's
 *  anchor and counterparty + amount match, treat the pair as the same on-chain
 *  event and evict the pending row. The testnet produces fast blocks
 *  ~0.3 s apart (measured), so the gap between the broadcast anchor and the
 *  inclusion block — plus the indexer's materialization delay before the row
 *  is queryable — spans many more blocks than the old ±10 (≈3 s here) allowed,
 *  which left a receipt-confirmed pending row unmatched (and lingering until
 *  the 30 s alarm). ±300 ≈ ±90 s of blocks: comfortably covers broadcast →
 *  indexed while staying far narrower than a "user re-sends the identical
 *  amount to the same address" interval. */
export const PENDING_MATCH_BLOCK_WINDOW = 300;

/** Indexer sentinel for native LYTH (`Hash::ZERO`, indexer commit 3537b135).
 *  A transfer carrying this tokenId is native LYTH, not an MRC-20 token. */
export const NATIVE_LYTH_TOKEN_ID = "0x" + "00".repeat(32);

/** True when a transfer's tokenId denotes native LYTH — `null`, empty, or
 *  all-zero hex of any length — rather than a real MRC-20 token id. */
export function isNativeLythTokenId(tokenId: string | null): boolean {
  if (tokenId === null) return true;
  const body = tokenId.toLowerCase().replace(/^0x/, "");
  return body.length === 0 || /^0+$/.test(body);
}

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

/** Per-address, per-chain durable local-claim store key. Reward-claim rows are
 *  never emitted by the indexer (verification 2026-06-20), so the wallet keeps
 *  its own record here, scoped exactly like the two caches above. */
export function activityLocalClaimsKey(addressLower: string, chainIdHex: string): string {
  return `mono.activity.localclaims.${addressLower}.${chainIdHex}`;
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
  /** Phase-1.5 broadcast-time operation tag. Threaded from the popup
   *  through the SW handler into this row PURELY as metadata for the
   *  notifications hook — never part of the signed tx. Optional: rows
   *  written before this field existed (legacy Phase-1) and any
   *  untagged caller leave it undefined, in which case the hook falls
   *  back to the coarse `send` / `contract_call` classification. An
   *  unknown literal arriving at the validator is coerced to the
   *  fallback `"contract_call"`. */
  opKind?: TxOpKind;
  /** Cluster targeted by a delegation tx (delegate / undelegate / redelegate),
   *  captured from the Stake send flow PURELY as notification metadata — never
   *  part of the signed tx. `clusterId` is the numeric directory id; there is
   *  no `monok1` cluster address in the data model, so `clusterName` carries
   *  the directory display name when known. Both optional + absent on
   *  non-delegation sends and legacy rows. */
  clusterId?: number;
  clusterName?: string;
  /** Redelegate DESTINATION cluster (`clusterId`/`clusterName` above are the
   *  SOURCE). Captured at send PURELY as notification metadata so the toast can
   *  show `<from> → <to>` — there is no cluster directory at notify-time (the
   *  activity row, by contrast, resolves the destination from the live
   *  directory). Absent on non-redelegate sends + legacy rows. */
  toClusterId?: number;
  toClusterName?: string;
  /** Set once the tx is confirmed via the real-time receipt (the inclusion
   *  block from `eth_getTransactionReceipt`) but BEFORE the indexer has
   *  surfaced the canonical confirmed row. Presence flips the row's render
   *  from "Pending" to a confirmed send, so a confirm shows at chain speed
   *  instead of sitting on "Pending" through the indexer's materialization
   *  delay. The row is dropped (replaced by the indexer's canonical row) once
   *  reconcilePending matches it; this field is the precise match anchor. */
  confirmedBlockHeight?: number;
  /** Receipt `tx_index` of the confirmed tx — paired with confirmedBlockHeight
   *  it pins the exact inclusion slot, so reconcilePending can match the
   *  indexer's canonical row by (block, txIndex) for ANY kind (transfer OR
   *  delegate / undelegate / redelegate), not just `tx_send`. */
  confirmedTxIndex?: number;
  /** Marks a wallet-local durable reward-claim record (vs an ordinary in-flight
   *  send). Set ONLY on claim rows. Routes render to `claimedAmount` and exempts
   *  the row from the 5-min pending TTL (evictExpiredPending). Metadata-only;
   *  the indexer emits no claim event (verification 2026-06-20) so this is the
   *  sole persistent claim marker. */
  source?: "local-claim";
  /** Claimed reward, decimal LYTH, captured popup-side from
   *  `settledPendingLythoshi` at claim time (the chain/indexer never surface it;
   *  a claim's `amountDecimal` is "0"). null = unavailable (rewards mock/offline)
   *  → render shows bare "Rewards claimed", no figure (no-mock). */
  claimedAmount?: string | null;
  /** LYTH→fiat rate frozen at claim time (getLythFiatRate; null until the oracle
   *  ships). Stored so confirmed-history fiat survives every indexer rebuild;
   *  null → the fiat sibling renders the honest dash, never a fabricated value. */
  rateAtClaim?: number | null;
  /** Display currency the rate was captured in (loadDisplayCurrency) — frozen so
   *  the historic fiat renders in the currency selected at claim time. */
  currency?: CurrencyCode;
  /** Delegation weight (bps) for a delegate/undelegate/redelegate, captured at
   *  submit PURELY as display/notification metadata (the signed tx is
   *  byte-identical — this is NOT re-encoded). Delegate/redelegate carry the
   *  requested weight; undelegate carries the FULL existing weight being removed
   *  (`existingWeightBps`). Lets the row/notification show the % (bps/100). Absent
   *  on claims, ordinary sends, and legacy rows → the % is omitted (no-mock). */
  delegationWeightBps?: number;
  /** The nonce this tx was broadcast with — the nonce was ALREADY chosen +
   *  signed at send (`nextNonceHex` is untouched), and is persisted here PURELY
   *  for the pending-row drop-detection lifecycle (a committed-nonce read past
   *  this value, with no receipt, means the tx was replaced/dropped). NEVER
   *  re-signed, never part of the signed bytes. Absent on legacy rows + any
   *  non-`wallet-send-tx` broadcast path → that row falls back to the time-only
   *  lifecycle states. */
  nonce?: number;
  /** Drop-detection debounce stamp: the epoch-ms the poll FIRST observed the
   *  committed nonce had passed this row's `nonce` with no receipt. The `dropped`
   *  verdict only fires once `now - noncePassedAtMs >= PENDING_DROP_GRACE_MS`, so
   *  this MUST survive the storage round-trip (else it re-stamps to `now` every
   *  poll and the grace never elapses). Display/state only. */
  noncePassedAtMs?: number;
  /** Recomputed each poll by `transitionPending` from the row's nonce + the
   *  committed-nonce read + age — drives the render label. `dropped`/`expired`
   *  are VISIBLE terminal states (never a silent vanish). Display/state only;
   *  persisting it is harmless (it is recomputed regardless). */
  lifecycle?: PendingLifecycle;
}

/** Pending-row lifecycle (display/state). Primary terminal verdict is a receipt
 *  or an indexer match (handled in the SW poll); these are the *time/nonce*
 *  states for a row that has neither yet. */
export type PendingLifecycle = "pending" | "slow" | "dropped" | "expired";

function isPendingLifecycle(v: unknown): v is PendingLifecycle {
  return v === "pending" || v === "slow" || v === "dropped" || v === "expired";
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
  /** Cumulative staked principal (lythoshi) the indexer reports for this event —
   *  `principalLythoshi` on the delegation-history stream, `amount` on the
   *  activity stream (identical per event). Used ONLY as a same-block dedup
   *  discriminator: the indexer hardcodes txIndex/logIndex to 0, so two
   *  delegations in one block share the (block,txIndex,logIndex) anchor; this
   *  monotonic value splits them. "" when the indexer omits it — degrades to the
   *  pre-fix collapse, never a duplicate (cross-stream dedup stays on the
   *  contracted anchor+kind, not this field). */
  principalLythoshi: string;
  /** Real `*.cluster.mono` name the wallet captured at send time (threaded
   *  off the matching pending row by `applyCapturedClusterNames`). The indexer
   *  stream carries only the numeric `cluster` id (§C — no name field, no
   *  reverse-resolver in mono-core), so this is the ONLY source of a real name
   *  for a confirmed row, and only for txs THIS wallet originated. Absent for
   *  non-originated (indexer-only) stakes → render falls back to `Cluster #id`.
   *  Never fabricated. */
  clusterName?: string;
}

export interface UndelegateRow extends ConfirmedAnchor {
  kind: "undelegate";
  cluster: number;
  weightBps: number | null;
  /** Same-block dedup discriminator; see DelegateRow.principalLythoshi. */
  principalLythoshi: string;
  /** Send-time `*.cluster.mono` name; see DelegateRow.clusterName. */
  clusterName?: string;
}

/** Redelegate carries source + destination cluster. When the row is mapped
 *  from the AddressActivityEntry fallback (no delegation-history match), the
 *  destination is unknown and `toCluster` is null — render layer handles. */
export interface RedelegateRow extends ConfirmedAnchor {
  kind: "redelegate";
  cluster: number;                     // source
  toCluster: number | null;            // destination (null only on activity-stream fallback)
  weightBps: number | null;
  /** Same-block dedup discriminator; see DelegateRow.principalLythoshi. */
  principalLythoshi: string;
  /** Send-time name of the SOURCE `cluster` (redelegate captures the source per
   *  commit 7dbb4ea); see DelegateRow.clusterName. The destination `toCluster`
   *  has no captured name. */
  clusterName?: string;
}

/** §23.7 auto-rebalance row — reserved for future cap-tightening events.
 *  The chain does not emit these today; kind is in the union for forward
 *  compatibility so the storage shape doesn't change when they land. */
export interface RebalanceRow extends ConfirmedAnchor {
  kind: "rebalance";
  weightBps: number | null;
}

/** §25.4 public→private crossing. Chain-gated: the testnet indexer does
 *  not surface this kind on sender-side activity today. The row union ships
 *  the type so when the chain begins emitting it, no wallet code change is
 *  needed. */
export interface CrossingToPrivateRow extends ConfirmedAnchor {
  kind: "crossing_to_private";
  amountDecimal: string | null;
}

/** Reward-claim event, surfaced from the indexer's `subKind:"claimed"` activity
 *  entry (#3 / upstream #74). `amountDecimal` is the CLAIMED REWARD in decimal
 *  LYTH (the native LYTH the precompile moved — NOT the staked principal),
 *  converted from the raw `amount` lythoshi. `cluster` is metadata only (the
 *  chain reports 0 for claims — they aggregate across the wallet's stake, so it
 *  is not a render target). The wallet's local receipt-decoded claim is the
 *  immediate reveal; this confirmed row is the durable one, and the local copy
 *  auto-retires via applyLocalClaims once it appears at the same (block,
 *  txIndex). */
export interface ClaimRow extends ConfirmedAnchor {
  kind: "claim";
  amountDecimal: string | null;
  cluster?: number;
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
  | CrossingToPrivateRow
  | ClaimRow;

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

/** Persisted shape under `mono.activity.localclaims.<addr>.<chain>`. The wallet's
 *  durable reward-claim rows (pending_tx-kind, `source:"local-claim"`). The
 *  indexer emits no claim event, so this is the only persistent claim record;
 *  capped to LOCAL_CLAIMS_CAP newest by `broadcastedAtMs`. */
export interface LocalClaimsCache {
  claims: PendingTxRow[];
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
    case "pending_tx": {
      if (!isNonEmptyString(r.txHash)) return null;
      if (!isNonEmptyString(r.to)) return null;
      if (typeof r.amountDecimal !== "string") return null;
      if (!isFiniteNumber(r.broadcastedAtMs)) return null;
      if (!isNumberOrNull(r.broadcastBlockHeight)) return null;
      if (typeof r.via !== "string") return null;
      // Phase-1.5 — `opKind` is optional. Coerce an unknown / non-string
      // literal to the fallback `"contract_call"` so a future schema
      // mismatch or a buggy caller produces a coarse-but-valid record
      // instead of dropping the row. Absent stays absent (legacy Phase-1
      // rows + untagged paths fall back at the hook).
      let opKind: TxOpKind | undefined;
      if (r.opKind !== undefined) {
        opKind = isTxOpKind(r.opKind) ? r.opKind : "contract_call";
      }
      // Cluster metadata (delegation sends). Optional; drop malformed values
      // rather than rejecting the whole row — it's non-essential metadata.
      const clusterId = isFiniteNumber(r.clusterId) ? r.clusterId : undefined;
      const clusterName =
        typeof r.clusterName === "string" && r.clusterName.length > 0
          ? r.clusterName
          : undefined;
      const toClusterId = isFiniteNumber(r.toClusterId) ? r.toClusterId : undefined;
      const toClusterName =
        typeof r.toClusterName === "string" && r.toClusterName.length > 0
          ? r.toClusterName
          : undefined;
      // Receipt-confirmed-but-not-yet-indexed marker (the inclusion block + tx
      // index — the precise, kind-agnostic match anchor against the indexer).
      const confirmedBlockHeight = isFiniteNumber(r.confirmedBlockHeight)
        ? r.confirmedBlockHeight
        : undefined;
      const confirmedTxIndex = isFiniteNumber(r.confirmedTxIndex)
        ? r.confirmedTxIndex
        : undefined;
      // Local-claim marker + captured claim fields (the reward-claim store).
      // MANDATORY here — without carrying these the fields are silently dropped
      // on every cache (de)serialization rebuild. Coerce/drop malformed values
      // rather than rejecting the row, exactly mirroring the metadata idiom above.
      const source = r.source === "local-claim" ? "local-claim" : undefined;
      const claimedAmount =
        typeof r.claimedAmount === "string" || r.claimedAmount === null
          ? r.claimedAmount
          : undefined;
      const rateAtClaim = isFiniteNumber(r.rateAtClaim)
        ? r.rateAtClaim
        : r.rateAtClaim === null
          ? null
          : undefined;
      const currency = isCurrencyCode(r.currency) ? r.currency : undefined;
      const delegationWeightBps =
        isFiniteNumber(r.delegationWeightBps) ? r.delegationWeightBps : undefined;
      // Drop-detection lifecycle fields (display/state). `nonce` is captured at
      // broadcast; `noncePassedAtMs` MUST survive so the debounce grace can
      // elapse across polls (else it re-stamps to `now` and `dropped` never
      // fires). `lifecycle` is recomputed each poll but survives harmlessly.
      const nonce = isFiniteNumber(r.nonce) ? r.nonce : undefined;
      const noncePassedAtMs = isFiniteNumber(r.noncePassedAtMs)
        ? r.noncePassedAtMs
        : undefined;
      const lifecycle = isPendingLifecycle(r.lifecycle) ? r.lifecycle : undefined;
      return {
        kind: "pending_tx",
        txHash: r.txHash,
        to: r.to,
        amountDecimal: r.amountDecimal,
        broadcastedAtMs: r.broadcastedAtMs,
        broadcastBlockHeight: r.broadcastBlockHeight,
        via: r.via,
        ...(opKind !== undefined ? { opKind } : {}),
        ...(clusterId !== undefined ? { clusterId } : {}),
        ...(clusterName !== undefined ? { clusterName } : {}),
        ...(toClusterId !== undefined ? { toClusterId } : {}),
        ...(toClusterName !== undefined ? { toClusterName } : {}),
        ...(confirmedBlockHeight !== undefined ? { confirmedBlockHeight } : {}),
        ...(confirmedTxIndex !== undefined ? { confirmedTxIndex } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(claimedAmount !== undefined ? { claimedAmount } : {}),
        ...(rateAtClaim !== undefined ? { rateAtClaim } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(delegationWeightBps !== undefined ? { delegationWeightBps } : {}),
        ...(nonce !== undefined ? { nonce } : {}),
        ...(noncePassedAtMs !== undefined ? { noncePassedAtMs } : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {}),
      };
    }

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
      // Optional send-time cluster name (threaded onto confirmed rows by
      // applyCapturedClusterNames, then round-tripped through the cache). Drop
      // a malformed/empty value rather than rejecting the row — non-essential.
      const clusterName =
        typeof r.clusterName === "string" && r.clusterName.length > 0
          ? r.clusterName
          : undefined;
      return {
        kind: r.kind,
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        cluster: r.cluster,
        weightBps: r.weightBps,
        principalLythoshi:
          typeof r.principalLythoshi === "string" ? r.principalLythoshi : "",
        ...(clusterName !== undefined ? { clusterName } : {}),
      };
    }

    case "redelegate": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isFiniteNumber(r.cluster)) return null;
      if (!isNumberOrNull(r.toCluster)) return null;
      if (!isNumberOrNull(r.weightBps)) return null;
      const clusterName =
        typeof r.clusterName === "string" && r.clusterName.length > 0
          ? r.clusterName
          : undefined;
      return {
        kind: "redelegate",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        cluster: r.cluster,
        toCluster: r.toCluster,
        weightBps: r.weightBps,
        principalLythoshi:
          typeof r.principalLythoshi === "string" ? r.principalLythoshi : "",
        ...(clusterName !== undefined ? { clusterName } : {}),
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

    case "claim": {
      if (!validateConfirmedAnchor(r)) return null;
      if (!isStringOrNull(r.amountDecimal)) return null;
      const cluster = isFiniteNumber(r.cluster) ? r.cluster : undefined;
      return {
        kind: "claim",
        blockHeight: r.blockHeight as number,
        txIndex: r.txIndex as number,
        logIndex: r.logIndex as number,
        amountDecimal: r.amountDecimal,
        ...(cluster !== undefined ? { cluster } : {}),
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

/** Validate the durable local-claim store. Each entry is a `pending_tx` row
 *  tagged `source:"local-claim"`; anything else is dropped. Caps to the newest
 *  LOCAL_CLAIMS_CAP by `broadcastedAtMs` so the store can't grow unboundedly
 *  (claims are infrequent; the cap never trims a recent one). Returns null on
 *  any structural failure. */
export function validateLocalClaimsCache(input: unknown): LocalClaimsCache | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.claims)) return null;
  const claims: PendingTxRow[] = [];
  for (const raw of r.claims) {
    const row = validateActivityRow(raw);
    if (row && row.kind === "pending_tx" && row.source === "local-claim") {
      claims.push(row);
    }
  }
  claims.sort((a, b) => b.broadcastedAtMs - a.broadcastedAtMs);
  return { claims: claims.slice(0, LOCAL_CLAIMS_CAP) };
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
  amount: string | null;               // raw lythoshi for native rows (mapper converts to decimal LYTH); token base units for token rows
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
  /** Cumulative staked principal (lythoshi). On the live wire (verified
   *  2026-06-28) but not yet in the SDK `DelegationHistoryRecord` contract —
   *  optional, read defensively as a same-block dedup discriminator only. */
  principalLythoshi?: string | null;
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
          principalLythoshi: e.principalLythoshi ?? "",
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
          principalLythoshi: e.principalLythoshi ?? "",
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
          principalLythoshi: e.principalLythoshi ?? "",
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
 *  not part of the current render surface. */
export function mapAddressActivityToRows(
  entries: RawAddressActivity[],
  delegationKeys: Set<string>,
): ConfirmedRow[] {
  const out: ConfirmedRow[] = [];
  for (const e of entries) {
    if (e.kind === "transfer") {
      // Native LYTH arrives with a zero (Hash::ZERO) or null tokenId — route it
      // to tx_send/tx_receive by direction. Only a real (non-zero) MRC-20 token
      // id becomes a token_transfer row.
      if (e.tokenId !== null && e.tokenId.length > 0 && !isNativeLythTokenId(e.tokenId)) {
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
          amountDecimal:
            e.amount === null ? null : lythoshiDecimalToLythDecimal(e.amount),
        });
      } else if (e.direction === "in") {
        out.push({
          kind: "tx_receive",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          counterparty: e.counterparty,
          amountDecimal:
            e.amount === null ? null : lythoshiDecimalToLythDecimal(e.amount),
        });
      }
      // direction null + no tokenId — drop (shouldn't happen on a transfer).
      continue;
    }

    if (e.kind === "delegation") {
      // Reward claim (#3 / upstream #74): the indexer surfaces it as
      // subKind:"claimed" with the claimed reward in `amount` (decimal lythoshi
      // — the native LYTH moved, NOT the staked principal). Handled FIRST: a
      // claim carries cluster:0 (not a real delegation target), so it must never
      // be dropped for "lacking" a cluster, and delegation-history never surfaces
      // claims, so a claim is never a cross-stream duplicate (never suppressed —
      // even when it shares a block with a real delegation).
      if (e.subKind === "claimed") {
        out.push({
          kind: "claim",
          blockHeight: e.blockHeight,
          txIndex: e.txIndex,
          logIndex: e.logIndex,
          amountDecimal:
            e.amount === null ? null : lythoshiDecimalToLythDecimal(e.amount),
          ...(e.cluster !== null ? { cluster: e.cluster } : {}),
        });
        continue;
      }
      if (e.cluster === null) continue;
      // Canonical confirmed-row kind (matches mapDelegationHistoryToRows).
      const kind =
        e.subKind === "delegated"
          ? ("delegate" as const)
          : e.subKind === "undelegated"
            ? ("undelegate" as const)
            : e.subKind === "redelegated"
              ? ("redelegate" as const)
              : null;
      if (kind === null) continue; // unknown subKind — drop
      // Cross-stream dedupe on the CONTRACTED anchor + kind: when the richer
      // delegation-history stream already carries this event, drop the
      // activity-stream copy. Kind-aware (vs the old anchor-only check) so a
      // same-block cross-kind pair — e.g. a delegate + an undelegate the indexer
      // reports at the same hardcoded txIndex/logIndex (always 0) — is no longer
      // mutually suppressed.
      if (
        delegationKeys.has(`${e.blockHeight}.${e.txIndex}.${e.logIndex}.${kind}`)
      ) {
        continue;
      }
      // `amount` is the cumulative staked principal (== history principalLythoshi);
      // captured as the same-block dedup discriminator (see DelegateRow).
      const principalLythoshi = e.amount ?? "";
      switch (kind) {
        case "delegate":
          out.push({
            kind: "delegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            weightBps: e.weightBps,
            principalLythoshi,
          });
          break;
        case "undelegate":
          out.push({
            kind: "undelegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            weightBps: e.weightBps,
            principalLythoshi,
          });
          break;
        case "redelegate":
          out.push({
            kind: "redelegate",
            blockHeight: e.blockHeight,
            txIndex: e.txIndex,
            logIndex: e.logIndex,
            cluster: e.cluster,
            toCluster: null,             // activity stream doesn't carry destination
            weightBps: e.weightBps,
            principalLythoshi,
          });
          break;
      }
      continue;
    }

    // §25.4 — public→private crossing. Chain doesn't emit this on the testnet
    // today; the branch exists for forward compatibility. When/if the
    // indexer ships a "crossing" kind (or analogous), it renders without
    // a wallet update.
    if (e.kind === "crossing" || e.kind === "cross_to_private") {
      out.push({
        kind: "crossing_to_private",
        blockHeight: e.blockHeight,
        txIndex: e.txIndex,
        logIndex: e.logIndex,
        amountDecimal:
          e.amount === null ? null : lythoshiDecimalToLythDecimal(e.amount),
      });
      continue;
    }

    // Other kinds (swap, staking, future unknowns) — not part of the current
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

/** Drop pending rows past the TTL backstop. Durable reward-claim rows
 *  (`source:"local-claim"`) are EXEMPT — they are a persistent record, not an
 *  in-flight tx, and the indexer never surfaces a claim to reconcile them away
 *  (verification 2026-06-20). The exemption is claim-rows-ONLY: an ordinary
 *  pending row still evicts at PENDING_TTL_MS (this is a SEPARATE edit from the
 *  validator field-survival — C1). */
export function evictExpiredPending(
  pending: PendingTxRow[],
  now: number,
): PendingTxRow[] {
  return pending.filter(
    (p) => p.source === "local-claim" || now - p.broadcastedAtMs < PENDING_TTL_MS,
  );
}

/** Classify a still-pending row (one that has NO terminal receipt and NO indexer
 *  match yet — the caller applies those first) into its time/nonce lifecycle.
 *  PURE: the committed nonce + receipt verdicts are read by the SW poll and
 *  passed in. Never removes a row; only labels it.
 *
 *  - claim rows are EXEMPT (durable) — the caller skips them; this returns
 *    `pending` defensively.
 *  - `committedNonce > row.nonce` (both known) → the nonce was consumed by a
 *    DIFFERENT tx and this row has no receipt → it was replaced/dropped. Gated by
 *    `PENDING_DROP_GRACE_MS` via `noncePassedAtMs` (the returned value the caller
 *    persists) so a confirming-receipt race resolves first: within the grace →
 *    `slow`; past it → `dropped`.
 *  - `committedNonce === null` (count RPC failed) or `nonce` unknown or
 *    `committedNonce <= row.nonce` (incl. a nonce gap) → NEVER `dropped`; falls
 *    to the time-only states (`expired` past the absolute cap, else `slow` past
 *    the slow threshold, else `pending`), and any stale `noncePassedAtMs` is
 *    cleared (a regressed/un-passed nonce is no longer "passed"). */
export function classifyStalePending(
  row: PendingTxRow,
  committedNonce: number | null,
  now: number,
): { status: PendingLifecycle; noncePassedAtMs?: number } {
  if (row.source === "local-claim") return { status: "pending" };
  const noncePassed =
    committedNonce !== null &&
    row.nonce !== undefined &&
    committedNonce > row.nonce;
  if (noncePassed) {
    // Stamp the clock the first poll observed; a later poll past the grace → dropped.
    const since = row.noncePassedAtMs ?? now;
    if (now - since >= PENDING_DROP_GRACE_MS) {
      return { status: "dropped", noncePassedAtMs: since };
    }
    return { status: "slow", noncePassedAtMs: since };
  }
  // A failed committed-nonce read (null) is NO evidence the tx came back: never
  // ADVANCE to dropped, but also never REGRESS a verdict already reached (a null
  // pass would otherwise un-drop a dropped row and persist it on writeback). A
  // REAL read that is <= the row nonce (a genuine re-org regression) DOES un-drop
  // — it falls through to the time-only states below and clears the stamp.
  if (committedNonce === null && row.lifecycle === "dropped") {
    return row.noncePassedAtMs !== undefined
      ? { status: "dropped", noncePassedAtMs: row.noncePassedAtMs }
      : { status: "dropped" };
  }
  const age = now - row.broadcastedAtMs;
  if (age >= PENDING_ABSOLUTE_CAP_MS) return { status: "expired" };
  if (age >= PENDING_SLOW_MS) return { status: "slow" };
  return { status: "pending" };
}

/** Transition every pending row to its lifecycle state (replaces the blind
 *  `evictExpiredPending` TTL). NEVER removes a `pending`/`slow` row — the core
 *  "never silently vanish" guarantee. A TERMINAL (`dropped`/`expired`) row is
 *  retained as a VISIBLE terminal until `PENDING_TERMINAL_RETAIN_MS` (then
 *  removed; the user can dismiss sooner), so removal only ever follows an
 *  explicit terminal verdict + a generous window. Claim rows are passed through
 *  untouched (durable). `committedNonce` is the SW's committed-nonce read this
 *  poll (`null` when the RPC failed → time-only states, never `dropped`). */
export function transitionPending(
  pending: PendingTxRow[],
  committedNonce: number | null,
  now: number,
): PendingTxRow[] {
  const out: PendingTxRow[] = [];
  for (const row of pending) {
    // Durable claims (exempt) and receipt-bridged rows (already terminal-
    // confirmed; the render shows them as confirmed regardless of lifecycle) are
    // passed through untouched — drop-detection applies only to rows with no
    // terminal verdict yet.
    if (row.source === "local-claim" || row.confirmedBlockHeight !== undefined) {
      out.push(row);
      continue;
    }
    const { status, noncePassedAtMs } = classifyStalePending(row, committedNonce, now);
    const isTerminal = status === "dropped" || status === "expired";
    if (isTerminal && now - row.broadcastedAtMs >= PENDING_TERMINAL_RETAIN_MS) {
      continue; // bounded removal of a long-visible terminal row
    }
    const next: PendingTxRow = { ...row, lifecycle: status };
    // Set the fresh debounce stamp, or clear a stale one (a regressed/un-passed
    // nonce is no longer "passed").
    if (noncePassedAtMs !== undefined) {
      next.noncePassedAtMs = noncePassedAtMs;
    } else {
      delete next.noncePassedAtMs;
    }
    out.push(next);
  }
  return out;
}

/** True when a local-claim's reward amount is NOT yet resolved. `claimedAmount`
 *  is decoded from the Claimed log only on a later reconcile (it is null at
 *  broadcast), so the App's reconcile poll counts such a claim as "pending" to
 *  keep the poll armed until the reconcile fills the amount. Once the amount is
 *  known the claim is a durable record (excluded from the poll), so the poll
 *  disarms — no forever-poll. */
export function localClaimAwaitingAmount(row: PendingTxRow): boolean {
  return (
    row.source === "local-claim" &&
    (row.claimedAmount === null || row.claimedAmount === undefined)
  );
}

/** Sticky local-claim layer (mirrors applyCapturedClusterNames): a reward-claim
 *  row originates locally (its amount is decoded from the receipt's Claimed log)
 *  and bridges the pre-confirm window, so re-inject the durable claim rows into
 *  the pending list each poll so they survive a lost pending-cache copy. Returns
 *  claims (newest source-of-truth) followed by the untouched non-claim pending
 *  rows.
 *
 *  Two-phase dedup (C2):
 *   - INTRA-STORE identity: union the durable claims with any claim copy already
 *     resident in `pending` (the broadcast-written, receipt-bridged copy),
 *     deduped by `txHash`; the pending-resident copy wins (it carries the
 *     freshest receipt-bridge (block,txIndex) anchor).
 *   - CROSS-STREAM (anchored): drop a claim once the indexer surfaces a CONFIRMED
 *     row at its bridged inclusion slot — matched by the `(blockHeight, txIndex)`
 *     ANCHOR, never `txHash` (confirmed rows + the SDK AddressActivityEntry
 *     carry no txHash). LIVE since 2026-06-24 (the indexer now ships claim
 *     events WITH the amount): the local copy auto-retires with no double-row;
 *     `applyStickyClaimAmount` carries the amount onto a null-amount confirmed
 *     row so the retire never drops it.
 *   - CROSS-STREAM (backstop, no anchor): a precompile claim's receipt can lag
 *     the indexer (or never be retrievable), so the `(block,txIndex)` anchor may
 *     never land — and the indexer's confirmed `kind:"claim"` row has no txHash
 *     to link back. So ALSO retire an UN-anchored claim once a NEWLY-surfaced
 *     confirmed claim row matches it by the broadcast-block window
 *     (`backstopRetiredClaimTxHashes`, 1:1 nearest-block). Without this the
 *     "Pending · Rewards claimed" row strands beside the confirmed `+amount ·
 *     block` row until a reopen/alarm.
 *
 *  `priorConfirmed` (the confirmed rows from BEFORE this snapshot) scopes the
 *  backstop to claim rows that just appeared — without it a STALE row from an
 *  already-retired prior claim could window-match and VANISH a brand-new claim
 *  (claim rows carry no txHash to disambiguate). Defaults to `[]` (every claim
 *  row treated as new) for callers that don't track a prior snapshot. */
export function applyLocalClaims(
  pending: PendingTxRow[],
  localClaims: PendingTxRow[],
  confirmed: ConfirmedRow[],
  priorConfirmed: ConfirmedRow[] = [],
): PendingTxRow[] {
  const nonClaim = pending.filter((p) => p.source !== "local-claim");
  const byHash = new Map<string, PendingTxRow>();
  for (const c of localClaims) {
    if (c.source === "local-claim") byHash.set(c.txHash, c);
  }
  for (const p of pending) {
    if (p.source === "local-claim") byHash.set(p.txHash, p);
  }
  const all = [...byHash.values()];
  // Un-anchored claims a NEWLY-surfaced confirmed claim row matched by the
  // broadcast-block window. Computed across ALL claims at once so the 1:1
  // pairing holds (one confirmed row retires at most one claim).
  const backstopRetired = backstopRetiredClaimTxHashes(all, confirmed, priorConfirmed);
  const claims = all.filter((c) => {
    // Anchored retire (existing): the indexer surfaced a confirmed row at the
    // receipt-bridged (block, txIndex) slot.
    const anchoredRetire =
      c.confirmedBlockHeight !== undefined &&
      c.confirmedTxIndex !== undefined &&
      confirmed.some(
        (r) =>
          r.blockHeight === c.confirmedBlockHeight &&
          r.txIndex === c.confirmedTxIndex,
      );
    return !(anchoredRetire || backstopRetired.has(c.txHash));
  });
  return [...claims, ...nonClaim];
}

/** Backstop retirement for UN-ANCHORED local-claims (no `confirmedBlockHeight`).
 *  A precompile reward claim's receipt can lag the indexer or never be
 *  retrievable, so the `(block,txIndex)` receipt anchor — the only key the
 *  anchored retire uses — may never land; and the indexer's confirmed
 *  `kind:"claim"` row carries NO txHash to link it back. So pair each confirmed
 *  claim row to AT MOST ONE pending claim by broadcast-block within
 *  `PENDING_MATCH_BLOCK_WINDOW` (the same window the tx_send heuristic uses),
 *  assigned GLOBALLY nearest-first (not per-claim-in-order, so a farther claim
 *  can't grab a nearer claim's row). The 1:1 pairing stops two concurrent claims
 *  from BOTH being retired by a single confirmed row (which would make the second
 *  VANISH until the indexer surfaces its own row). Confirmed rows already consumed by an ANCHORED claim
 *  are reserved first (that claim retires precisely by its slot, not here). A
 *  claim with a null `broadcastBlockHeight` (eth_blockNumber failed at send) has
 *  no window to match — it falls to the anchored path / TTL only, as tx_send
 *  does. Returns the set of claim txHashes to retire via the backstop.
 *
 *  `priorConfirmed` scopes the eligible confirmed rows to those NEWLY surfaced
 *  this snapshot (not already present before the fetch): a claim's own row is
 *  new on the tick it first appears, while a stale row from an already-retired
 *  prior claim is excluded — so a wide ±window can't cross-retire (vanish) an
 *  unrelated new claim against an old row. */
function backstopRetiredClaimTxHashes(
  claims: PendingTxRow[],
  confirmed: ConfirmedRow[],
  priorConfirmed: ConfirmedRow[],
): Set<string> {
  const priorClaimAnchors = new Set(
    priorConfirmed
      .filter((r) => r.kind === "claim")
      .map((r) => `${r.blockHeight}.${r.txIndex}`),
  );
  const confirmedClaims = confirmed.filter(
    (r) =>
      r.kind === "claim" &&
      !priorClaimAnchors.has(`${r.blockHeight}.${r.txIndex}`),
  );
  if (confirmedClaims.length === 0) return new Set();
  // Reserve the confirmed-claim rows already matched by an anchored claim's
  // exact (block, txIndex) — they retire that claim, not an un-anchored one.
  const used = new Set<number>();
  for (const c of claims) {
    if (c.confirmedBlockHeight === undefined || c.confirmedTxIndex === undefined) {
      continue;
    }
    const i = confirmedClaims.findIndex(
      (r) =>
        r.blockHeight === c.confirmedBlockHeight &&
        r.txIndex === c.confirmedTxIndex,
    );
    if (i >= 0) used.add(i);
  }
  // Build every in-window (claim, confirmed-row) pair, then assign GLOBALLY
  // nearest-first (smallest block delta), each claim + each row used at most
  // once. Global-nearest — not per-claim-in-order — so a farther claim can't
  // grab a nearer claim's row and leave that claim stranded (or wrongly retired).
  const unanchored = claims.filter(
    (c) => c.confirmedBlockHeight === undefined && c.broadcastBlockHeight !== null,
  );
  const candidates: Array<{ txHash: string; rowIdx: number; delta: number }> = [];
  for (const c of unanchored) {
    for (let i = 0; i < confirmedClaims.length; i++) {
      if (used.has(i)) continue; // reserved by an anchored claim
      const delta = Math.abs(confirmedClaims[i]!.blockHeight - c.broadcastBlockHeight!);
      if (delta <= PENDING_MATCH_BLOCK_WINDOW) {
        candidates.push({ txHash: c.txHash, rowIdx: i, delta });
      }
    }
  }
  // Nearest first; ties broken by row index for determinism.
  candidates.sort((a, b) => a.delta - b.delta || a.rowIdx - b.rowIdx);
  const retired = new Set<string>();
  const claimUsed = new Set<string>();
  for (const cand of candidates) {
    if (used.has(cand.rowIdx) || claimUsed.has(cand.txHash)) continue;
    used.add(cand.rowIdx);
    claimUsed.add(cand.txHash);
    retired.add(cand.txHash);
  }
  return retired;
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
/** Normalize an address for matching. The indexer returns a confirmed row's
 *  counterparty as BECH32M (`mono…`), while a pending row's `to` is the 0x EVM
 *  address it was broadcast with — so a raw string compare never matched and
 *  reconcilePending never evicted a confirmed pending row (it lingered until
 *  the 30 s alarm). Convert both to lowercase 0x before comparing; anything
 *  unparseable falls back to its lowercased self. */
function normalizeAddrForMatch(a: string): string {
  if (a.startsWith("0x") || a.startsWith("0X")) return a.toLowerCase();
  try {
    return bech32mToAddress(a, null).toLowerCase();
  } catch {
    return a.toLowerCase();
  }
}

/** ONE-SIDED block-window match for the pending→confirmed heuristics. A real
 *  confirmation is at/after its own broadcast, so the confirmed block must be
 *  `>= broadcastBlockHeight` AND within `PENDING_MATCH_BLOCK_WINDOW` after it.
 *  The old SYMMETRIC `Math.abs(...)` window also matched a STALE confirmed row
 *  BEFORE the broadcast — a prior same-cluster+weight delegation (C3 over-match)
 *  or a prior same-recipient+amount send (the pre-existing tx_send hole) — which
 *  retired the brand-new pending row instantly (a false-confirm; the row never
 *  showed as pending). A confirmation cannot precede its broadcast, so the
 *  window is one-sided. */
function withinForwardMatchWindow(
  confirmedBlockHeight: number,
  broadcastBlockHeight: number,
): boolean {
  const delta = confirmedBlockHeight - broadcastBlockHeight;
  return delta >= 0 && delta <= PENDING_MATCH_BLOCK_WINDOW;
}

function pendingMatchesConfirmed(
  pending: PendingTxRow,
  confirmed: ConfirmedRow,
): boolean {
  // Bridged (receipt-confirmed) row with a precise inclusion slot: match the
  // indexer's canonical row by exact (block, txIndex), regardless of KIND. A
  // delegate / undelegate / redelegate (or claim) surfaces as a delegation row,
  // NEVER a tx_send, so the counterparty/amount heuristic below could never
  // retire it — it would linger until the 30 s alarm. The (block, txIndex)
  // pair uniquely identifies the wallet's own tx in its activity stream.
  if (
    pending.confirmedBlockHeight !== undefined &&
    pending.confirmedTxIndex !== undefined
  ) {
    return (
      confirmed.blockHeight === pending.confirmedBlockHeight &&
      confirmed.txIndex === pending.confirmedTxIndex
    );
  }
  // Heuristic match for not-yet-confirmed rows (the indexer-first path).
  // tx_send rows use counterparty + amount + window (below). Delegation rows
  // (delegate/undelegate/redelegate) surface as delegation rows, never tx_send,
  // so without a backstop they retire ONLY via the receipt-bridge (above) — a
  // confirmed-but-receipt-missed delegation would then be mis-flagged `dropped`
  // by the drop-detection lifecycle. The CONSERVATIVE delegation heuristic
  // (C3 — the interlock) lets the indexer retire it: kind-family + cluster
  // (+ destination/weight when both known) + block window. Never matches on an
  // ambiguous null → no false retirement.
  if (confirmed.kind !== "tx_send") {
    if (isDelegationRow(confirmed) && pendingIsSameDelegation(pending, confirmed)) {
      return true;
    }
    return false;
  }
  if (pending.broadcastBlockHeight === null) return false;
  if (confirmed.counterparty === null) return false;
  if (
    normalizeAddrForMatch(confirmed.counterparty) !==
    normalizeAddrForMatch(pending.to)
  ) {
    return false;
  }
  if (confirmed.amountDecimal !== pending.amountDecimal) return false;
  // One-sided window: a confirmation is at/after its own broadcast, so a STALE
  // prior send (same recipient + amount) BEFORE this broadcast no longer matches
  // (pre-existing symmetric-window hole, fixed alongside the C3 delegation one).
  return withinForwardMatchWindow(confirmed.blockHeight, pending.broadcastBlockHeight);
}

/** Conservative match between a pending delegation send and a confirmed
 *  delegation row — the C3 backstop in `pendingMatchesConfirmed` that closes the
 *  tx_send-only heuristic gap. Requires the kind FAMILY to agree
 *  (`opKind` === confirmed `kind`), the SOURCE cluster id to match (both known),
 *  and the confirmed block to fall within `PENDING_MATCH_BLOCK_WINDOW` of the
 *  broadcast anchor. The redelegate destination and the weight are matched ONLY
 *  when BOTH sides know them (the activity-stream fallback leaves
 *  `confirmed.toCluster` / `confirmed.weightBps` null → skip, never reject) — so
 *  a null never causes a false retirement. */
function pendingIsSameDelegation(
  pending: PendingTxRow,
  confirmed: DelegateRow | UndelegateRow | RedelegateRow,
): boolean {
  if (pending.opKind !== confirmed.kind) return false;
  if (pending.clusterId === undefined) return false;
  if (pending.clusterId !== confirmed.cluster) return false;
  if (pending.broadcastBlockHeight === null) return false;
  // ONE-SIDED window: a real confirmation is at/after the broadcast, so a STALE
  // prior confirmed delegation to the same cluster + weight that confirmed
  // BEFORE this broadcast no longer matches (the symmetric abs-window let a
  // re-delegate to the same cluster retire instantly against a prior stake).
  if (!withinForwardMatchWindow(confirmed.blockHeight, pending.broadcastBlockHeight)) {
    return false;
  }
  // Destination cluster (redelegate) — match only when BOTH are known.
  if (
    confirmed.kind === "redelegate" &&
    pending.toClusterId !== undefined &&
    confirmed.toCluster !== null &&
    pending.toClusterId !== confirmed.toCluster
  ) {
    return false;
  }
  // Weight — match only when BOTH are known.
  if (
    pending.delegationWeightBps !== undefined &&
    confirmed.weightBps !== null &&
    pending.delegationWeightBps !== confirmed.weightBps
  ) {
    return false;
  }
  return true;
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

/** Within-stream dedup / React identity key for a confirmed row. Delegation
 *  rows append the per-event `principalLythoshi` so two delegations the indexer
 *  reports at the SAME (blockHeight, txIndex, logIndex) anchor — it hardcodes
 *  txIndex and logIndex to 0, so the anchor degrades to blockHeight alone —
 *  don't collapse into one row. Non-delegation rows keep the anchor+kind key (a
 *  self-transfer's in/out legs share the u32::MAX logIndex sentinel and are
 *  split by kind). Empty `principalLythoshi` (indexer omitted it) degrades to
 *  the pre-fix collapse, never a duplicate. */
export function confirmedRowDedupKey(r: ConfirmedRow): string {
  const base = `${r.blockHeight}.${r.txIndex}.${r.logIndex}.${r.kind}`;
  // Delegations: fold in every distinguishing per-event field (cluster, the
  // redelegate destination, weight, and the principal) so two genuinely distinct
  // same-block events collapse only when the indexer reports them as truly
  // identical — robust even if the principal alone happens to tie.
  if (r.kind === "delegate" || r.kind === "undelegate") {
    return `${base}.${r.cluster}.${r.weightBps}.${r.principalLythoshi}`;
  }
  if (r.kind === "redelegate") {
    return `${base}.${r.cluster}.${r.toCluster}.${r.weightBps}.${r.principalLythoshi}`;
  }
  return base;
}

/** Build the cross-stream suppression key-set from delegation-history rows.
 *  Exposed for the SW handler / tests so they can drive mapAddressActivityToRows. */
export function delegationKeySet(
  rows: Array<DelegateRow | UndelegateRow | RedelegateRow>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    // Anchor + KIND (both contracted) — the cross-stream suppression key. The
    // per-event principal is deliberately NOT included here: keying suppression
    // on it would make cross-stream dedup depend on an uncontracted wire field
    // (history principalLythoshi), risking DUPLICATE rows if the indexer ever
    // dropped it. Same-block splitting is done within-stream by
    // confirmedRowDedupKey (merge + render), which degrades to a harmless
    // collapse — never a duplicate — when the principal is absent.
    out.add(`${r.blockHeight}.${r.txIndex}.${r.logIndex}.${r.kind}`);
  }
  return out;
}

/** True for the three delegation-family confirmed rows (the ones that carry an
 *  optional captured cluster name). */
function isDelegationRow(
  r: ConfirmedRow,
): r is DelegateRow | UndelegateRow | RedelegateRow {
  return r.kind === "delegate" || r.kind === "undelegate" || r.kind === "redelegate";
}

/** Thread the real `*.cluster.mono` name a delegation tx captured at send time
 *  onto its confirmed indexer row. The indexer stream has NO cluster name (§C:
 *  `cluster` is a numeric id only, and mono-core ships no name-registry /
 *  reverse-resolver), so without this a confirmed delegate/undelegate/redelegate
 *  row loses the name its pending row held and the render falls back to a bare
 *  `Cluster #id`. The confirmed cache is rebuilt from the indexer on every
 *  non-fresh poll, so the name must be made STICKY across rebuilds — hence two
 *  sources, `prevConfirmed` first:
 *   - `prevConfirmed`: a delegation row at the same (blockHeight, txIndex) that
 *     already carries a name (survives the rebuild after reconcilePending has
 *     dropped the pending row).
 *   - `pending`: a bridged pending row whose receipt slot
 *     (confirmedBlockHeight, confirmedTxIndex) matches — the first-confirmation
 *     capture, before any named cache exists.
 *  Matched by the exact (blockHeight, txIndex) inclusion slot — the same key
 *  pendingMatchesConfirmed uses (one tx = one slot = one delegation row).
 *  METADATA-ONLY: never touches signed bytes. A confirmed row that already has
 *  a name (e.g. the prevConfirmed copy carried in) is left untouched. */
export function applyCapturedClusterNames(
  confirmed: ConfirmedRow[],
  prior: { pending?: PendingTxRow[]; confirmed?: ConfirmedRow[] },
): ConfirmedRow[] {
  const pending = prior.pending ?? [];
  const prevConfirmed = prior.confirmed ?? [];
  if (pending.length === 0 && prevConfirmed.length === 0) return confirmed;
  return confirmed.map((row) => {
    if (!isDelegationRow(row) || row.clusterName !== undefined) return row;
    // Match on the (block, txIndex) inclusion slot AND the cluster: the indexer
    // hardcodes txIndex to 0, so two same-block delegations share the slot —
    // without the cluster guard the SAME name would be threaded onto both (and a
    // cross-cluster pair mislabelled). The (source) cluster is the disambiguator.
    const prevNamed = prevConfirmed.find(
      (p): p is DelegateRow | UndelegateRow | RedelegateRow =>
        isDelegationRow(p) &&
        p.clusterName !== undefined &&
        p.blockHeight === row.blockHeight &&
        p.txIndex === row.txIndex &&
        p.cluster === row.cluster,
    );
    const pendNamed = pending.find(
      (p) =>
        p.clusterName !== undefined &&
        p.confirmedBlockHeight === row.blockHeight &&
        p.confirmedTxIndex === row.txIndex &&
        p.clusterId === row.cluster,
    );
    const name = prevNamed?.clusterName ?? pendNamed?.clusterName;
    return name !== undefined ? { ...row, clusterName: name } : row;
  });
}

/** Thread a known claim amount onto a confirmed `ClaimRow` whose indexer
 *  `amountDecimal` is null. Mirrors applyCapturedClusterNames: the indexer can
 *  surface a confirmed claim row (subKind:"claimed") a beat BEFORE it decodes
 *  the Claimed-log amount, and applyLocalClaims retires the amount-bearing
 *  local-claim on the (block,txIndex) anchor ALONE — so without this the amount
 *  blinks out until a reopen re-fetches the decoded value. Two sticky sources,
 *  prevConfirmed first:
 *   - `prevConfirmed`: a claim row at the same (blockHeight, txIndex) that
 *     already carried a non-null amount (survives the per-poll rebuild).
 *   - `pending`: a local-claim whose receipt slot (confirmedBlockHeight,
 *     confirmedTxIndex) matches and whose `claimedAmount` is known.
 *  Only fills a NULL amountDecimal — NEVER overwrites a known amount with null.
 *  Matched by the (blockHeight, txIndex) inclusion slot — the same key
 *  applyCapturedClusterNames uses (one tx = one slot). */
export function applyStickyClaimAmount(
  confirmed: ConfirmedRow[],
  prior: { pending?: PendingTxRow[]; confirmed?: ConfirmedRow[] },
): ConfirmedRow[] {
  const pending = prior.pending ?? [];
  const prevConfirmed = prior.confirmed ?? [];
  if (pending.length === 0 && prevConfirmed.length === 0) return confirmed;
  return confirmed.map((row) => {
    if (row.kind !== "claim" || row.amountDecimal !== null) return row;
    const prevAmount = prevConfirmed.find(
      (p): p is ClaimRow =>
        p.kind === "claim" &&
        p.amountDecimal !== null &&
        p.blockHeight === row.blockHeight &&
        p.txIndex === row.txIndex,
    )?.amountDecimal;
    const pendAmount = pending.find(
      (p) =>
        p.source === "local-claim" &&
        p.claimedAmount != null &&
        p.confirmedBlockHeight === row.blockHeight &&
        p.confirmedTxIndex === row.txIndex,
    )?.claimedAmount;
    const amount = prevAmount ?? pendAmount ?? null;
    return amount !== null ? { ...row, amountDecimal: amount } : row;
  });
}

/** Merge a fresh indexer snapshot into the previous cache. Pure function:
 *
 *  1. Map delegation-history rows (canonical source — full richness).
 *  2. Build dedupe key-set from those rows.
 *  3. Map address-activity rows, suppressing kind="delegation" entries
 *     whose anchor is already in the delegation-stream key-set.
 *  4. Sort merged confirmed list newest-first by (blockHeight, txIndex,
 *     logIndex). The dedupe key includes the row KIND: a SELF-transfer
 *     (counterparty == the queried address) emits TWO activity entries at the
 *     SAME `(blockHeight, txIndex, logIndex)` — native transfers all carry the
 *     `logIndex = 0xFFFFFFFF` (u32::MAX) sentinel — one `direction:"in"` and
 *     one `"out"`. Keying by kind keeps BOTH the `tx_send` + `tx_receive` rows
 *     (so a self-send shows both legs) while still collapsing a genuine
 *     same-kind duplicate (delegation-history rows are pushed first, so they
 *     win over the activity-stream copy of the same event).
 *  5. Cap at ACTIVITY_ROLLING_WINDOW newest rows.
 *  6. When `prior` is supplied, thread captured cluster names onto the
 *     delegation rows (applyCapturedClusterNames) so an originated stake keeps
 *     its real `*.cluster.mono` name after the indexer supersedes the pending
 *     row. */
export function mergeIndexerSnapshot(
  fresh: {
    activity: RawAddressActivity[];
    delegation: RawDelegationHistory[];
  },
  now: number,
  prior?: { pending?: PendingTxRow[]; confirmed?: ConfirmedRow[] },
): ActivityCache {
  const delegationRows = mapDelegationHistoryToRows(fresh.delegation);
  const keys = delegationKeySet(delegationRows);
  const activityRows = mapAddressActivityToRows(fresh.activity, keys);

  const merged: ConfirmedRow[] = [];
  const seen = new Set<string>();
  // Key by anchor + kind (+ per-event principal for delegations) so a
  // self-transfer's in/out pair (identical anchor — native transfers share the
  // u32::MAX logIndex sentinel) both survive, two delegations in one block (the
  // indexer hardcodes txIndex/logIndex to 0) both survive, while a same-kind
  // cross-stream duplicate still collapses to the first (richer
  // delegation-history) copy. See confirmedRowDedupKey.
  for (const r of delegationRows) {
    const k = confirmedRowDedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  for (const r of activityRows) {
    const k = confirmedRowDedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  merged.sort(compareConfirmedNewestFirst);
  const capped = merged.slice(0, ACTIVITY_ROLLING_WINDOW);
  const named = prior ? applyCapturedClusterNames(capped, prior) : capped;
  // The indexer can surface a confirmed claim row before it decodes the
  // Claimed-log amount; carry a known amount (a prior confirmed row, or the
  // receipt-decoded local-claim) onto a null-amount claim row so the amount
  // doesn't blink out when applyLocalClaims retires the local copy.
  const withClaimAmounts = prior ? applyStickyClaimAmount(named, prior) : named;

  return { confirmed: withClaimAmounts, lastFetchedAtMs: now };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Activity ordering (pending + confirmed + failed, newest-first)
// ─────────────────────────────────────────────────────────────────────────────

/** A single rendered Activity entry, tagged by source: an indexer/pending
 *  `ActivityRow` or a failed-tx `NotificationRecord` (failed txs aren't in the
 *  success-only indexer stream — they come from the notification history). */
export type MergedActivityItem =
  | { tag: "row"; row: ActivityRow }
  | { tag: "failed"; record: NotificationRecord };

/** Newest-first recency for the unified list. All three sources expose a block
 *  height — pending: the broadcast anchor; confirmed: `blockHeight`; failed:
 *  the receipt `blockNumber`. A null/absent block means "not yet anchored"
 *  (just-broadcast pending, or a `lyth_txStatus="found"` fast-path failed) →
 *  it floats to the top (Infinity). The wall-clock `ms` is the secondary key
 *  (pending: broadcast time; failed: createdAt); confirmed rows carry no
 *  wall-clock, so they use 0 and stay block-ordered among themselves. */
function mergedRecency(item: MergedActivityItem): { block: number; ms: number } {
  if (item.tag === "failed") {
    return { block: item.record.blockNumber ?? Infinity, ms: item.record.createdAtMs };
  }
  const row = item.row;
  if (row.kind === "pending_tx") {
    // A receipt-confirmed (bridged) row sorts by its real inclusion block so it
    // interleaves with confirmed rows; a still-pending row floats to the top.
    if (row.confirmedBlockHeight !== undefined) {
      return { block: row.confirmedBlockHeight, ms: row.broadcastedAtMs };
    }
    return { block: row.broadcastBlockHeight ?? Infinity, ms: row.broadcastedAtMs };
  }
  return { block: row.blockHeight, ms: 0 };
}

/** Merge pending + confirmed + failed into ONE list sorted newest-first, the
 *  same chronological intent the notification center uses (so a failed row no
 *  longer pins above a newer pending row). Pure + stable: same-block confirmed
 *  rows keep their incoming (blockHeight, txIndex, logIndex) order. Two
 *  unanchored rows (block === Infinity) fall through to the ms tie-break —
 *  Infinity === Infinity, so the comparator never produces NaN. */
export function mergeActivityNewestFirst(
  pending: PendingTxRow[],
  confirmed: ConfirmedRow[],
  failed: NotificationRecord[],
): MergedActivityItem[] {
  const items: MergedActivityItem[] = [
    ...pending.map((row): MergedActivityItem => ({ tag: "row", row })),
    ...confirmed.map((row): MergedActivityItem => ({ tag: "row", row })),
    ...failed.map((record): MergedActivityItem => ({ tag: "failed", record })),
  ];
  return items.sort((a, b) => {
    const ra = mergedRecency(a);
    const rb = mergedRecency(b);
    if (ra.block !== rb.block) return rb.block - ra.block;
    return rb.ms - ra.ms;
  });
}
