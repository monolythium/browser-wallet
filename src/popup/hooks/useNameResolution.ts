// Reactive name resolution for counterparty addresses. Calls
// bgWalletResolveNames whenever the input set changes; subscribes to
// mono.names.cache for cross-popup-instance reactivity.
//
// Returns a Map<addrLower, NameLabel | undefined> where:
//   - `undefined` means "not yet resolved" (in-flight or hasn't been asked)
//   - `null` means "checked, indexer returned no label"
//   - NameLabelRecord means "labeled"
//
// Input contract: `addresses` is expected to be pre-deduped and lowercased
// by the caller (consumers should do this once per render, not per
// counterparty). The SW handler (commit 6) dedupes + lowercases
// defensively, so a noisy caller still produces correct output — but the
// hook compares array length+contents for change detection, so a noisy
// caller will cause unnecessary IPC fires. Defense-in-depth between the
// two layers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STORAGE_KEY_NAME_CACHE,
  validateNameCache,
  type NameCache,
  type NameLabel,
} from "../../shared/name-resolution.js";
import { bgWalletResolveNames } from "../bg.js";

export type NameResolutionMap = Map<string, NameLabel | undefined>;

export interface UseNameResolutionResult {
  /** Map keyed by lowercase 0x address. `undefined` for addresses not yet
   *  resolved (still in-flight or never asked); `null` for "checked, no
   *  label"; NameLabelRecord for labeled addresses. */
  labels: NameResolutionMap;
  /** Imperative re-fetch (force a fresh RPC even for cache-hit addresses).
   *  Rarely needed — the hook auto-refreshes on input change and on
   *  storage onChanged. */
  refresh: () => Promise<void>;
}

const EMPTY: UseNameResolutionResult = {
  labels: new Map(),
  refresh: async () => {},
};

export function useNameResolution(
  addresses: string[],
  chainIdHex: string | null,
): UseNameResolutionResult {
  const [labels, setLabels] = useState<NameResolutionMap>(() => new Map());
  const tokenRef = useRef(0);

  // Stable key for change detection. Reordering or duplicates in `addresses`
  // (which the caller is supposed to prevent) would otherwise cause the
  // effect to re-run unnecessarily. The hook trusts the caller to keep
  // the array sorted + deduped; if they don't, the SW absorbs it but the
  // hook fires extra IPC.
  const addrKey = useMemo(() => addresses.join(","), [addresses]);

  const refresh = useCallback(async () => {
    if (!chainIdHex || addresses.length === 0) return;
    const myToken = ++tokenRef.current;
    const r = await bgWalletResolveNames(addresses, chainIdHex);
    if (myToken !== tokenRef.current) return;
    if (!r.ok) return;
    setLabels((prev) => {
      const next = new Map(prev);
      for (const [addr, label] of Object.entries(r.resolved)) {
        next.set(addr, label);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey, chainIdHex]);

  useEffect(() => {
    if (!chainIdHex || addresses.length === 0) {
      setLabels(new Map());
      return;
    }
    void refresh();

    // Cross-instance sync: when another popup resolves names, the SW
    // writes mono.names.cache and we pick up the update for any address
    // in our current set. Single global storage key (per commit 3 — name
    // labels apply across accounts, not per-(addr, chain)).
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_NAME_CACHE];
      if (!change) return;
      const validated = validateNameCache(change.newValue);
      if (!validated) return;
      // Update only the addresses we care about; the global cache may
      // contain entries we never asked about.
      setLabels((prev) => {
        let mutated = false;
        const next = new Map(prev);
        const cache: NameCache = validated;
        for (const addr of addresses) {
          const entry = cache[addr];
          if (entry === undefined) continue;
          if (next.get(addr) !== entry.label) {
            next.set(addr, entry.label);
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      tokenRef.current++;
      chrome.storage.onChanged.removeListener(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey, chainIdHex, refresh]);

  if (!chainIdHex || addresses.length === 0) return EMPTY;
  return { labels, refresh };
}
