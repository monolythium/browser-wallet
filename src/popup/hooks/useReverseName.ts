// Reverse-resolve an address → its quorum-verified canonical `*.mono` name for
// DISPLAY (Phase 5 / §22.8). Reads the dedicated quorum reverse cache
// (`mono.names.reverse`) and stays reactive to cross-instance writes.
//
// When `chainIdHex` is non-null the hook also triggers a cache-first quorum
// resolve via the service worker (mirrors forward-resolve — a single operator
// can never mislabel). Pass `null` for a CACHE-ONLY read (e.g. activity rows,
// so a long list doesn't fan a full-fleet quorum per counterparty; those rows
// display names already resolved by the single-address sites).
//
// Returns the `*.mono` name, or `null` when there is no quorum-agreed name — the
// caller then shows the bech32m address (never a single-operator-asserted name).

import { useEffect, useState } from "react";

import {
  STORAGE_KEY_REVERSE_NAME_CACHE,
  validateReverseNameCache,
  getReverseName,
  type ReverseNameCache,
} from "../../shared/reverse-name-cache.js";
import { parseMonoName, type NameLabel } from "../../shared/name-resolution.js";
import { bgWalletReverseName } from "../bg.js";

/**
 * Build a display label from a quorum-verified reverse `*.mono` name, PREFERRING
 * it over the (single-operator) fallback label so a counterparty shows its
 * canonical name. `monoName === undefined` → the fallback (which may itself be
 * undefined → the caller shows the bech32m address). Pure — unit-tested.
 */
export function preferReverseNameLabel(
  address: string,
  monoName: string | undefined,
  fallback: NameLabel | undefined,
): NameLabel | undefined {
  if (monoName === undefined) return fallback;
  const parsed = parseMonoName(monoName);
  return {
    address,
    category: parsed?.tld ?? "human",
    displayName: monoName,
    updatedAtBlock: 0,
  };
}

export function useReverseName(
  addr0x: string | null,
  chainIdHex: string | null,
): string | null {
  const [name, setName] = useState<string | null>(null);
  const key = addr0x === null ? null : addr0x.toLowerCase();

  useEffect(() => {
    if (key === null) {
      setName(null);
      return;
    }
    let cancelled = false;

    const applyCache = (cache: ReverseNameCache) => {
      if (cancelled) return;
      const entry = getReverseName(cache, key, Date.now());
      // `undefined` = absent/stale; a present entry may still hold `null` (a
      // cached confirmed-miss). Both render as "no name" (→ bech32m).
      setName(entry?.name ?? null);
    };

    // 1. Initial read from the cache (instant for a warm entry).
    chrome.storage.local.get([STORAGE_KEY_REVERSE_NAME_CACHE], (res) => {
      applyCache(validateReverseNameCache(res?.[STORAGE_KEY_REVERSE_NAME_CACHE]) ?? {});
    });

    // 2. Trigger a cache-first quorum resolve when a chain is provided.
    if (chainIdHex !== null && addr0x !== null) {
      void bgWalletReverseName(addr0x, chainIdHex).then((r) => {
        if (cancelled) return;
        if (r.ok) setName(r.name);
      });
    }

    // 3. Stay reactive to cache writes (this address resolved here or elsewhere).
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_REVERSE_NAME_CACHE];
      if (!change) return;
      const validated = validateReverseNameCache(change.newValue);
      if (validated === null) return;
      applyCache(validated);
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key, chainIdHex, addr0x]);

  return name;
}

/**
 * The BOUNDING decision for eager activity resolution (pure — the load-bearing
 * guard, unit-tested). Given the counterparty addresses of the visible rows,
 * returns the addresses to reverse-resolve now: **deduped by unique address**
 * (one resolve per distinct counterparty, never per row), **cache-first** (skip
 * anything already in the cache — a hit OR a cached miss), and **capped** at
 * `max` (so a long feed never fans a full-fleet quorum × M rows). Order is
 * preserved so the first/top rows resolve first.
 */
