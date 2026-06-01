// useFeature hook.
//
// Returns the current enabled state of a two-tier UX feature flag
// and keeps the value in sync via the `chrome.storage` change
// listener. Loaded once on mount; re-renders when the underlying
// `mono.two-tier-features.v1` entry changes (either via this popup's
// Features page or via the SW).
//
// Default value is `false` — every flag ships disabled (§28.5 Q29).
// The hook returns `false` until the first storage read resolves so
// the initial render of any gated surface stays hidden by default
// (the safer-by-default direction).

import { useEffect, useState } from "react";

import { bgTwoTierGetState } from "../bg.js";
import {
  STORAGE_KEY_TWO_TIER_FEATURES,
  normaliseTwoTierState,
  type FeatureFlag,
} from "../../shared/two-tier-features.js";

export function useFeature(flag: FeatureFlag): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const r = await bgTwoTierGetState();
      if (cancelled) return;
      if (r.ok) setEnabled(r.state[flag].enabled);
    })();

    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      const c = changes[STORAGE_KEY_TWO_TIER_FEATURES];
      if (!c) return;
      const state = normaliseTwoTierState(c.newValue);
      setEnabled(state[flag].enabled);
    };
    chrome.storage.local.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.local.onChanged.removeListener(listener);
    };
  }, [flag]);

  return enabled;
}
