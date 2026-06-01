// §28.2.1 indexer-staleness banner. Renders above the Activity list
// when useIndexerStatus(chainIdHex).status?.stale === true. Per-session
// dismiss: a `useState<boolean>` flag flips to dismissed when the user
// clicks ×. NO chrome.storage persistence — opening a fresh popup
// session shows the banner again until dismissed in that session.
// Reason: indexer lag is a transient runtime condition, not a user
// preference. Persisting dismissal across sessions would hide a real
// degradation from a user who came back hours later.
//
// Extended with two new banner classes:
//   - schemaDrift   → "wallet needs update — indexer schema is newer"
//   - retentionHint → archive-redirect hint when the indexer rolling
//                      window starts after the user's earliest tx.
// Both are advisory only; the activity feed still renders whatever
// data it has. Dismissal is per-session per banner class.

import { useState } from "react";

export interface IndexerStaleBannerProps {
  /** Pass the resolved staleness flag from useIndexerStatus. The banner
   *  is a controlled component — it renders only when `stale` is true
   *  AND the user hasn't dismissed it in this session. */
  stale: boolean;
  /** Chain's schemaVersion exceeds the wallet's
   *  known version. Optional; defaults to false. When true, a second
   *  banner row renders below the stale row (or alone) prompting the
   *  user to update. */
  schemaDrift?: boolean;
  /** Optional archive-redirect hint from the chain
   *  indexer. When non-null, a third banner row renders. The string is
   *  rendered verbatim — chain authors the user-facing copy. */
  archiveRedirect?: string | null;
}

export function IndexerStaleBanner({
  stale,
  schemaDrift = false,
  archiveRedirect = null,
}: IndexerStaleBannerProps) {
  const [dismissedStale, setDismissedStale] = useState(false);
  const [dismissedDrift, setDismissedDrift] = useState(false);
  const [dismissedArchive, setDismissedArchive] = useState(false);
  // When `stale` flips from true to false (indexer caught up), reset
  // dismissed so the banner is ready to show again if it stales later.
  // useState alone keeps `dismissed=true` indefinitely; we reset
  // implicitly by NOT rendering the component when !stale.
  const showStale = stale && !dismissedStale;
  const showDrift = schemaDrift && !dismissedDrift;
  const showArchive = archiveRedirect !== null && !dismissedArchive;
  if (!showStale && !showDrift && !showArchive) return null;
  return (
    <>
      {showStale && (
        <div className="ext-indexer-stale" role="status" aria-live="polite">
          <span className="text">
            Indexer lagging — most recent activity may be missing.
          </span>
          <button
            type="button"
            className="close"
            onClick={() => setDismissedStale(true)}
            aria-label="Dismiss indexer-stale banner for this session"
          >
            ×
          </button>
        </div>
      )}
      {showDrift && (
        <div className="ext-indexer-stale" role="status" aria-live="polite">
          <span className="text">
            Wallet update available — indexer is reporting a newer schema.
          </span>
          <button
            type="button"
            className="close"
            onClick={() => setDismissedDrift(true)}
            aria-label="Dismiss schema-drift hint for this session"
          >
            ×
          </button>
        </div>
      )}
      {showArchive && (
        <div className="ext-indexer-stale" role="status" aria-live="polite">
          <span className="text">{archiveRedirect}</span>
          <button
            type="button"
            className="close"
            onClick={() => setDismissedArchive(true)}
            aria-label="Dismiss archive-redirect hint for this session"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
