// §28.2.1 indexer-staleness banner. Renders above the Activity list
// when useIndexerStatus(chainIdHex).status?.stale === true. Per-session
// dismiss: a `useState<boolean>` flag flips to dismissed when the user
// clicks ×. NO chrome.storage persistence — opening a fresh popup
// session shows the banner again until dismissed in that session.
// Reason: indexer lag is a transient runtime condition, not a user
// preference. Persisting dismissal across sessions would hide a real
// degradation from a user who came back hours later.

import { useState } from "react";

export interface IndexerStaleBannerProps {
  /** Pass the resolved staleness flag from useIndexerStatus. The banner
   *  is a controlled component — it renders only when `stale` is true
   *  AND the user hasn't dismissed it in this session. */
  stale: boolean;
}

export function IndexerStaleBanner({ stale }: IndexerStaleBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  // When `stale` flips from true to false (indexer caught up), reset
  // dismissed so the banner is ready to show again if it stales later.
  // useState alone keeps `dismissed=true` indefinitely; we reset
  // implicitly by NOT rendering the component when !stale.
  if (!stale || dismissed) return null;
  return (
    <div className="ext-indexer-stale" role="status" aria-live="polite">
      <span className="text">
        Indexer lagging — most recent activity may be missing.
      </span>
      <button
        type="button"
        className="close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss indexer-stale banner for this session"
      >
        ×
      </button>
    </div>
  );
}
