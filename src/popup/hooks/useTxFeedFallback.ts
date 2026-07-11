// #B3-2 indexer-OFF activity fallback. When the per-address activity timeline is
// empty for a BENIGN reason (indexer disabled / genuinely empty — see
// `txFeedFallbackEnabled`), fetch recent activity from the GLOBAL `lyth_txFeed`
// (block-scan-backed, so indexer-OFF operators still serve it), FILTERED to this
// address. Fires ONCE per (addr, chain) enable — NOT on every poll — via the
// coalesced, auto-lock-exempt `wallet-activity-txfeed` IPC.
//
// No-mock: a failed or empty txFeed yields no rows, so the popup keeps its honest
// empty state (never fabricated activity). Disabled → always empty.

import { useEffect, useRef, useState } from "react";
import { bgWalletActivityTxFeed } from "../bg.js";
import type { ConfirmedRow } from "../../shared/activity.js";

export interface UseTxFeedFallbackResult {
  /** Mapped fallback rows (empty when disabled, loading, failed, or none). */
  rows: ConfirmedRow[];
  /** True while the one-shot fetch is in flight (for a loading placeholder). */
  loading: boolean;
}

export function useTxFeedFallback(
  addr: string | null,
  chainIdHex: string | null,
  enabled: boolean,
): UseTxFeedFallbackResult {
  const [rows, setRows] = useState<ConfirmedRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Race guard (mirrors useActivity.tokenRef): a stale reply from a prior
  // (addr, chain, enabled) can't overwrite the current one.
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!enabled || !addr || !chainIdHex || !addr.startsWith("0x")) {
      tokenRef.current++;
      setRows([]);
      setLoading(false);
      return;
    }
    const myToken = ++tokenRef.current;
    setLoading(true);
    void (async () => {
      const r = await bgWalletActivityTxFeed(addr, chainIdHex);
      if (myToken !== tokenRef.current) return;
      setLoading(false);
      // A failed txFeed → honest empty (no fabrication); success → mapped rows.
      setRows(r.ok ? r.rows : []);
    })();

    return () => {
      tokenRef.current++;
    };
  }, [addr, chainIdHex, enabled]);

  return { rows, loading };
}
