// Hook-driven Activity tab body. Replaces the inline ActivityList that
// lived in components.tsx through Phase 4.3.
//
// Hook integration order (per the plan):
//   1. useActivity(addr, chain)        → cache + pending
//   2. derive counterparty addresses    (deduped + lowercased)
//   3. useNameResolution(addrs, chain) + useIndexerStatus(chain)
//      run in parallel — neither depends on the other's result.
//
// Empty/error/stale state copy is locked verbatim per the plan.

import { useMemo } from "react";
import { useActivity } from "../hooks/useActivity.js";
import { useNameResolution } from "../hooks/useNameResolution.js";
import { useIndexerStatus } from "../hooks/useIndexerStatus.js";
import { ActivityRow } from "./ActivityRow.js";
import { IndexerStaleBanner } from "./IndexerStaleBanner.js";
import type { ActivityRow as ActivityRowType } from "../../shared/activity.js";

export interface ActivityListProps {
  /** Unlocked account address (0x form). Null while the wallet boots
   *  or post-lock. */
  addr: string | null;
  /** Active chain id hex. Null briefly during initial bootstrap. */
  chainIdHex: string | null;
}

function counterpartyOf(row: ActivityRowType): string | null {
  switch (row.kind) {
    case "pending_tx":
      return row.to;
    case "tx_send":
    case "tx_receive":
    case "token_transfer":
      return row.counterparty;
    default:
      // delegate / undelegate / redelegate / rebalance / crossing don't
      // have a name-resolvable counterparty (cluster ids render as
      // C-NNN.cluster.mono inline; stealth addresses are opaque).
      return null;
  }
}

function loadingSkeleton() {
  // Three placeholder rows in the same .ext-act-row grid so the column
  // alignment doesn't shift when real rows replace these. Slight pulse
  // via inline opacity animation would be nicer; keeping it static here
  // (no @keyframes spend in this commit per the plan; spin keyframe in
  // commit 12 is the only motion we ship).
  return (
    <div>
      {[0, 1, 2].map((i) => (
        <div className="ext-act-row" key={`skel-${i}`} style={{ opacity: 0.4 }}>
          <div className="dir out" style={{ background: "var(--ink-300)" }} />
          <div className="ext-act-row__main">
            <div
              className="ext-act-row__who"
              style={{
                background: "var(--ink-300)",
                borderRadius: 4,
                color: "transparent",
              }}
            >
              loading-placeholder-row
            </div>
            <div
              className="ext-act-row__meta"
              style={{
                background: "var(--ink-300)",
                borderRadius: 3,
                marginTop: 4,
                width: 80,
                height: 8,
              }}
            />
          </div>
          <div className="ext-act-row__right">
            <div
              className="amt"
              style={{
                background: "var(--ink-300)",
                borderRadius: 3,
                color: "transparent",
              }}
            >
              0.00
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function emptyState() {
  return (
    <div
      style={{
        padding: "28px 18px",
        textAlign: "center",
        fontSize: 12,
        color: "var(--fg-500)",
        lineHeight: 1.5,
      }}
    >
      No transactions yet. Send or receive LYTH to see history here.
    </div>
  );
}

function errorState(onRetry: () => void) {
  return (
    <button
      type="button"
      onClick={onRetry}
      style={{
        width: "100%",
        padding: "20px 18px",
        textAlign: "center",
        fontSize: 12,
        color: "var(--err)",
        lineHeight: 1.5,
        background: "transparent",
        border: 0,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      Couldn't fetch activity. Tap to retry.
    </button>
  );
}

export function ActivityList({ addr, chainIdHex }: ActivityListProps) {
  const { cache, pending, loading, errors, refresh } = useActivity(
    addr,
    chainIdHex,
  );
  const indexerStatus = useIndexerStatus(chainIdHex);

  // Derive counterparty addresses for name resolution. Pulls from both
  // confirmed rows and pending rows so a Pending row's recipient also
  // gets a label if one is registered. Deduped + lowercased per commit
  // 10's input contract; SW handler defends as well.
  const counterpartyAddrs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const collect = (a: string | null) => {
      if (!a) return;
      const lower = a.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      out.push(lower);
    };
    if (cache) for (const r of cache.confirmed) collect(counterpartyOf(r));
    for (const r of pending) collect(counterpartyOf(r));
    return out.sort();
  }, [cache, pending]);

  const { labels } = useNameResolution(counterpartyAddrs, chainIdHex);

  // Composite list: pending first (newest broadcasts at top), then
  // confirmed (already newest-first per mergeIndexerSnapshot).
  const rows: ActivityRowType[] = useMemo(() => {
    if (!cache) return [...pending];
    return [...pending, ...cache.confirmed];
  }, [cache, pending]);

  const hasIndexerError = !!errors.ipc || !!errors.addressActivity;

  return (
    <>
      {indexerStatus.status?.stale && (
        <IndexerStaleBanner stale={indexerStatus.status.stale} />
      )}
      {(() => {
        // Loading: first fetch hasn't returned AND cache is null.
        if (loading && cache === null && pending.length === 0) {
          return loadingSkeleton();
        }
        // IPC failure / total indexer outage with no cache to fall back to.
        if (hasIndexerError && rows.length === 0) {
          return errorState(() => void refresh());
        }
        // Empty state.
        if (rows.length === 0) return emptyState();
        // Live rows.
        return (
          <div>
            {rows.map((row) => {
              const cp = counterpartyOf(row);
              const label = cp ? labels.get(cp) : undefined;
              const key =
                row.kind === "pending_tx"
                  ? `pending-${row.txHash}`
                  : `${row.blockHeight}-${row.txIndex}-${row.logIndex}-${row.kind}`;
              return (
                <ActivityRow key={key} row={row} counterpartyLabel={label} />
              );
            })}
          </div>
        );
      })()}
    </>
  );
}
