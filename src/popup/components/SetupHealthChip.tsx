// SetupHealthChip.
//
// Compact chip rendered on Home (above the hint bar) that shows the
// user's overall wallet-setup progress: "3 of 4 wallet features
// configured" with a click-through to Settings → Security. Hides
// itself at 100% so a fully-configured user doesn't see a perpetual
// chrome chip.
//
// Snooze/dismiss: it also honours a per-vault nag state (mirroring the
// sibling SlhDsaBackupHintBar) so it isn't a perpetual nag while < 100%.
// "Later" snoozes 30 days (repeatable); "Don't ask again" suppresses it
// permanently for the vault. See shared/setup-health-nag.
//
// Pairs with `UnifiedOnboardingHintBar` (the action surface) — health
// chip shows the *summary*, hint bar shows the *next concrete step*.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import {
  bgPasskeyGetState,
  bgSlhDsaBackupGet,
  bgTwoTierGetState,
  bgVaultsList,
} from "../bg.js";
import { FEATURE_FLAGS } from "../../shared/two-tier-features.js";
import { isBackupComplete } from "../../shared/slh-dsa-backup.js";
import {
  STEP_LABEL,
  computeSetupHealth,
  type SetupHealth,
} from "../../shared/onboarding-coordinator.js";
import {
  applyDismissForever,
  applyLater,
  normaliseRecoveryNagMap,
  shouldShowRecoveryNag,
  type RecoveryNagState,
} from "../../shared/setup-health-nag.js";

const NAG_STATE_KEY = "mono.setup-health.nag-state";

/** Tolerant read of the per-vault nag map (mirrors SlhDsaBackupHintBar). */
async function loadRecoveryNagMap(): Promise<Record<string, RecoveryNagState>> {
  return new Promise((resolve) => {
    chrome.storage.local.get([NAG_STATE_KEY], (got) => {
      resolve(normaliseRecoveryNagMap(got?.[NAG_STATE_KEY]));
    });
  });
}

async function saveRecoveryNagEntry(
  vaultId: string,
  entry: RecoveryNagState,
): Promise<void> {
  const current = await loadRecoveryNagMap();
  current[vaultId] = entry;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [NAG_STATE_KEY]: current }, () => resolve());
  });
}

export interface SetupHealthChipProps {
  vaultId: string;
  onOpenSecurity: () => void;
}

export function SetupHealthChip({
  vaultId,
  onOpenSecurity,
}: SetupHealthChipProps) {
  const [health, setHealth] = useState<SetupHealth | null>(null);
  const [nagEntry, setNagEntry] = useState<RecoveryNagState | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [backupR, passkeyR, featuresR, vaultsR, nagMap] = await Promise.all([
        bgSlhDsaBackupGet(vaultId),
        bgPasskeyGetState(vaultId),
        bgTwoTierGetState(),
        bgVaultsList(),
        loadRecoveryNagMap(),
      ]);
      if (cancelled) return;
      const hasSlhDsaBackup =
        backupR.ok && backupR.backup !== null && isBackupComplete(backupR.backup);
      const hasPasskey = passkeyR.ok && passkeyR.state.credentials.length > 0;
      const hasAnyFeatureEnabled =
        featuresR.ok && FEATURE_FLAGS.some((f) => featuresR.state[f].enabled);
      const isMultisigVault =
        vaultsR.ok &&
        vaultsR.vaults !== null &&
        vaultsR.vaults.some(
          (v) => v.id === vaultId && v.kind === "multisig",
        );
      setNagEntry(nagMap[vaultId]);
      setHealth(
        computeSetupHealth({
          hasSlhDsaBackup,
          hasPasskey,
          hasAnyFeatureEnabled,
          isMultisigVault,
          // Dismissal flags don't affect health — pass anything.
          dismissed: {
            slhDsaBackupPermanently: false,
            slhDsaBackupRecently: false,
            passkeyPermanently: false,
            featuresPermanently: false,
          },
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  if (health === null) return null;
  // All-3 configured wins regardless; else honour the per-vault snooze/dismiss.
  if (!shouldShowRecoveryNag(nagEntry, health.percent === 100, Date.now())) {
    return null;
  }
  const total = health.completed.length + health.remaining.length;
  const tooltip =
    "Remaining: " + health.remaining.map((s) => STEP_LABEL[s]).join(", ");

  // Optimistic: setting the new entry re-renders, and shouldShowRecoveryNag then
  // returns false → the chip unmounts (no separate `hidden` flag needed).
  const later = async () => {
    const entry = applyLater(Date.now());
    await saveRecoveryNagEntry(vaultId, entry);
    setNagEntry(entry);
  };
  const never = async () => {
    const entry = applyDismissForever();
    await saveRecoveryNagEntry(vaultId, entry);
    setNagEntry(entry);
  };

  return (
    <div style={cardStyle}>
      <button
        type="button"
        onClick={onOpenSecurity}
        style={mainBtnStyle}
        title={tooltip}
        aria-label={`Wallet setup ${health.percent}% complete. ${tooltip}`}
      >
        <span style={dotStyle(health.percent)} aria-hidden="true" />
        <span>
          {health.completed.length} of {total} wallet features configured
        </span>
        <span style={arrowStyle}>→</span>
      </button>
      <div style={actionsRow}>
        <button type="button" onClick={() => void later()} style={btnGhost}>
          Later
        </button>
        <button type="button" onClick={() => void never()} style={btnGhostSubtle}>
          Don&apos;t ask again
        </button>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "6px 10px",
  marginBottom: 8,
  width: "100%",
  borderRadius: 8,
  border: "1px solid rgba(var(--gold-glow), 0.15)",
  background: "rgba(var(--gold-glow), 0.035)",
};

const mainBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 0,
  width: "100%",
  border: 0,
  background: "transparent",
  color: "var(--fg-300)",
  cursor: "pointer",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  textAlign: "left",
};

const actionsRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginLeft: 14, // align past the status dot
};

function dotStyle(percent: number): CSSProperties {
  const colour =
    percent >= 67
      ? "var(--ok)"
      : percent >= 33
        ? "var(--warn)"
        : "var(--err)";
  return {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: colour,
    flexShrink: 0,
  };
}

const arrowStyle: CSSProperties = {
  marginLeft: "auto",
  color: "var(--fg-500)",
  fontSize: 10,
};

const btnGhost: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-300)",
  fontFamily: "var(--f-sans)",
  fontSize: 9.5,
  cursor: "pointer",
};

const btnGhostSubtle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--fg-500)",
  fontFamily: "var(--f-sans)",
  fontSize: 9.5,
  cursor: "pointer",
};
