// Reactive read of the Phase 4.4 activity cache. Mirrors useApprovalQueue.ts
// for the chrome.storage.onChanged subscription pattern + App.tsx:220-225
// balanceTokenRef for race protection.
//
// Two storage keys are watched per (addr, chainId):
//   mono.activity.<addrLower>.<chainIdHex>          — confirmed rows
//   mono.activity.pending.<addrLower>.<chainIdHex>  — pending rows
//
// The SW (wallet-activity-get) writes both keys; the listener picks up
// changes for free reactivity, both within this popup instance and across
// popup instances (e.g. approval window open at the same time as Home).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activityCacheKey,
  activityPendingKey,
  validateActivityCache,
  validatePendingActivityCache,
  type ActivityCache,
  type PendingTxRow,
} from "../../shared/activity.js";
import { isDemoAddrSentinel } from "../../shared/demo-addr-sentinel.js";
import { bgWalletActivityGet } from "../bg.js";

export interface UseActivityResult {
  /** Confirmed-row cache. Null until the first IPC reply lands. */
  cache: ActivityCache | null;
  /** Synthetic pending rows from local Send broadcasts. */
  pending: PendingTxRow[];
  /** True until the first IPC reply resolves for the current (addr, chain).
   *  Re-fetches on focus / screen change do NOT flip this back to true —
   *  the cached data stays rendered while the fresh fetch runs in the
   *  background. */
  loading: boolean;
  /** Per-stream errors from the last fetch — empty object when the IPC
   *  reply returned ok:true with no upstream errors, populated by the
   *  errors-by-key bundle (addressActivity / delegationHistory / etc.)
   *  surfaced by the SW. */
  errors: Record<string, string>;
  /** Imperative re-fetch. Used by App.tsx's three trigger paths
   *  (visibility-regained, screen-change-to-home, dep-driven). */
  refresh: () => Promise<void>;
}

const EMPTY: UseActivityResult = {
  cache: null,
  pending: [],
  loading: false,
  errors: {},
  refresh: async () => {},
};

/** Bug A F2 — while ≥1 pending row exists, re-poll this often (ms). ~4s sits
 *  inside the chain's ~3-5s anchor-finality window, so a tx that confirms
 *  while a surface is open flips out of "pending" within ~one finality round
 *  instead of waiting for the next 30s activity refresh or the GAP-N1 alarm.
 *  Paired with the SW-side F1 bypass (wallet-activity-get skips the 30s
 *  staleness short-circuit when pending rows exist) so each tick actually
 *  reconciles against the operators. */
const PENDING_REPOLL_MS = 4_000;

export function useActivity(
  addr: string | null,
  chainIdHex: string | null,
): UseActivityResult {
  const [cache, setCache] = useState<ActivityCache | null>(null);
  const [pending, setPending] = useState<PendingTxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Race protection: each fetch captures the current token; when the IPC
  // resolves, it checks the captured value against tokenRef.current. A
  // mismatch means a newer fetch (or an unmount) has invalidated this
  // result. Verbatim mirror of App.tsx:220-225 balanceTokenRef.
  const tokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!addr || !chainIdHex) return;
    if (!addr.startsWith("0x")) return;
    // Round 3.5 — skip the IPC + cache write when the address is one
    // of the popup demo-data sentinels. The popup's initial state seeds
    // `acc = ACCOUNTS[0]` whose addr is `0xa9f2…0001`; the
    // `wallet-active-account` IPC then replaces it with the real
    // unlocked vault address. Without this guard the brief demo-state
    // window fires a real `wallet-activity-get` IPC, which writes
    // `mono.activity.<demo-addr>.<chainId>` into chrome.storage —
    // confirmed in the 2026-05-26 storage dump. Guarding here is the
    // cheapest defense (no IPC, no cache); the SW boot also runs a
    // one-shot migration to remove pre-existing sentinel cache keys.
    if (isDemoAddrSentinel(addr)) return;
    const myToken = ++tokenRef.current;
    const r = await bgWalletActivityGet(addr, chainIdHex);
    if (myToken !== tokenRef.current) return;
    setLoading(false);
    if (!r.ok) {
      setErrors({ ipc: r.reason ?? "fetch failed" });
      return;
    }
    setCache(r.cache);
    setPending(r.pending);
    setErrors(r.errors);
  }, [addr, chainIdHex]);

  useEffect(() => {
    if (!addr || !chainIdHex || !addr.startsWith("0x") || isDemoAddrSentinel(addr)) {
      setCache(null);
      setPending([]);
      setLoading(false);
      setErrors({});
      return;
    }
    // Fresh dep — reset to loading and kick the fetch.
    setLoading(true);
    setCache(null);
    setPending([]);
    setErrors({});
    void refresh();

    // Subscribe to storage for cross-instance + post-Send-prepend
    // reactivity. The SW writes both keys whenever it produces fresh
    // data; the IPC reply already updated React state, but the listener
    // also picks up writes made by OTHER popup instances (approval
    // window, second tab) and by the Send broadcast's fire-and-forget
    // pending writer that doesn't go through this hook's IPC channel.
    const cacheKey = activityCacheKey(addr.toLowerCase(), chainIdHex);
    const pendingKey = activityPendingKey(addr.toLowerCase(), chainIdHex);
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      if (cacheKey in changes) {
        const next = changes[cacheKey]?.newValue;
        const validated = validateActivityCache(next);
        if (validated) setCache(validated);
      }
      if (pendingKey in changes) {
        const next = changes[pendingKey]?.newValue;
        const validated = validatePendingActivityCache(next);
        if (validated) setPending(validated.pending);
      }
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      // Invalidate any in-flight fetch so it can't race-update after
      // unmount, and tear down the storage listener.
      tokenRef.current++;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [addr, chainIdHex, refresh]);

  // Bug A F2 — bounded short-interval re-poll while pending rows exist. Runs
  // ONLY while the hook is mounted (i.e. a surface is open) AND there is ≥1
  // pending row; the interval is torn down the moment the set empties and on
  // unmount, so no timer leaks and no duplicate timers. Each tick re-runs the
  // same `refresh()` IPC path (which, via F1, bypasses the 30s staleness cache
  // when pending exists and reconciles against the operators); the SW writes
  // the pending key and the onChanged listener above re-renders. Coexists with
  // the GAP-N1 alarm + the path-agnostic notified-set dedupe, so the re-poll,
  // the alarm, and refocus/nav can't double-notify.
  const hasPending = pending.length > 0;
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => {
      void refresh();
    }, PENDING_REPOLL_MS);
    return () => clearInterval(id);
  }, [hasPending, refresh]);

  if (!addr || !chainIdHex || !addr.startsWith("0x")) return EMPTY;
  return { cache, pending, loading, errors, refresh };
}
