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

// ─────────────────────────────────────────────────────────────────────────────
// §22.8 hierarchical naming — TLD parser + reverse lookup
// ─────────────────────────────────────────────────────────────────────────────
//
// Whitepaper §22.8 defines five TLDs on the naming-registry precompile
// (0x1106):
//
//   <label>.mono                    — human (primary)
//   <label>.agent.<human>.mono      — agent (sub-account under a human parent)
//   <label>.cluster.mono            — cluster (validator-bond bundle)
//   <label>.contract.mono           — contract (deployed code label)
//   <label>.system.mono             — system / foundation (reserved TLD)
//
// The chain's `lyth_getAddressLabel` currently emits the pragmatic indexer
// taxonomy (foundation/exchange/bridge/treasury/contract/operator) in
// `displayName`. When §22.8 ships on chain, the same `displayName` field
// will carry the hierarchical form (e.g. "treasury.contract.mono"); the
// parser here lets the UI surface a TLD-aware badge without an indexer
// change.

/** Five TLD categories from §22.8. */
export type MonoTld = "human" | "agent" | "cluster" | "contract" | "system";

export interface MonoNameParse {
  /** TLD category. */
  tld: MonoTld;
  /** Leftmost label (`alice` in `alice.agent.bob.mono`). */
  label: string;
  /** For agent names: the human parent label (`bob` in the example above);
   *  null for the four non-agent TLDs. */
  parent: string | null;
  /** Reconstructed canonical form, lowercased. */
  canonical: string;
}

/** Maximum total length of a hierarchical name. Generous floor; the
 *  naming-registry precompile enforces a tighter cap on chain. */
const MONO_NAME_MAX_LEN = 253;

/** Label charset: `[a-z0-9-]`, no leading/trailing hyphen, length 1-63. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidLabel(s: string): boolean {
  return s.length > 0 && s.length <= 63 && LABEL_RE.test(s);
}

/**
 * Parse a §22.8 hierarchical name into its TLD category, leftmost label,
 * and (for agent names) human parent. Returns null on any structural
 * failure — mixed case is rejected (§22.7 canonicalization rule applies).
 *
 * Accepted forms:
 *   "alice.mono"                      → { tld: "human",    label: "alice",  parent: null }
 *   "bob.agent.alice.mono"            → { tld: "agent",    label: "bob",    parent: "alice" }
 *   "edge-validators.cluster.mono"    → { tld: "cluster",  label: "edge-validators" }
 *   "lyth-bridge.contract.mono"       → { tld: "contract", label: "lyth-bridge" }
 *   "foundation.system.mono"          → { tld: "system",   label: "foundation" }
 *
 * Rejected:
 *   - Mixed case ("Alice.mono")
 *   - Names without `.mono` suffix
 *   - Empty labels or labels >63 chars
 *   - Labels with leading/trailing hyphen
 *   - Reserved labels in second position other than the four sub-TLDs
 */
export function parseMonoName(input: string): MonoNameParse | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > MONO_NAME_MAX_LEN) return null;
  if (input !== input.toLowerCase()) return null;
  if (!input.endsWith(".mono")) return null;
  const parts = input.split(".");
  // Every form ends with ".mono", so the rightmost part is "mono".
  // Forms by part count:
  //   2  →  [label, "mono"]            human
  //   3  →  [label, <tld>, "mono"]     cluster/contract/system
  //   4  →  [label, "agent", parent, "mono"] agent
  if (parts.length < 2 || parts.length > 4) return null;
  if (parts[parts.length - 1] !== "mono") return null;
  for (const p of parts) {
    if (!isValidLabel(p)) return null;
  }
  if (parts.length === 2) {
    const [label] = parts as [string, string];
    return {
      tld: "human",
      label,
      parent: null,
      canonical: `${label}.mono`,
    };
  }
  if (parts.length === 3) {
    const [label, sub] = parts as [string, string, string];
    if (sub === "cluster" || sub === "contract" || sub === "system") {
      return {
        tld: sub,
        label,
        parent: null,
        canonical: `${label}.${sub}.mono`,
      };
    }
    return null; // unknown second-position label
  }
  // parts.length === 4 — only `agent` is valid here.
  const [label, sub, parent] = parts as [string, string, string, string];
  if (sub !== "agent") return null;
  return {
    tld: "agent",
    label,
    parent,
    canonical: `${label}.agent.${parent}.mono`,
  };
}

/**
 * Reverse name → address using only the local name cache. The wallet
 * does not have a `lyth_resolveName` RPC yet (§22.8 registry is forward-
 * looking), so this only finds matches the user has already encountered
 * via reverse-resolve (address → label).
 *
 * Returns the lowercased 0x address on a hit, or null when the name
 * isn't in cache (UI should surface "name not in cache — paste address
 * directly" copy).
 *
 * Comparison is on the canonical lowercased form via `parseMonoName`;
 * label entries whose `displayName` doesn't parse as a §22.8 name are
 * skipped. The first matching entry wins (cache is small; iteration is
 * O(n) which is fine for popup-side lookup).
 */
export function lookupNameInCache(
  name: string,
  cache: NameCache,
): string | null {
  const parsed = parseMonoName(name);
  if (parsed === null) return null;
  for (const [addr, entry] of Object.entries(cache)) {
    const label = entry.label;
    if (label === null) continue;
    if (typeof label.displayName !== "string") continue;
    const candidate = parseMonoName(label.displayName);
    if (candidate === null) continue;
    if (candidate.canonical === parsed.canonical) {
      return addr.toLowerCase();
    }
  }
  return null;
}
