// Periodic polling of the indexer-staleness signal for the §28.2.1
// banner. Polls on mount, on visibility-regained, and every 30 s while
// the hook is mounted (Home is the only mount site; navigating away
// unmounts the hook and stops the polling).
//
// No storage listener: indexer status isn't cached in popup-readable
// storage. The SW writes the method-gate at mono.indexerStatus.method-gate
// but that's a per-chain "method missing" marker, not the status
// itself — the status query is always live RPC (or short-circuited by
// the gate to a defensive default per commit 7).

import { useCallback, useEffect, useRef, useState } from "react";
import { bgWalletIndexerStatus, type IndexerStatusView } from "../bg.js";

const POLL_INTERVAL_MS = 30_000;

export interface UseIndexerStatusResult {
  /** Resolved staleness state. Null until the first IPC reply lands. */
  status: IndexerStatusView | null;
  /** Imperative re-poll. */
  refresh: () => Promise<void>;
}

const EMPTY: UseIndexerStatusResult = {
  status: null,
  refresh: async () => {},
};

export function useIndexerStatus(
  chainIdHex: string | null,
): UseIndexerStatusResult {
  const [status, setStatus] = useState<IndexerStatusView | null>(null);
  // Race protection mirrors useActivity / balanceTokenRef. A slow IPC
  // reply for a previous chain must not overwrite the current state.
  const tokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!chainIdHex) return;
    const myToken = ++tokenRef.current;
    const r = await bgWalletIndexerStatus(chainIdHex);
    if (myToken !== tokenRef.current) return;
    if (!r.ok) {
      // Defensive: treat IPC failure the same as the SW's "method
      // unavailable" defensive return — no stale banner, no fake
      // numbers. The user just sees the previous state.
      return;
    }
    setStatus(r.status);
  }, [chainIdHex]);

  useEffect(() => {
    if (!chainIdHex) {
      setStatus(null);
      return;
    }
    // Initial fetch on mount or chain change.
    void refresh();

    // 30 s background poll while mounted. We only set up the interval
    // when document is visible; the visibility listener restarts it on
    // regain. Hidden popups have no reason to ping the indexer.
    let intervalId: number | null = null;
    const startInterval = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void refresh();
      }, POLL_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };
    if (document.visibilityState === "visible") startInterval();

    const onVis = () => {
      if (document.visibilityState === "visible") {
        // Visibility-regained: refresh immediately and resume the poll.
        void refresh();
        startInterval();
      } else {
        stopInterval();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      // Invalidate in-flight IPC + tear down listener + interval.
      tokenRef.current++;
      document.removeEventListener("visibilitychange", onVis);
      stopInterval();
    };
  }, [chainIdHex, refresh]);

  if (!chainIdHex) return EMPTY;
  return { status, refresh };
}
