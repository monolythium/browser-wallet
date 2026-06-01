// Unit tests for the two-tier UX feature toggle state machine.

import { describe, it, expect } from "vitest";
import {
  FEATURE_FLAGS,
  defaultTwoTierState,
  isFeatureEnabled,
  normaliseTwoTierState,
  setFeature,
} from "./two-tier-features.js";

describe("defaultTwoTierState", () => {
  it("returns every flag disabled with firstSeenAt=null", () => {
    const s = defaultTwoTierState();
    for (const flag of FEATURE_FLAGS) {
      expect(s[flag]).toEqual({ enabled: false, firstSeenAt: null });
    }
  });

  it("registers the AGENT_COMMERCE flag, default OFF", () => {
    // The v5 pillar surfaces (agent spending-policy page, bridge route
    // risk panel, cluster roster-diversity card) gate on this flag. It
    // must ship disabled so the popup matches the pre-v5 experience until
    // the user opts in via Settings → Features.
    expect(FEATURE_FLAGS).toContain("AGENT_COMMERCE");
    const s = defaultTwoTierState();
    expect(s.AGENT_COMMERCE).toEqual({ enabled: false, firstSeenAt: null });
    expect(isFeatureEnabled(s, "AGENT_COMMERCE")).toBe(false);
  });

  it("treats unknown / empty stored state as AGENT_COMMERCE off", () => {
    // A fresh install (no stored blob) and a pre-v5 stored blob that
    // predates the flag both normalise to the default-off shape.
    expect(isFeatureEnabled(normaliseTwoTierState(null), "AGENT_COMMERCE")).toBe(
      false,
    );
    expect(
      isFeatureEnabled(
        normaliseTwoTierState({ TRADING_INTERFACE: { enabled: true, firstSeenAt: 1 } }),
        "AGENT_COMMERCE",
      ),
    ).toBe(false);
  });
});

describe("setFeature", () => {
  it("flips the enabled bit and stamps firstSeenAt on first enable", () => {
    const s0 = defaultTwoTierState();
    const s1 = setFeature(s0, "TRADING_INTERFACE", true, 1234);
    expect(s1.TRADING_INTERFACE).toEqual({ enabled: true, firstSeenAt: 1234 });
    // others untouched
    expect(s1.MARKETPLACE).toEqual({ enabled: false, firstSeenAt: null });
  });

  it("preserves firstSeenAt on off/on cycles", () => {
    let s = defaultTwoTierState();
    s = setFeature(s, "MARKETPLACE", true, 1000);
    s = setFeature(s, "MARKETPLACE", false, 2000);
    s = setFeature(s, "MARKETPLACE", true, 3000);
    expect(s.MARKETPLACE).toEqual({ enabled: true, firstSeenAt: 1000 });
  });

  it("does not stamp firstSeenAt when flipping to false", () => {
    let s = defaultTwoTierState();
    s = setFeature(s, "AI_FEATURES", false, 999);
    expect(s.AI_FEATURES.firstSeenAt).toBeNull();
  });

  it("returns a fresh object — input is untouched", () => {
    const s0 = defaultTwoTierState();
    const s1 = setFeature(s0, "REGISTRY", true, 1);
    expect(s0.REGISTRY.enabled).toBe(false);
    expect(s1).not.toBe(s0);
  });
});

describe("isFeatureEnabled", () => {
  it("reads the enabled bit", () => {
    let s = defaultTwoTierState();
    expect(isFeatureEnabled(s, "MARKETPLACE")).toBe(false);
    s = setFeature(s, "MARKETPLACE", true, 1);
    expect(isFeatureEnabled(s, "MARKETPLACE")).toBe(true);
  });
});

describe("normaliseTwoTierState", () => {
  it("returns the default for null / non-object", () => {
    expect(normaliseTwoTierState(null)).toEqual(defaultTwoTierState());
    expect(normaliseTwoTierState(undefined)).toEqual(defaultTwoTierState());
    expect(normaliseTwoTierState("garbage")).toEqual(defaultTwoTierState());
    expect(normaliseTwoTierState(42)).toEqual(defaultTwoTierState());
  });

  it("round-trips a fully populated state", () => {
    let s = defaultTwoTierState();
    s = setFeature(s, "TRADING_INTERFACE", true, 100);
    s = setFeature(s, "MARKETPLACE", true, 200);
    expect(normaliseTwoTierState(s)).toEqual(s);
  });

  it("drops unknown keys without exploding", () => {
    const raw = {
      TRADING_INTERFACE: { enabled: true, firstSeenAt: 100 },
      UNKNOWN_FLAG: { enabled: true, firstSeenAt: 50 },
    };
    const out = normaliseTwoTierState(raw);
    expect(out.TRADING_INTERFACE).toEqual({ enabled: true, firstSeenAt: 100 });
    expect("UNKNOWN_FLAG" in out).toBe(false);
  });

  it("ignores per-feature entries with wrong types", () => {
    const raw = {
      TRADING_INTERFACE: { enabled: "yes", firstSeenAt: "now" },
    };
    const out = normaliseTwoTierState(raw);
    expect(out.TRADING_INTERFACE).toEqual({ enabled: false, firstSeenAt: null });
  });

  it("fills missing flags with defaults", () => {
    const raw = { MARKETPLACE: { enabled: true, firstSeenAt: 1 } };
    const out = normaliseTwoTierState(raw);
    expect(out.MARKETPLACE).toEqual({ enabled: true, firstSeenAt: 1 });
    expect(out.TRADING_INTERFACE).toEqual({ enabled: false, firstSeenAt: null });
  });

  it("tolerates NaN/Infinity in firstSeenAt", () => {
    const raw = {
      AI_FEATURES: { enabled: true, firstSeenAt: NaN },
      REGISTRY: { enabled: true, firstSeenAt: Infinity },
    };
    const out = normaliseTwoTierState(raw);
    // NaN / Infinity fail `Number.isFinite` — falls back to null
    expect(out.AI_FEATURES.firstSeenAt).toBeNull();
    expect(out.REGISTRY.firstSeenAt).toBeNull();
    // but `enabled: true` survives
    expect(out.AI_FEATURES.enabled).toBe(true);
    expect(out.REGISTRY.enabled).toBe(true);
  });
});
