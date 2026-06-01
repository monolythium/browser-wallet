// OnboardingHintBar.
//
// One-time post-onboarding hint card shown on Home when:
//   1. The active vault has no registered passkey, AND
//   2. The user has not dismissed the hint for this vault.
//
// Dismissal is persisted under
// `chrome.storage.local["mono.passkey-hint.dismissed"] = { [vaultId]: true }`
// so showing it once and clicking "Maybe later" suppresses it
// permanently for that vault. The same record gates the "Discover
// features" hint, which steps in once the passkey hint is dismissed.
//
// Design notes:
//  - Non-blocking — surfaces as a small accent bar, never as a modal.
//    Forced modals are pushy UX for a feature that is genuinely
//    optional (the wallet works without passkeys + without enabling
//    feature toggles).
//  - One hint at a time. Once passkey is dismissed, the next visit
//    shows the features hint. Once that's dismissed too, the bar
//    is gone for that vault forever.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { bgPasskeyGetState, bgTwoTierGetState } from "../bg";
import { FEATURE_FLAGS } from "../../shared/two-tier-features";

const DISMISSED_KEY = "mono.passkey-hint.dismissed";

type DismissedRecord = Record<string, "passkey" | "features" | "all">;

async function loadDismissed(): Promise<DismissedRecord> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DISMISSED_KEY, (got) => {
      const raw = got?.[DISMISSED_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({});
        return;
      }
      const out: DismissedRecord = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === "passkey" || v === "features" || v === "all") {
          out[k] = v;
        }
      }
      resolve(out);
    });
  });
}

async function saveDismissed(vaultId: string, level: "passkey" | "features" | "all") {
  const current = await loadDismissed();
  current[vaultId] = level;
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ [DISMISSED_KEY]: current }, () => resolve());
  });
}

type HintKind = "passkey" | "features" | null;

export interface OnboardingHintBarProps {
  vaultId: string;
  onOpenSecurity: () => void;
  onOpenFeatures: () => void;
}

export function OnboardingHintBar({
  vaultId,
  onOpenSecurity,
  onOpenFeatures,
}: OnboardingHintBarProps) {
  const [hint, setHint] = useState<HintKind>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dismissed = await loadDismissed();
      const level = dismissed[vaultId];
      if (level === "all") {
        if (!cancelled) setHint(null);
        return;
      }

      // Passkey hint: surface unless the user already has a credential
      // registered OR they dismissed this hint specifically.
      if (level !== "passkey" && level !== "features") {
        const r = await bgPasskeyGetState(vaultId);
        if (cancelled) return;
        if (r.ok && r.state.credentials.length === 0) {
          setHint("passkey");
          return;
        }
      }

      // Features hint: surface unless the user has enabled any flag
      // OR has dismissed both hints.
      if (level !== "features") {
        const r = await bgTwoTierGetState();
        if (cancelled) return;
        if (r.ok) {
          const anyOn = FEATURE_FLAGS.some((f) => r.state[f].enabled);
          if (!anyOn) {
            setHint("features");
            return;
          }
        }
      }

      if (!cancelled) setHint(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  if (hint === null) return null;

  const dismiss = async (level: "passkey" | "features" | "all") => {
    await saveDismissed(vaultId, level);
    setHint(null);
  };

  if (hint === "passkey") {
    return (
      <div style={hintCard}>
        <Icon name="passkey" size={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            Register a passkey?
          </div>
          <div style={{ fontSize: 10.5, color: "var(--fg-300)", marginTop: 2, lineHeight: 1.4 }}>
            Use Touch ID, Windows Hello, or a security key for fast
            unlock on small-value transfers.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => void dismiss("passkey")} style={btnGhost}>
            Later
          </button>
          <button onClick={onOpenSecurity} style={btnPrimary}>
            Setup
          </button>
        </div>
      </div>
    );
  }

  // features hint
  return (
    <div style={hintCard}>
      <Icon name="shield" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          Discover more features
        </div>
        <div style={{ fontSize: 10.5, color: "var(--fg-300)", marginTop: 2, lineHeight: 1.4 }}>
          Trading analytics, NFT marketplace, name registry — opt in
          to the surfaces you want.
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => void dismiss("all")} style={btnGhost}>
          Dismiss
        </button>
        <button onClick={onOpenFeatures} style={btnPrimary}>
          Open
        </button>
      </div>
    </div>
  );
}

const hintCard: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  marginBottom: 8,
  borderRadius: 10,
  border: "1px solid rgba(244,201,122,0.4)",
  background: "rgba(244,201,122,0.06)",
  color: "var(--fg-100)",
};

const btnGhost: CSSProperties = {
  padding: "5px 9px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-300)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  cursor: "pointer",
};

const btnPrimary: CSSProperties = {
  padding: "5px 9px",
  borderRadius: 6,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  fontWeight: 600,
  cursor: "pointer",
};
