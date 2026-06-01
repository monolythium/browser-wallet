// Reactive read of the activity cache. Mirrors useApprovalQueue.ts
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
import {
  notificationsHistoryKey,
  type NotificationRecord,
} from "../../shared/notifications.js";
import { bgWalletActivityGet, bgWalletActivityFailed } from "../bg.js";

export interface UseActivityResult {
  /** Confirmed-row cache. Null until the first IPC reply lands. */
  cache: ActivityCache | null;
  /** Synthetic pending rows from local Send broadcasts. */
  pending: PendingTxRow[];
  /** Failed txs (status:"failed") for this (addr, chain), newest-first —
   *  sourced from the notification history since the indexer activity stream
   *  is success-only. Rendered as red "<Type> failed" rows. */
  failed: NotificationRecord[];
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
  failed: [],
  loading: false,
  errors: {},
  refresh: async () => {},
};

export function useActivity(
  addr: string | null,
  chainIdHex: string | null,
): UseActivityResult {
  const [cache, setCache] = useState<ActivityCache | null>(null);
  const [pending, setPending] = useState<PendingTxRow[]>([]);
  const [failed, setFailed] = useState<NotificationRecord[]>([]);
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
    // Skip the IPC + cache write when the address is one
    // of the popup demo-data sentinels. The popup's initial state seeds
    // `acc = ACCOUNTS[0]` whose addr is `0xa9f2…0001`; the
    // `wallet-active-account` IPC then replaces it with the real
    // unlocked vault address. Without this guard the brief demo-state
    // window fires a real `wallet-activity-get` IPC, which writes
    // `mono.activity.<demo-addr>.<chainId>` into chrome.storage —
    // confirmed in a storage dump. Guarding here is the
    // cheapest defense (no IPC, no cache); the SW boot also runs a
    // one-shot migration to remove pre-existing sentinel cache keys.
    if (isDemoAddrSentinel(addr)) return;
    const myToken = ++tokenRef.current;
    // Activity (indexer cache + pending) and failed (notification history)
    // are independent reads — fetch in parallel so the failed rows don't add
    // a second round-trip of latency.
    const [r, fr] = await Promise.all([
      bgWalletActivityGet(addr, chainIdHex),
      bgWalletActivityFailed(addr, chainIdHex),
    ]);
    if (myToken !== tokenRef.current) return;
    setLoading(false);
    // `failed` is independent of the activity fetch outcome — set it whenever
    // the read succeeded, even if the indexer fetch errored.
    if (fr.ok) setFailed(fr.failed);
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
      setFailed([]);
      setLoading(false);
      setErrors({});
      return;
    }
    // Fresh dep — reset to loading and kick the fetch.
    setLoading(true);
    setCache(null);
    setPending([]);
    setFailed([]);
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
    // Notification history is where failed txs live; watch it so a tx that
    // fails while a surface is open surfaces its red row promptly (the SW
    // writes the failed record in a post-response microtask, so the in-band
    // fetch above can miss it — this picks up that write).
    const historyKey = notificationsHistoryKey(addr.toLowerCase(), chainIdHex);
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
      if (historyKey in changes) {
        void refresh();
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

  // Bug A F2 — the short-interval re-poll while a tx is pending now lives at the
  // App level (src/popup/App.tsx, PENDING_REPOLL_MS) so it runs on EVERY screen
  // while the popup is open, not just the Activity tab. That poll drives the
  // SW reconcile; the cache/pending state here stays live via the onChanged
  // listener above (and the background alarm still covers the closed-surface case).

  if (!addr || !chainIdHex || !addr.startsWith("0x")) return EMPTY;
  return { cache, pending, failed, loading, errors, refresh };
}
