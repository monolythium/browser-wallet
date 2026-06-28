// Issue B — durable over-cap rejection banner. An over-cap delegate/redelegate
// is rejected (client-side pre-flight, or the chain at admission) WITHOUT
// creating a pending/activity row — so the only prior signal was the Stake
// error page, which is lost the moment the user navigates away. This banner is
// driven by App-level state (App does not unmount on a screen switch), so it
// SURVIVES navigation. Controlled component: the parent owns the rejection
// state, clears it on account/chain change + on a later success, and passes
// `onDismiss`. No persistence — a transient rejection, not a preference.

export interface DelegationRejection {
  /** The cluster the weight would have landed on (delegate: the selected
   *  cluster; redelegate: the destination) — the one that exceeded the cap. */
  clusterId: number;
  clusterName: string | null;
  kind: "delegate" | "undelegate" | "redelegate";
  /** The cap message (PER_WALLET_CAP_REVERT_MESSAGE / WALLET_TOTAL_CAP_REVERT_MESSAGE). */
  message: string;
  /** Capture time — lets the render de-dupe on `(clusterId, atMs)`. */
  atMs: number;
}

export interface DelegationRejectedBannerProps {
  rejection: DelegationRejection | null;
  onDismiss: () => void;
}

export function DelegationRejectedBanner({
  rejection,
  onDismiss,
}: DelegationRejectedBannerProps) {
  if (rejection === null) return null;
  const where = rejection.clusterName ?? `cluster #${rejection.clusterId}`;
  return (
    <div
      className="ext-indexer-stale ext-deleg-rejected"
      role="alert"
      aria-live="assertive"
    >
      <span className="text">
        Delegation to {where} rejected — {rejection.message}
      </span>
      <button
        type="button"
        className="close"
        onClick={onDismiss}
        aria-label="Dismiss delegation-rejected notice"
      >
        ×
      </button>
    </div>
  );
}
