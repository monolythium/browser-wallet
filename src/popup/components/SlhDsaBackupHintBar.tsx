// Phase 10 Commit 5 — SlhDsaBackupHintBar.
//
// Periodic, non-blocking hint surfaced on Home when:
//   - The active vault has no completed §30.1 backup (per
//     `isBackupComplete` — needs both cold-storage attestation +
//     chain registration), AND
//   - The user has not dismissed permanently ("never show again"),
//     AND
//   - At least `HINT_BAR_RESURFACE_MS` (30 days) has passed since
//     the last "dismiss for now" tap (or this is the first show).
//
// Design notes — mirrors Phase 9 OnboardingHintBar pattern:
//  - Non-modal. Forced modals for genuinely-optional features are
//    pushy UX; an accent bar at the top of Home preserves the
//    user's normal flow.
//  - Per-vault state. Adding a fresh vault re-shows the hint for
//    that new vault.
//  - Two dismiss levels: "Dismiss for now" (re-surface in 30 days)
//    and "Never show again" (suppress permanently for this vault).
//  - Auto-suppress on action. Once the user has a complete backup
//    (cold-storage confirmed + chain registered) the hint stops
//    showing without any explicit dismissal — `isBackupComplete`
//    in the shared module is the single source of truth.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { bgSlhDsaBackupGet } from "../bg";
import {
  HINT_BAR_RESURFACE_MS,
  isBackupComplete,
} from "../../shared/slh-dsa-backup.js";

const HINT_STATE_KEY = "mono.slh-dsa-backup.hint-state";

interface HintStateRecord {
  /** `Date.now()` of the most recent dismissal. 0 if never
   *  dismissed (the hint will still surface). */
  dismissedAt: number;
  /** Permanent suppression — user explicitly chose
   *  "Never show again". Re-creating the backup record (e.g.
   *  via `bgSlhDsaBackupClear` then a fresh generation) does
   *  NOT reset this — it's per-vault-permanent.
   *
   *  Re-enabling would require a future "Reset backup prompts"
   *  setting; not in Phase 10 scope. */
  neverShowAgain: boolean;
}

type HintMap = Record<string, HintStateRecord>;

/** Tolerant read — normalises an arbitrary storage blob into a
 *  well-formed `HintMap`, drops malformed entries silently. */
function normaliseMap(raw: unknown): HintMap {
  if (!raw || typeof raw !== "object") return {};
  const out: HintMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.dismissedAt !== "number") continue;
    if (typeof r.neverShowAgain !== "boolean") continue;
    out[k] = {
      dismissedAt: r.dismissedAt,
      neverShowAgain: r.neverShowAgain,
    };
  }
  return out;
}

async function loadHintMap(): Promise<HintMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get([HINT_STATE_KEY], (got) => {
      resolve(normaliseMap(got?.[HINT_STATE_KEY]));
    });
  });
}

async function saveHintEntry(
  vaultId: string,
  entry: HintStateRecord,
): Promise<void> {
  const current = await loadHintMap();
  current[vaultId] = entry;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [HINT_STATE_KEY]: current }, () => resolve());
  });
}

/** Pure decision helper — exported for the test seam.
 *
 *  Returns `true` iff the hint bar should render right now for the
 *  given (backup-state, hint-state, current-time) triple. */
export function shouldShowHint(args: {
  backupIsComplete: boolean;
  hintEntry: HintStateRecord | undefined;
  now: number;
}): boolean {
  if (args.backupIsComplete) return false;
  const entry = args.hintEntry;
  if (!entry) return true; // never dismissed → show
  if (entry.neverShowAgain) return false;
  return args.now - entry.dismissedAt >= HINT_BAR_RESURFACE_MS;
}

export interface SlhDsaBackupHintBarProps {
  vaultId: string;
  onOpenSecurity: () => void;
}

export function SlhDsaBackupHintBar({
  vaultId,
  onOpenSecurity,
}: SlhDsaBackupHintBarProps) {
  const [show, setShow] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [hintMap, backupRes] = await Promise.all([
        loadHintMap(),
        bgSlhDsaBackupGet(vaultId),
      ]);
      if (cancelled) return;
      const backup = backupRes.ok ? backupRes.backup : null;
      const visible = shouldShowHint({
        backupIsComplete: isBackupComplete(backup),
        hintEntry: hintMap[vaultId],
        now: Date.now(),
      });
      setShow(visible);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  if (!show) return null;

  const dismissForNow = async () => {
    await saveHintEntry(vaultId, {
      dismissedAt: Date.now(),
      neverShowAgain: false,
    });
    setShow(false);
  };

  const neverShowAgain = async () => {
    await saveHintEntry(vaultId, {
      dismissedAt: Date.now(),
      neverShowAgain: true,
    });
    setShow(false);
  };

  return (
    <div style={hintCard}>
      <Icon name="shield" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          Set up emergency recovery
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-300)",
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          A post-quantum backup key (§30.1) protects your account if
          quantum computing ever breaks current crypto. One-time setup,
          one-time on-chain registration.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <button onClick={onOpenSecurity} style={btnPrimary}>
          Set up
        </button>
        <button onClick={() => void dismissForNow()} style={btnGhost}>
          Later
        </button>
        <button onClick={() => void neverShowAgain()} style={btnGhostSubtle}>
          Don't ask again
        </button>
      </div>
    </div>
  );
}

const hintCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 12px",
  marginBottom: 8,
  borderRadius: 10,
  // Distinct accent colour from the Phase 9 passkey hint bar (which
  // uses the gold palette) so a user with both hints in their
  // history can visually distinguish them.
  border: "1px solid rgba(124,127,255,0.4)",
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-100)",
};

const btnPrimary: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  fontWeight: 600,
  cursor: "pointer",
};

const btnGhost: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-300)",
  fontFamily: "var(--f-sans)",
  fontSize: 10.5,
  cursor: "pointer",
};

const btnGhostSubtle: CSSProperties = {
  padding: "3px 10px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--fg-500)",
  fontFamily: "var(--f-sans)",
  fontSize: 9.5,
  cursor: "pointer",
};
