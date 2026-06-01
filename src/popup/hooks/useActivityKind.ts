// Typed AddressActivityKind probe hook.
//
// Mirrors useActivity / useIndexerStatus for the chrome.storage +
// race-protection pattern, but the activity-kind read is one-shot per
// (addr, chain) — no polling, no storage cache. The chain method is
// cheap (one O(1) index lookup) and the popup re-mounts the hook
// whenever the address or chain changes, which is when the answer
// might differ.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ACTIVITY_KIND_ENVELOPE,
  type WalletActivityKindEnvelope,
} from "../../shared/activity-kind.js";
import { bgWalletActivityKind } from "../bg.js";

export interface UseActivityKindResult {
  /** The typed envelope from the chain (or the safe defensive default
   *  when the chain method isn't reachable). Null until the first IPC
   *  reply lands. */
  envelope: WalletActivityKindEnvelope | null;
  /** True until the first IPC reply resolves for the current addr. */
  loading: boolean;
  /** Imperative re-fetch. */
  refresh: () => Promise<void>;
}

const EMPTY: UseActivityKindResult = {
  envelope: null,
  loading: false,
  refresh: async () => {},
};

export function useActivityKind(
  addr: string | null,
  chainIdHex: string | null,
): UseActivityKindResult {
  const [envelope, setEnvelope] = useState<WalletActivityKindEnvelope | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!addr || !addr.startsWith("0x")) return;
    const myToken = ++tokenRef.current;
    try {
      const r = await bgWalletActivityKind(addr);
      if (myToken !== tokenRef.current) return;
      setLoading(false);
      setEnvelope(r.envelope);
    } catch {
      if (myToken !== tokenRef.current) return;
      setLoading(false);
      setEnvelope({
        ...DEFAULT_ACTIVITY_KIND_ENVELOPE,
        address: addr.toLowerCase(),
      });
    }
  }, [addr]);

  useEffect(() => {
    if (!addr || !chainIdHex || !addr.startsWith("0x")) {
      setEnvelope(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setEnvelope(null);
    void refresh();
    return () => {
      tokenRef.current++;
    };
  }, [addr, chainIdHex, refresh]);

  if (!addr || !chainIdHex || !addr.startsWith("0x")) return EMPTY;
  return { envelope, loading, refresh };
}
