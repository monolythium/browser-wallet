// Phase 9 — Two-tier UX feature toggles (§28.5 Q29).
//
// What this module owns
// =====================
// Pure types + algorithms for the wallet's optional advanced surfaces.
// No `chrome.storage`, no module-scope state — every helper here is
// deterministic and testable in vitest. The storage round-trip lives
// in the service worker (under `chrome.storage.local["mono.two-tier-
// features.v1"]`); IPC dispatch lives in service-worker.ts; the UI
// lives in popup/.
//
// Design (§28.5 Q29)
// ==================
// > "Settings toggles for trading interface, marketplace, AI features,
// > registry. Single wallet binary, progressive disclosure. NOT a
// > separate AI-enhanced wallet. Default state minimal; user flips on
// > advanced surfaces."
//
// Default state is ALL OFF. The wallet ships as a streamlined "send +
// receive + stake" experience; power users opt into each advanced
// surface independently. Flipping a toggle is sticky — `firstSeenAt`
// records when the user first enabled the feature so a future "what's
// new since you turned this on" affordance can hook in cleanly.
//
// Why a single namespace + a feature enum (not per-feature storage
// keys): every read path needs to inspect the full toggle map (the
// `useFeature` hook fans out across components), so a single
// `chrome.storage.local.get` is cheaper than four. A `Record<flag,
// state>` shape also makes the storage round-trip trivial to fuzz.

/** Enumerated feature flags. Append-only — never reuse a flag value
 *  after retiring it, because old stored state under the retired key
 *  must remain parseable (we ignore unknown keys on read, but they
 *  must not collide with new keys). */
export const FEATURE_FLAGS = [
  "TRADING_INTERFACE",
  "MARKETPLACE",
  "AI_FEATURES",
  "REGISTRY",
  "AGENT_COMMERCE",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** Per-feature state. `enabled` drives gating; `firstSeenAt` is the
 *  timestamp of the FIRST true-flip and persists across subsequent
 *  off/on cycles — useful for "new since you enabled this" affordances
 *  and for analytics-free retention sniffing. */
export interface FeatureState {
  enabled: boolean;
  /** Date.now() when the user first turned the feature on. `null`
   *  for features that have never been enabled (default state). */
  firstSeenAt: number | null;
}

/** Full map. Always carries every flag — read paths can index without
 *  defensive presence checks. Storage migrations / unknown-key drops
 *  rebuild this shape on every load. */
export type TwoTierState = Record<FeatureFlag, FeatureState>;

/** Storage key — versioned so a future shape bump can land cleanly. */
export const STORAGE_KEY_TWO_TIER_FEATURES = "mono.two-tier-features.v1";

/** Fresh state — every feature OFF. */
export function defaultTwoTierState(): TwoTierState {
  const out = {} as TwoTierState;
  for (const flag of FEATURE_FLAGS) {
    out[flag] = { enabled: false, firstSeenAt: null };
  }
  return out;
}

/** Normalise an opaque storage blob into a `TwoTierState`. Tolerant
 *  of partial / unknown-key inputs — every recognised flag is
 *  reconstructed; everything else is silently dropped. Used by the
 *  service worker on load and by tests that fuzz storage corruption. */
export function normaliseTwoTierState(raw: unknown): TwoTierState {
  const out = defaultTwoTierState();
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const flag of FEATURE_FLAGS) {
    const entry = rec[flag];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.enabled === "boolean") {
      out[flag].enabled = e.enabled;
    }
    if (typeof e.firstSeenAt === "number" && Number.isFinite(e.firstSeenAt)) {
      out[flag].firstSeenAt = e.firstSeenAt;
    } else if (e.firstSeenAt === null) {
      out[flag].firstSeenAt = null;
    }
  }
  return out;
}

/** Flip one feature's enabled bit. If this is the first-ever enable,
 *  stamp `firstSeenAt` with `now`. Returns a fresh state without
 *  mutating the input. */
export function setFeature(
  state: TwoTierState,
  flag: FeatureFlag,
  enabled: boolean,
  now: number,
): TwoTierState {
  const prev = state[flag];
  const firstSeenAt =
    enabled && prev.firstSeenAt === null ? now : prev.firstSeenAt;
  return {
    ...state,
    [flag]: { enabled, firstSeenAt },
  };
}

/** Convenience reader — `state[flag].enabled` with the right type. */
export function isFeatureEnabled(
  state: TwoTierState,
  flag: FeatureFlag,
): boolean {
  return state[flag].enabled;
}

/** Human-readable label + tagline for each flag. Used by Features
 *  page (Commit 5) and by any disabled-surface "Enable in Settings"
 *  affordance. Kept here so the labels travel with the enum. */
export interface FeatureMeta {
  label: string;
  tagline: string;
}

export const FEATURE_META: Record<FeatureFlag, FeatureMeta> = {
  TRADING_INTERFACE: {
    label: "Trading interface",
    tagline:
      "Advanced staking analytics + spot CLOB surfaces (§14, §23). Hidden by default.",
  },
  MARKETPLACE: {
    label: "Marketplace",
    tagline:
      "Rich NFT detail + filters + agent-commerce listing surfaces (§24).",
  },
  AI_FEATURES: {
    label: "AI features",
    tagline:
      "MCP Copilot conversational assistant (§28.5, lands in a future phase).",
  },
  REGISTRY: {
    label: "Name registry",
    tagline:
      "Hierarchical name resolution + registration UI (§22.8 lookup + future register flow).",
  },
  AGENT_COMMERCE: {
    label: "Agent commerce (experimental)",
    tagline:
      "Agent spending-policy sub-accounts (§18.8), bridge route risk disclosure (§20.2 / §25.2), and cluster roster-diversity scoring (§25.1). Experimental — hidden by default.",
  },
};
