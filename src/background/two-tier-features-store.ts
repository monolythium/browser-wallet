// chrome.storage READ for two-tier UX feature toggles (service-worker side).
//
// Single namespace at `chrome.storage.local["mono.two-tier-features.v1"]`.
// This is the SW's read side, used by the `two-tier-get-state` IPC. The WRITE
// is applied popup-side (bg.ts `bgTwoTierSetFeature`) directly to the same key,
// so a toggle flips instantly without waking the worker — see the note in
// shared/two-tier-features.ts.

import {
  STORAGE_KEY_TWO_TIER_FEATURES,
  normaliseTwoTierState,
  type TwoTierState,
} from "../shared/two-tier-features.js";

export async function loadTwoTierState(): Promise<TwoTierState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_TWO_TIER_FEATURES, (got) => {
      const raw = got?.[STORAGE_KEY_TWO_TIER_FEATURES];
      resolve(normaliseTwoTierState(raw));
    });
  });
}
