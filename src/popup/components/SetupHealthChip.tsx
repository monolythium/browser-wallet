// SetupHealthChip.
//
// Compact chip rendered on Home (above the hint bar) that shows the
// user's overall wallet-setup progress: "3 of 4 wallet features
// configured" with a click-through to Settings → Security. Hides
// itself at 100% so a fully-configured user doesn't see a perpetual
// chrome chip.
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

export interface SetupHealthChipProps {
  vaultId: string;
  onOpenSecurity: () => void;
}

export function SetupHealthChip({
  vaultId,
  onOpenSecurity,
}: SetupHealthChipProps) {
  const [health, setHealth] = useState<SetupHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [backupR, passkeyR, featuresR, vaultsR] = await Promise.all([
        bgSlhDsaBackupGet(vaultId),
        bgPasskeyGetState(vaultId),
        bgTwoTierGetState(),
        bgVaultsList(),
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
  if (health.percent === 100) return null;
  const total = health.completed.length + health.remaining.length;
  const tooltip =
    "Remaining: " + health.remaining.map((s) => STEP_LABEL[s]).join(", ");
  return (
    <button
      type="button"
      onClick={onOpenSecurity}
      style={chipStyle}
      title={tooltip}
      aria-label={`Wallet setup ${health.percent}% complete. ${tooltip}`}
    >
      <span style={dotStyle(health.percent)} aria-hidden="true" />
      <span>
        {health.completed.length} of {total} wallet features configured
      </span>
      <span style={arrowStyle}>→</span>
    </button>
  );
}

const chipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  marginBottom: 8,
  width: "100%",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.03)",
  color: "var(--fg-300)",
  cursor: "pointer",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  textAlign: "left",
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
