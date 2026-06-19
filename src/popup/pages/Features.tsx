// Features page.
//
// Surfaces the §28.5 Q29 two-tier UX toggles:
//   TRADING_INTERFACE — advanced staking analytics + spot CLOB surfaces
//   MARKETPLACE       — rich NFT detail + filters + agent-commerce listings
//   AI_FEATURES       — MCP Copilot (placeholder until that phase ships)
//   REGISTRY          — name registration UI (resolution stays available
//                       always; registration CTA is gated)
//
// Default state is everything OFF. Each toggle reports whether the
// feature has ever been enabled before (`firstSeenAt` ≠ null) so a
// future "new since you turned this on" affordance can hook in cleanly.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { bgTwoTierGetState, bgTwoTierSetFeature } from "../bg";
import {
  FEATURE_FLAGS,
  FEATURE_META,
  type FeatureFlag,
  type TwoTierState,
} from "../../shared/two-tier-features";

export interface FeaturesProps {
  onBack: () => void;
}

export function Features({ onBack }: FeaturesProps) {
  const [state, setState] = useState<TwoTierState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<FeatureFlag | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgTwoTierGetState();
      if (cancelled) return;
      if (r.ok) setState(r.state);
      else setLoadErr(r.reason);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (flag: FeatureFlag, next: boolean) => {
    if (saving) return;
    setSaving(flag);
    const r = await bgTwoTierSetFeature(flag, next);
    if (r.ok) setState(r.state);
    setSaving(null);
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 16, fontWeight: 600, textAlign: "center" }}
        >
          Features
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Advanced surfaces</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 10,
            }}
          >
            The wallet ships with a minimal send / receive / stake experience.
            Flip on the surfaces you want. Each setting is persisted
            per-browser-profile.
          </div>

          {loadErr && (
            <div style={errBox}>Couldn&apos;t load features.</div>
          )}

          {state && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* DEVELOPER_MODE is excluded here — it is enabled only via the
                  popup-guarded DeveloperModeToggle, never as a bare grid toggle. */}
              {FEATURE_FLAGS.filter((flag) => flag !== "DEVELOPER_MODE").map((flag) => {
                const meta = FEATURE_META[flag];
                const s = state[flag];
                const isSaving = saving === flag;
                return (
                  <div
                    key={flag}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--fg-700)",
                      background: "rgba(255,255,255,0.04)",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {meta.label}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "var(--fg-400)",
                          marginTop: 3,
                          lineHeight: 1.4,
                        }}
                      >
                        {meta.tagline}
                      </div>
                    </div>
                    <button
                      onClick={() => void handleToggle(flag, !s.enabled)}
                      disabled={isSaving}
                      aria-label={`Toggle ${meta.label}`}
                      style={{
                        ...toggleBtn,
                        background: s.enabled
                          ? "var(--gold-bg)"
                          : "rgba(255,255,255,0.04)",
                        borderColor: s.enabled ? "var(--gold)" : "var(--fg-700)",
                        color: s.enabled ? "var(--gold)" : "var(--fg-100)",
                        opacity: isSaving ? 0.5 : 1,
                      }}
                    >
                      {s.enabled ? "On" : "Off"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Why progressive disclosure?</h3>
          </div>
          <div
            style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.5 }}
          >
            The wallet ships as a single binary with optional advanced
            surfaces — not a separate "AI-enhanced wallet" SKU. The
            default surface stays minimal so non-technical users aren't
            overwhelmed; power users opt in to what they want. New
            features in future phases land here as additional toggles,
            not as separate wallet builds.
          </div>
        </div>
      </div>
    </>
  );
}

const toggleBtn: CSSProperties = {
  padding: "6px 16px",
  borderRadius: 8,
  border: "1px solid",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 150ms var(--e-out)",
  minWidth: 50,
};

const errBox: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  padding: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  marginBottom: 10,
};
