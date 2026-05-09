// Reactive read of the SW approval queue. The SW mirrors its in-memory
// pending Map to chrome.storage.local on every enqueue/dequeue, so the
// popup can subscribe to storage changes for free reactivity — no
// runtime message channel needed. Pattern matches the lock-state listener
// in App.tsx (filter by area, then by key, then dispatch).

import { useEffect, useState } from "react";
import { STORAGE_KEY_PENDING_APPROVALS } from "../../shared/constants";
import type { PendingApproval } from "../bg";

export interface UseApprovalQueueResult {
  queue: PendingApproval[];
  loading: boolean;
}

export function useApprovalQueue(): UseApprovalQueueResult {
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(STORAGE_KEY_PENDING_APPROVALS, (res) => {
      if (cancelled) return;
      const list =
        (res?.[STORAGE_KEY_PENDING_APPROVALS] as PendingApproval[] | undefined) ?? [];
      setQueue(list);
      setLoading(false);
    });

    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY_PENDING_APPROVALS];
      if (!change) return;
      setQueue((change.newValue as PendingApproval[] | undefined) ?? []);
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return { queue, loading };
}
