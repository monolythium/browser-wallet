// Hook-driven Activity tab body. Replaces the inline ActivityList that
// lived in components.tsx in the earlier monolithic layout.
//
// Hook integration order (per the plan):
//   1. useActivity(addr, chain)        → cache + pending
//   2. derive counterparty addresses    (deduped + lowercased)
//   3. useNameResolution(addrs, chain) + useIndexerStatus(chain)
//      run in parallel — neither depends on the other's result.
//
// Empty/error/stale state copy is locked verbatim per the plan.

import { useCallback, useMemo, useState } from "react";
import { bgDismissPendingTx } from "../bg.js";
import { useActivity } from "../hooks/useActivity.js";
import { useActivityKind } from "../hooks/useActivityKind.js";
import { useNameResolution } from "../hooks/useNameResolution.js";
import { useIndexerStatus } from "../hooks/useIndexerStatus.js";
import { ActivityRow } from "./ActivityRow.js";
import { ActivityDetail } from "./ActivityDetail.js";
import { IndexerStaleBanner } from "./IndexerStaleBanner.js";
import {
  confirmedRowDedupKey,
  mergeActivityNewestFirst,
  type ActivityRow as ActivityRowType,
} from "../../shared/activity.js";
import type { WalletActivityKindEnvelope } from "../../shared/activity-kind.js";
import type { NameLabel } from "../../shared/name-resolution.js";
import { type NotificationRecord } from "../../shared/notifications.js";
import { NotificationRow } from "./NotificationRow.js";
import { NotificationDetail } from "./NotificationDetail.js";

export interface ActivityListProps {
  /** Unlocked account address (0x form). Null while the wallet boots
   *  or post-lock. */
  addr: string | null;
  /** Active chain id hex. Null briefly during initial bootstrap. */
  chainIdHex: string | null;
  /** When true the chain is non-live (offline / quarantined / untrusted /
   *  regenesis / stalled): suppress the CONFIRMED on-chain history (it's stale /
   *  untrusted right now) but KEEP the user's own pending + failed rows — those
   *  are wallet-tracked, not untrusted chain reads, and hiding an in-flight tx
   *  at the moment it matters most would be worse than the stale-history problem
   *  this whole change addresses. A short note explains the suppression. */
  hideConfirmed?: boolean;
  /** Cluster directory (id → name) for delegation rows — threaded to the row
   *  bodies + detail so an indexer-fed numeric cluster id resolves to its real
   *  name, falling back to `Cluster #<id>` when unknown (no-mock). */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
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

/** Kind-aware empty state. The chain emits a typed
 *  `lyth_addressActivityKind` (chain commit d77e4fc) discriminating
 *  not_found / indexer_disabled / pruned / private / unknown. Each gets
 *  its own copy so the user understands what's actually going on
 *  rather than seeing the generic "no transactions yet" for every
 *  reason history is unavailable.
 *
 *  When `envelope` is null (probe in flight / chain unreachable), falls
 *  back to the historical generic empty state copy. */
function emptyState(envelope: WalletActivityKindEnvelope | null) {
  const base = {
    padding: "28px 18px",
    textAlign: "center" as const,
    fontSize: 12,
    color: "var(--fg-500)",
    lineHeight: 1.5,
  };
  if (envelope === null || envelope.kind === "not_found") {
    return (
      <div style={base}>
        No transactions yet. Send or receive LYTH to see history here.
      </div>
    );
  }
  if (envelope.kind === "indexer_disabled") {
    return (
      <div style={base}>
        <div style={{ marginBottom: 8 }}>
          Activity history unavailable on this network.
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-600)" }}>
          This operator does not serve the indexer endpoint. Try a different
          operator in Settings → Network.
        </div>
      </div>
    );
  }
  if (envelope.kind === "pruned") {
    const earliest = envelope.retention?.earliestRetained;
    const archive = envelope.retention?.archiveRedirect?.hint;
    return (
      <div style={base}>
        <div style={{ marginBottom: 8 }}>
          Older activity has been pruned by the indexer.
        </div>
        {earliest !== undefined && (
          <div style={{ fontSize: 11, color: "var(--fg-600)" }}>
            Showing activity from block {earliest} onward.
          </div>
        )}
        {archive && (
          <div style={{ fontSize: 11, color: "var(--fg-600)", marginTop: 6 }}>
            {archive}
          </div>
        )}
      </div>
    );
  }
  if (envelope.kind === "private") {
    return (
      <div style={base}>
        <div style={{ marginBottom: 8 }}>Private activity placeholder.</div>
        <div style={{ fontSize: 11, color: "var(--fg-600)" }}>
          Viewing your private transfers requires the meta-address surface
          shipping in Phase 12.
        </div>
      </div>
    );
  }
  // "unknown" — chain emitted a forward-compatible kind the wallet
  // doesn't recognise yet. Render the safe generic copy + a hint.
  return (
    <div style={base}>
      <div style={{ marginBottom: 8 }}>History temporarily unavailable.</div>
      <div style={{ fontSize: 11, color: "var(--fg-600)" }}>
        Your wallet may need an update to display this kind of activity.
      </div>
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

/** Note shown in the Activity tab while the chain is non-live (hideConfirmed):
 *  the confirmed on-chain history is suppressed (stale/untrusted right now), but
 *  the user's own pending + failed rows still render below when present. Copy is
 *  phrased as "unavailable" so it reads correctly for every non-live kind
 *  (offline / quarantined / untrusted / regenesis / stalled), not just offline. */
function SuppressedHistoryNote({ hasOwnRows }: { hasOwnRows: boolean }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 10.5,
        lineHeight: 1.6,
        color: "var(--fg-500)",
        letterSpacing: "0.02em",
        padding: hasOwnRows ? "10px 4px" : "20px 4px",
        textAlign: "center",
      }}
    >
      {hasOwnRows
        ? "Confirmed history is hidden while the chain is unavailable — your pending and failed transactions are still shown below."
        : "Activity is hidden while the chain is unavailable. It reappears automatically once the wallet reconnects."}
    </div>
  );
}

