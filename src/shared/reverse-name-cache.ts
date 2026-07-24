// Dedicated cache for QUORUM-verified reverse `.mono` names (address → name).
//
// Kept SEPARATE from the label cache (`mono.names.cache`, populated by the
// single-operator `lyth_getAddressLabel`) on purpose: the names here are the
// canonical §22.8 reverse names read from `lyth_nameOf` and agreed by a quorum
// of genesis-trusted operators (mirroring forward-resolve), so a single rogue
// operator can never mislabel a counterparty. Mixing the two sources in one
// field would let the inert label writer clobber a quorum name with null — hence
// the split.
//
// `name === null` is a CACHED confirmed-miss (the quorum agreed the address has
// no reverse name) — cached so the UI doesn't re-query every render. A quorum
// disagreement / insufficient responders / transport error is NOT cached (it's
// transient); the caller simply shows the bech32m address and retries later.

export const STORAGE_KEY_REVERSE_NAME_CACHE = "mono.names.reverse";

/** Entries older than this are re-resolved. Names change only on transfer
 *  (rare), so a moderate TTL keeps the fleet load low while staying fresh
 *  enough to reflect a transfer within the session. */
export const REVERSE_NAME_TTL_MS = 30 * 60 * 1000; // 30 min

export interface ReverseNameEntry {
  /** The quorum-agreed canonical `.mono` name, or `null` for a confirmed miss. */
  name: string | null;
  /** `Date.now()` when recorded; entries past {@link REVERSE_NAME_TTL_MS} are stale. */
  ts: number;
}

/** address(lowercase) → the quorum-verified reverse name (or a cached miss). */
export type ReverseNameCache = Record<string, ReverseNameEntry>;

function isEntry(v: unknown): v is ReverseNameEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    (e.name === null || typeof e.name === "string") && typeof e.ts === "number"
  );
}

/** Tolerant validation of a stored blob; null on any structural failure so the
 *  caller falls back to an empty cache. */
export function validateReverseNameCache(raw: unknown): ReverseNameCache | null {
  if (raw === null || typeof raw !== "object") return null;
  const out: ReverseNameCache = {};
  for (const [addr, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEntry(entry)) return null;
    out[addr.toLowerCase()] = { name: entry.name, ts: entry.ts };
  }
  return out;
}

/** Fresh entry for `address` (case-insensitive), or `undefined` if absent/stale. */
export function getReverseName(
  cache: ReverseNameCache,
  address: string,
  now: number,
): ReverseNameEntry | undefined {
  const entry = cache[address.toLowerCase()];
  if (entry === undefined) return undefined;
  if (now - entry.ts >= REVERSE_NAME_TTL_MS) return undefined;
  return entry;
}

/** A NEW cache with `address` set to `name` (pure). Lowercases the key. */
export function putReverseName(
  cache: ReverseNameCache,
  address: string,
  name: string | null,
  now: number,
): ReverseNameCache {
  return { ...cache, [address.toLowerCase()]: { name, ts: now } };
}

/** Drop stale entries. Returns a NEW cache only if something was evicted,
 *  otherwise the original (so callers can skip a spurious storage write). */
export function evictExpiredReverseNames(
  cache: ReverseNameCache,
  now: number,
): ReverseNameCache {
  let changed = false;
  const out: ReverseNameCache = {};
  for (const [addr, entry] of Object.entries(cache)) {
    if (now - entry.ts >= REVERSE_NAME_TTL_MS) {
      changed = true;
      continue;
    }
    out[addr] = entry;
  }
  return changed ? out : cache;
}
