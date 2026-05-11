// Unit coverage for the name-cache shared helpers. The SW-level IPC tests
// in service-worker.activity.test.ts (commit 9) cover the integrated path
// (RPC batching + cache write + onChanged); these pin the pure logic.

import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY_NAME_CACHE,
  NAME_TTL_NULL_MS,
  NAME_TTL_LABEL_MS,
  validateNameCache,
  isNameEntryExpired,
  evictExpiredNames,
  mergeNameCache,
  type NameCache,
  type NameCacheEntry,
  type NameLabelRecord,
} from "./name-resolution.js";

const FOUNDATION: NameLabelRecord = {
  address: "0x" + "11".repeat(20),
  category: "foundation",
  displayName: "Foundation-1",
  updatedAtBlock: 12345,
};

const EXCHANGE: NameLabelRecord = {
  address: "0x" + "22".repeat(20),
  category: "exchange",
  displayName: "Coinbase",
  updatedAtBlock: 12400,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("uses the global storage-key namespace", () => {
    expect(STORAGE_KEY_NAME_CACHE).toBe("mono.names.cache");
  });

  it("uses a shorter TTL for null entries than for labeled entries", () => {
    // The split is load-bearing: unresolved addresses must be rechecked
    // more aggressively than resolved ones (a label can be registered
    // at any moment per §22.8).
    expect(NAME_TTL_NULL_MS).toBeLessThan(NAME_TTL_LABEL_MS);
  });

  it("uses 30-minute null TTL and 6-hour label TTL", () => {
    expect(NAME_TTL_NULL_MS).toBe(30 * 60 * 1000);
    expect(NAME_TTL_LABEL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateNameCache
// ─────────────────────────────────────────────────────────────────────────────

describe("validateNameCache", () => {
  it("accepts an empty cache", () => {
    expect(validateNameCache({})).toEqual({});
  });

  it("accepts a cache with a labeled entry", () => {
    const cache = {
      [FOUNDATION.address]: {
        label: FOUNDATION,
        cachedAtMs: 1_700_000_000_000,
      },
    };
    expect(validateNameCache(cache)).toEqual(cache);
  });

  it("accepts a cache with a null-label entry (checked-no-label)", () => {
    const cache = {
      [FOUNDATION.address]: {
        label: null,
        cachedAtMs: 1_700_000_000_000,
      },
    };
    expect(validateNameCache(cache)).toEqual(cache);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const r = validateNameCache({
      [FOUNDATION.address]: {
        label: FOUNDATION,
        cachedAtMs: 1_700_000_000_000,
      },
      "0xbogus": { label: "not-a-label-record", cachedAtMs: 1 },
      [EXCHANGE.address]: { label: EXCHANGE, cachedAtMs: 1_700_000_000_001 },
    });
    expect(r).not.toBeNull();
    expect(Object.keys(r!).length).toBe(2);
    expect(r![FOUNDATION.address]?.label).toEqual(FOUNDATION);
    expect(r![EXCHANGE.address]?.label).toEqual(EXCHANGE);
  });

  it("rejects an array (cache must be address-keyed object)", () => {
    expect(validateNameCache([])).toBeNull();
  });

  it("rejects null / non-object / string inputs", () => {
    expect(validateNameCache(null)).toBeNull();
    expect(validateNameCache(undefined)).toBeNull();
    expect(validateNameCache("string")).toBeNull();
    expect(validateNameCache(42)).toBeNull();
  });

  it("drops entries missing cachedAtMs", () => {
    const r = validateNameCache({
      "0xa": { label: FOUNDATION },
    });
    expect(r).toEqual({});
  });

  it("drops entries with non-finite cachedAtMs", () => {
    const r = validateNameCache({
      "0xa": { label: FOUNDATION, cachedAtMs: Number.NaN },
    });
    expect(r).toEqual({});
  });

  it("drops entries with a malformed label record", () => {
    const r = validateNameCache({
      "0xa": {
        label: {
          address: "0xa",
          category: "foundation",
          displayName: 42, // wrong type
          updatedAtBlock: 1,
        },
        cachedAtMs: 1,
      },
    });
    expect(r).toEqual({});
  });

  it("accepts displayName: null on a non-null label", () => {
    const r = validateNameCache({
      "0xa": {
        label: {
          address: "0xa",
          category: "operator",
          displayName: null,
          updatedAtBlock: 1,
        },
        cachedAtMs: 1,
      },
    });
    expect(r).not.toBeNull();
    expect(r!["0xa"]?.label).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isNameEntryExpired — the load-bearing split-TTL behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("isNameEntryExpired", () => {
  it("null entry: NOT expired before NAME_TTL_NULL_MS", () => {
    const now = 10_000_000;
    const entry: NameCacheEntry = {
      label: null,
      cachedAtMs: now - NAME_TTL_NULL_MS + 1,
    };
    expect(isNameEntryExpired(entry, now)).toBe(false);
  });

  it("null entry: expired AT NAME_TTL_NULL_MS (boundary inclusive)", () => {
    const now = 10_000_000;
    const entry: NameCacheEntry = {
      label: null,
      cachedAtMs: now - NAME_TTL_NULL_MS,
    };
    expect(isNameEntryExpired(entry, now)).toBe(true);
  });

  it("labeled entry: NOT expired before NAME_TTL_LABEL_MS", () => {
    const now = 10_000_000_000;
    const entry: NameCacheEntry = {
      label: FOUNDATION,
      cachedAtMs: now - NAME_TTL_LABEL_MS + 1,
    };
    expect(isNameEntryExpired(entry, now)).toBe(false);
  });

  it("labeled entry: expired AT NAME_TTL_LABEL_MS (boundary inclusive)", () => {
    const now = 10_000_000_000;
    const entry: NameCacheEntry = {
      label: FOUNDATION,
      cachedAtMs: now - NAME_TTL_LABEL_MS,
    };
    expect(isNameEntryExpired(entry, now)).toBe(true);
  });

  it("split TTL: a null entry expires before a label entry of same age", () => {
    // Same cachedAtMs, one null and one labeled. At a time between the
    // two TTLs, the null entry is expired and the labeled one is not.
    const cachedAtMs = 0;
    const between = NAME_TTL_NULL_MS + 1; // past null TTL, well before label TTL
    expect(isNameEntryExpired({ label: null, cachedAtMs }, between)).toBe(true);
    expect(isNameEntryExpired({ label: FOUNDATION, cachedAtMs }, between)).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evictExpiredNames
// ─────────────────────────────────────────────────────────────────────────────

describe("evictExpiredNames", () => {
  it("drops null entries past their (shorter) TTL but keeps fresh labeled entries", () => {
    const now = 10_000_000_000;
    const cache: NameCache = {
      "0xstale-null": { label: null, cachedAtMs: now - NAME_TTL_NULL_MS - 1 },
      "0xfresh-label": {
        label: FOUNDATION,
        cachedAtMs: now - NAME_TTL_NULL_MS - 1, // older than null TTL, younger than label TTL
      },
    };
    const r = evictExpiredNames(cache, now);
    expect(Object.keys(r)).toEqual(["0xfresh-label"]);
  });

  it("drops labeled entries past their TTL", () => {
    const now = 10_000_000_000;
    const cache: NameCache = {
      "0xstale-label": {
        label: FOUNDATION,
        cachedAtMs: now - NAME_TTL_LABEL_MS - 1,
      },
    };
    expect(evictExpiredNames(cache, now)).toEqual({});
  });

  it("returns a new cache (pure function)", () => {
    const cache: NameCache = {
      "0xa": { label: null, cachedAtMs: 1_000_000_000_000 },
    };
    const r = evictExpiredNames(cache, 1_000_000_000_000);
    expect(r).not.toBe(cache);
  });

  it("returns an empty object for an empty cache", () => {
    expect(evictExpiredNames({}, 1_000)).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeNameCache
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeNameCache", () => {
  const now = 1_700_000_000_000;

  it("adds new entries with the current timestamp", () => {
    const r = mergeNameCache({}, { [FOUNDATION.address]: FOUNDATION }, now);
    expect(r).toEqual({
      [FOUNDATION.address]: { label: FOUNDATION, cachedAtMs: now },
    });
  });

  it("preserves prev entries that aren't in fresh", () => {
    const prev: NameCache = {
      "0xkept": { label: EXCHANGE, cachedAtMs: now - 1000 },
    };
    const r = mergeNameCache(prev, { [FOUNDATION.address]: FOUNDATION }, now);
    expect(r["0xkept"]).toEqual(prev["0xkept"]); // verbatim
    expect(r[FOUNDATION.address]).toEqual({ label: FOUNDATION, cachedAtMs: now });
  });

  it("overrides prev entries when fresh has them", () => {
    const prev: NameCache = {
      [FOUNDATION.address]: {
        label: { ...FOUNDATION, displayName: "OldName" },
        cachedAtMs: now - 1_000_000,
      },
    };
    const r = mergeNameCache(prev, { [FOUNDATION.address]: FOUNDATION }, now);
    expect(r[FOUNDATION.address]).toEqual({ label: FOUNDATION, cachedAtMs: now });
  });

  it("writes null labels (checked-no-label resolutions) into the cache", () => {
    // This is the critical anti-storm behavior: if the indexer says "no
    // label for 0xfoo", we cache the null so we don't re-ask on every
    // popup render. The null entry carries the NAME_TTL_NULL_MS TTL.
    const r = mergeNameCache({}, { "0xfoo": null }, now);
    expect(r["0xfoo"]).toEqual({ label: null, cachedAtMs: now });
  });

  it("returns a new cache (pure function)", () => {
    const prev: NameCache = {
      "0xa": { label: null, cachedAtMs: now },
    };
    const r = mergeNameCache(prev, {}, now);
    expect(r).not.toBe(prev);
    expect(r).toEqual(prev);
  });
});
