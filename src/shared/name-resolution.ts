// Phase 4.4 — fallback-aware name cache shared between the service worker
// (which calls `lyth_getAddressLabel` per counterparty and persists results)
// and the popup (which reads the cache via chrome.storage.onChanged + IPC).
//
// The chain's naming surface today is `lyth_getAddressLabel` (already wired
// in wallet-indexer-snapshot, see service-worker.ts:1777). Returns:
//   { address, category, displayName, updatedAtBlock }
// with `category` in the indexer's pragmatic taxonomy: foundation, exchange,
// bridge, treasury, contract, operator. This is the de facto naming source
// for Phase 4.4; §22.8's TLD-hierarchical scheme (.mono / .agent / .cluster
// / .contract / .system) is not yet emitted by the indexer. The binding shape
// is the same when §22.8 lands — swap-in only.
//
// The cache is GLOBAL (one key, not per-account) — labels apply across
// accounts. A label resolved for `0xfoundation01` is meaningful regardless
// of which wallet account is currently unlocked.
//
// Both states are valid cache entries:
//   - label !== null → "this address has a registered label"
//   - label === null → "we asked, the indexer said no label". Caching
//     this prevents hammering the operator on every render; rechecks
//     happen via the shorter null-entry TTL (label registration can
//     happen between calls).

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Global storage key — one cache across all accounts and chains. Labels
 *  are address-keyed and don't depend on which account is unlocked. */
export const STORAGE_KEY_NAME_CACHE = "mono.names.cache";

/** TTL for `null` entries — the indexer said "no label" but a label could
 *  be registered any moment. Re-checking every 30 minutes is the right
 *  cadence: long enough to avoid hammering operators on every popup open,
 *  short enough that a freshly registered label surfaces within half an
 *  hour. */
export const NAME_TTL_NULL_MS = 30 * 60 * 1000;

/** TTL for non-null entries — labels are persistent on-chain state per
 *  §22.8 ("permanent, voluntary transfer with propose-accept"), but the
 *  `displayName` or `category` can be updated. Six hours balances cache
 *  warmth (label rendering should be instant for any address the user
 *  has interacted with that day) against the freshness expectation. */
export const NAME_TTL_LABEL_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Wallet-internal label shape — mirrors the SDK's `AddressLabelRecord`
 *  binding but uses `number` for `updatedAtBlock` to match the wallet's
 *  IPC and storage conventions (the wire actually carries a JSON number;
 *  ts-rs nominally labels it bigint, see activity.ts for the same
 *  rationale). */
export interface NameLabelRecord {
  address: string;
  category: string;
  displayName: string | null;
  updatedAtBlock: number;
}

/** A resolved name: either a label record, or `null` meaning "we asked
 *  and the indexer has no entry for this address". Both are valid cache
 *  states; only `undefined` (not yet resolved) is absent from the cache. */
export type NameLabel = NameLabelRecord | null;

/** One row in the persisted cache. */
export interface NameCacheEntry {
  label: NameLabel;
  cachedAtMs: number;
}

/** Persisted shape under `mono.names.cache`. Address-keyed; addresses are
 *  lowercased 0x form. */
export type NameCache = Record<string, NameCacheEntry>;

// ─────────────────────────────────────────────────────────────────────────────
// Validators (operators.ts / activity.ts pattern: T | null on any failure)
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateNameLabelRecord(input: unknown): NameLabelRecord | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (typeof r.address !== "string" || r.address.length === 0) return null;
  if (typeof r.category !== "string") return null;
  if (r.displayName !== null && typeof r.displayName !== "string") return null;
  if (!isFiniteNumber(r.updatedAtBlock)) return null;
  return {
    address: r.address,
    category: r.category,
    displayName: r.displayName,
    updatedAtBlock: r.updatedAtBlock,
  };
}

function validateNameCacheEntry(input: unknown): NameCacheEntry | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNumber(r.cachedAtMs)) return null;
  // `label` is either null or a NameLabelRecord. The validator distinguishes
  // by passing null through, validating non-null inputs structurally.
  let label: NameLabel;
  if (r.label === null) {
    label = null;
  } else {
    const validated = validateNameLabelRecord(r.label);
    if (validated === null) return null;
    label = validated;
  }
  return { label, cachedAtMs: r.cachedAtMs };
}

/** Validate the full name cache. Returns null on any structural failure
 *  (object-shaped check at the top, then each entry); individual malformed
 *  entries are dropped rather than tanking the whole cache (matches
 *  activity.ts's partial-data-preferred posture). */
export function validateNameCache(input: unknown): NameCache | null {
  if (input === null || typeof input !== "object") return null;
  if (Array.isArray(input)) return null;
  const out: NameCache = {};
  for (const [addr, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof addr !== "string" || addr.length === 0) continue;
    const entry = validateNameCacheEntry(raw);
    if (entry === null) continue;
    out[addr] = entry;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TTL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when the cached entry is past its TTL. Null and non-null
 *  entries have different TTLs (NAME_TTL_NULL_MS vs NAME_TTL_LABEL_MS) so
 *  unresolved addresses are re-checked more aggressively than resolved
 *  ones. */
export function isNameEntryExpired(entry: NameCacheEntry, now: number): boolean {
  const ttl = entry.label === null ? NAME_TTL_NULL_MS : NAME_TTL_LABEL_MS;
  return now - entry.cachedAtMs >= ttl;
}

/** Drop expired entries. Pure function — returns a new cache. */
export function evictExpiredNames(cache: NameCache, now: number): NameCache {
  const out: NameCache = {};
  for (const [addr, entry] of Object.entries(cache)) {
    if (!isNameEntryExpired(entry, now)) {
      out[addr] = entry;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge — fresh resolutions in, updated cache out
// ─────────────────────────────────────────────────────────────────────────────

/** Merge a batch of freshly-resolved labels into the previous cache.
 *  Fresh entries override any prev entry for the same address. Addresses
 *  not in `fresh` keep their prev entry verbatim (re-fetched only when
 *  their own TTL expires). The merge is pure — returns a new cache. */
export function mergeNameCache(
  prev: NameCache,
  fresh: Record<string, NameLabel>,
  now: number,
): NameCache {
  const out: NameCache = { ...prev };
  for (const [addr, label] of Object.entries(fresh)) {
    out[addr] = { label, cachedAtMs: now };
  }
  return out;
}
