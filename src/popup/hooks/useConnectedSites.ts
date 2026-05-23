// Reactive read of the persisted connected-sites map. The SW writes the map
// to chrome.storage.local on every save / remove / clear, so the popup can
// subscribe to onChanged for free reactivity. Mirrors the useApprovalQueue
// pattern (filter by area, then by key, then dispatch).

import { useEffect, useState } from "react";
import { STORAGE_KEY_CONNECTED_SITES } from "../../shared/constants";
import type { ConnectedSitesMap } from "../bg";

export interface UseConnectedSitesResult {
  sites: ConnectedSitesMap;
  loading: boolean;
}

export function useConnectedSites(): UseConnectedSitesResult {
  const [sites, setSites] = useState<ConnectedSitesMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(STORAGE_KEY_CONNECTED_SITES, (res) => {
      if (cancelled) return;
      const map =
        (res?.[STORAGE_KEY_CONNECTED_SITES] as ConnectedSitesMap | undefined) ??
        {};
      setSites(map);
      setLoading(false);
    });

    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY_CONNECTED_SITES];
      if (!change) return;
      setSites((change.newValue as ConnectedSitesMap | undefined) ?? {});
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return { sites, loading };
}