export function ActivityList({ addr, chainIdHex, hideConfirmed, clusterNameById }: ActivityListProps) {
  const { cache, pending, failed, loading, errors, refresh } = useActivity(
    addr,
    chainIdHex,
  );
  const indexerStatus = useIndexerStatus(chainIdHex);
  // Dismiss a TERMINAL (dropped/expired) pending row, then refresh. The SW
  // refuses to remove a durable claim or a still-live row, so this is safe.
  const handleDismissPending = useCallback(
    (txHash: string) => {
      if (!addr || !chainIdHex) return;
      void (async () => {
        await bgDismissPendingTx({ address: addr, chainIdHex, txHash });
        void refresh();
      })();
    },
    [addr, chainIdHex, refresh],
  );
  // Kind probe runs in parallel with the activity
  // fetch. Used only by the empty-state branch — when rows arrive,
  // the envelope is irrelevant.
  const activityKind = useActivityKind(addr, chainIdHex);

  // CX1 — row tapped → open the compact tx-detail modal.
  const [selected, setSelected] = useState<{
    row: ActivityRowType;
    label: NameLabel | undefined;
  } | null>(null);
  // Failed tx tapped → open the shared NotificationDetail popup (same
  // Status / Amount / To / Block / Date / View-on-Monoscan view the
  // notification center uses). Separate state since failed rows are
  // NotificationRecords, not ActivityRowType.
  const [selectedFailed, setSelectedFailed] = useState<NotificationRecord | null>(
    null,
  );

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

  // Confirmed on-chain history — SUPPRESSED while the chain is non-live
  // (hideConfirmed) since it's stale/untrusted right now. Pending + failed
  // (the wallet's own in-flight / failed sends) are always kept.
  const confirmed = useMemo(
    () => (hideConfirmed ? [] : cache?.confirmed ?? []),
    [hideConfirmed, cache],
  );
  // Single chronological list (newest-first), pending + confirmed + failed
  // interleaved — failed rows no longer pin to the top. `rows` (pending +
  // confirmed) is kept for the loading/empty/error guards below.
  const rows: ActivityRowType[] = useMemo(
    () => [...pending, ...confirmed],
    [pending, confirmed],
  );
  const merged = useMemo(
    () => mergeActivityNewestFirst(pending, confirmed, failed),
    [pending, confirmed, failed],
  );

  const hasIndexerError = !!errors.ipc || !!errors.addressActivity;

  return (
    <>
      {indexerStatus.status &&
        (indexerStatus.status.stale ||
          indexerStatus.status.schemaDrift ||
          indexerStatus.status.retention?.archiveRedirect) && (
          <IndexerStaleBanner
            stale={indexerStatus.status.stale}
            schemaDrift={indexerStatus.status.schemaDrift}
            archiveRedirect={
              indexerStatus.status.retention?.archiveRedirect ?? null
            }
          />
        )}
      {(() => {
        // While the chain is non-live we suppress confirmed history but still
        // show the user's pending/failed rows, so the loading/error/empty guards
        // (all about the confirmed indexer stream) must NOT fire — fall straight
        // through to the note + merged (pending+failed) render below.
        // Loading: first fetch hasn't returned AND nothing to show yet.
        if (
          !hideConfirmed &&
          loading &&
          cache === null &&
          pending.length === 0 &&
          failed.length === 0
        ) {
          return loadingSkeleton();
        }
        // IPC failure / total indexer outage with nothing to fall back to.
        if (!hideConfirmed && hasIndexerError && rows.length === 0 && failed.length === 0) {
          return errorState(() => void refresh());
        }
        // Empty state. The kind probe (useActivityKind) discriminates
        // not_found / indexer_disabled / pruned / private / unknown
        // so the user sees context-aware copy rather than the historical
        // generic "no transactions yet" for every absence reason.
        if (!hideConfirmed && rows.length === 0 && failed.length === 0) {
          return emptyState(activityKind.envelope);
        }
        // Live rows — pending + confirmed + failed merged into ONE list sorted
        // strictly newest-first (mergeActivityNewestFirst). Failed rows come
        // from the notification history (not the success-only indexer stream)
        // and render via NotificationRow; the rest via ActivityRow.
        return (
          <div>
            {hideConfirmed && <SuppressedHistoryNote hasOwnRows={merged.length > 0} />}
            {merged.map((item) => {
              if (item.tag === "failed") {
                const rec = item.record;
                return (
                  <NotificationRow
                    key={`failed-${rec.txHash}`}
                    record={rec}
                    showUnread={false}
                    onOpen={() => setSelectedFailed(rec)}
                  />
                );
              }
              const row = item.row;
              const cp = counterpartyOf(row);
              const label = cp ? labels.get(cp) : undefined;
              const key =
                row.kind === "pending_tx"
                  ? `pending-${row.txHash}`
                  : confirmedRowDedupKey(row);
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected({ row, label })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected({ row, label });
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <ActivityRow
                    row={row}
                    counterpartyLabel={label}
                    clusterNameById={clusterNameById}
                    onDismissPending={handleDismissPending}
                  />
                </div>
              );
            })}
          </div>
        );
      })()}
      {selected && addr && (
        <ActivityDetail
          row={selected.row}
          label={selected.label}
          walletAddr={addr}
          clusterNameById={clusterNameById}
          onClose={() => setSelected(null)}
        />
      )}
      {selectedFailed && (
        <NotificationDetail
          record={selectedFailed}
          onClose={() => setSelectedFailed(null)}
        />
      )}
    </>
  );
}
