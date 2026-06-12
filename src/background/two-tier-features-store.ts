// chrome.storage round-trip for two-tier UX feature toggles.
//
// Single namespace at `chrome.storage.local["mono.two-tier-features.v1"]`.
// Read paths fan out across components (`useFeature(flag)` is hot), so
// the get-all-flip-one shape is the right primitive — one storage hit
// per toggle change, one cached read per popup load.

import {
  STORAGE_KEY_TWO_TIER_FEATURES,
  normaliseTwoTierState,
  setFeature,
  type FeatureFlag,
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

export async function setTwoTierFeature(
  flag: FeatureFlag,
  enabled: boolean,
): Promise<TwoTierState> {
  const current = await loadTwoTierState();
  const next = setFeature(current, flag, enabled, Date.now());
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [STORAGE_KEY_TWO_TIER_FEATURES]: next },
      () => resolve(next),
    );
  });
}