export function selectReverseNamesToResolve(
  addresses: ReadonlyArray<string>,
  cache: ReverseNameCache,
  now: number,
  max: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const addr = raw.toLowerCase();
    if (seen.has(addr)) continue; // dedupe by unique address
    seen.add(addr);
    if (getReverseName(cache, addr, now) !== undefined) continue; // cache-first
    out.push(addr);
    if (out.length >= max) break; // bounded
  }
  return out;
}

/** Default cap on eager activity resolution — the visible / first-page rows. */
export const EAGER_REVERSE_NAME_MAX = 30;

/**
 * CACHE-ONLY batch reverse-name lookup for a list of addresses (e.g. activity
 * counterparties). Reads the quorum reverse cache and stays reactive, but does
 * NOT trigger resolution — so a long list never fans a full-fleet quorum per
 * row. Names appear for addresses already resolved by the single-address sites
 * (send-review, the account block). Returns a Map of addrLower → `*.mono` name.
 */
export function useReverseNamesCached(
  addresses: ReadonlyArray<string>,
): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const key = addresses.map((a) => a.toLowerCase()).join(",");

  useEffect(() => {
    let cancelled = false;
    const wanted = key.length === 0 ? [] : key.split(",");

    const apply = (cache: ReverseNameCache) => {
      if (cancelled) return;
      const now = Date.now();
      const next = new Map<string, string>();
      for (const addr of wanted) {
        const entry = getReverseName(cache, addr, now);
        if (entry !== undefined && entry.name !== null) next.set(addr, entry.name);
      }
      setNames(next);
    };

    chrome.storage.local.get([STORAGE_KEY_REVERSE_NAME_CACHE], (res) => {
      apply(validateReverseNameCache(res?.[STORAGE_KEY_REVERSE_NAME_CACHE]) ?? {});
    });

    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_REVERSE_NAME_CACHE];
      if (!change) return;
      const validated = validateReverseNameCache(change.newValue);
      if (validated === null) return;
      apply(validated);
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key]);

  return names;
}

/**
 * Like {@link useReverseNamesCached}, but PROACTIVELY resolves the counterparty
 * names of the visible activity rows — **strictly bounded** so it stays
 * fleet-friendly: {@link selectReverseNamesToResolve} dedupes by unique address,
 * skips anything already cached (cache-first), and caps at
 * {@link EAGER_REVERSE_NAME_MAX}. Each pick goes through the SW's own cache-first
 * `wallet-reverse-name` (quorum only on a genuine miss). Resolution fires ONCE
 * per address-set / chain change; the storage listener only re-reads the cache
 * (never re-triggers a resolve → no loop, no per-row fan-out).
 */
export function useReverseNamesEager(
  addresses: ReadonlyArray<string>,
  chainIdHex: string | null,
  max: number = EAGER_REVERSE_NAME_MAX,
): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const key = addresses.map((a) => a.toLowerCase()).join(",");

  useEffect(() => {
    let cancelled = false;
    const wanted = key.length === 0 ? [] : key.split(",");

    const apply = (cache: ReverseNameCache) => {
      if (cancelled) return;
      const now = Date.now();
      const next = new Map<string, string>();
      for (const addr of wanted) {
        const entry = getReverseName(cache, addr, now);
        if (entry !== undefined && entry.name !== null) next.set(addr, entry.name);
      }
      setNames(next);
    };

    // Read the cache once, render what's warm, then fire the BOUNDED eager
    // resolves for the uncached picks (deduped + capped) — never per-row.
    chrome.storage.local.get([STORAGE_KEY_REVERSE_NAME_CACHE], (res) => {
      if (cancelled) return;
      const cache = validateReverseNameCache(res?.[STORAGE_KEY_REVERSE_NAME_CACHE]) ?? {};
      apply(cache);
      if (chainIdHex !== null) {
        const toResolve = selectReverseNamesToResolve(wanted, cache, Date.now(), max);
        for (const addr of toResolve) {
          void bgWalletReverseName(addr, chainIdHex); // cache-first + quorum-on-miss; writes cache
        }
      }
    });

    // Re-read only (no re-resolve) as resolutions land / other sites write.
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_REVERSE_NAME_CACHE];
      if (!change) return;
      const validated = validateReverseNameCache(change.newValue);
      if (validated === null) return;
      apply(validated);
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [key, chainIdHex, max]);

  return names;
}
