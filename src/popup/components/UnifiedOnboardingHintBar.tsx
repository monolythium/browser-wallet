// Phase 11 Commit 8 — UnifiedOnboardingHintBar.
//
// Replaces the two-stack of OnboardingHintBar + SlhDsaBackupHintBar on
// Home with a single coordinator-driven wrapper. The coordinator
// (shared/onboarding-coordinator) decides which of the three hints to
// show given the user's current setup state + dismissal flags. Only
// one bar surfaces at a time.
//
// Precedence (most → least important):
//   1. SLH-DSA backup    (recovery-critical, §30.1)
//   2. Passkey policy    (UX convenience, §28.5 Q30/Q31)
//   3. Feature toggles   (discoverability, §28.5 Q29)
//
// The existing OnboardingHintBar (passkey/features) and
// SlhDsaBackupHintBar are still used as the inner rendering — this
// wrapper just gates which one is mounted. Backward-compatible if
// either inner bar's dismissal storage is already populated.

import { useEffect, useState } from "react";

import { OnboardingHintBar } from "./OnboardingHintBar.js";
import { SlhDsaBackupHintBar } from "./SlhDsaBackupHintBar.js";
import {
  bgPasskeyGetState,
  bgSlhDsaBackupGet,
  bgTwoTierGetState,
  bgVaultsList,
} from "../bg.js";
import {
  FEATURE_FLAGS,
} from "../../shared/two-tier-features.js";
import {
  HINT_BAR_RESURFACE_MS,
  isBackupComplete,
} from "../../shared/slh-dsa-backup.js";
import {
  pickHint,
  type OnboardingStep,
} from "../../shared/onboarding-coordinator.js";

const SLH_DSA_HINT_STATE_KEY = "mono.slh-dsa-backup.hint-state";
const PASSKEY_DISMISSED_KEY = "mono.passkey-hint.dismissed";

interface SlhDsaHintState {
  dismissedAt: number;
  neverShowAgain: boolean;
}

interface PasskeyDismissedRecord {
  [vaultId: string]: "passkey" | "features" | "all";
}

async function readSlhDsaDismissal(
  vaultId: string,
): Promise<{ permanent: boolean; recent: boolean }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SLH_DSA_HINT_STATE_KEY, (got) => {
      const raw = got?.[SLH_DSA_HINT_STATE_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({ permanent: false, recent: false });
        return;
      }
      const entry = (raw as Record<string, unknown>)[vaultId];
      if (!entry || typeof entry !== "object") {
        resolve({ permanent: false, recent: false });
        return;
      }
      const e = entry as Partial<SlhDsaHintState>;
      const permanent = e.neverShowAgain === true;
      const dismissedAt =
        typeof e.dismissedAt === "number" ? e.dismissedAt : 0;
      const recent =
        !permanent && Date.now() - dismissedAt < HINT_BAR_RESURFACE_MS;
      resolve({ permanent, recent });
    });
  });
}

async function readPasskeyDismissal(
  vaultId: string,
): Promise<{ passkey: boolean; features: boolean }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(PASSKEY_DISMISSED_KEY, (got) => {
      const raw = got?.[PASSKEY_DISMISSED_KEY];
      if (!raw || typeof raw !== "object") {
        resolve({ passkey: false, features: false });
        return;
      }
      const level = (raw as PasskeyDismissedRecord)[vaultId];
      // OnboardingHintBar stores values: "passkey" | "features" | "all".
      // "passkey"  = passkey-hint dismissed, features may still show.
      // "features" = both dismissed.
      // "all"      = both dismissed.
      const passkey = level === "passkey" || level === "features" || level === "all";
      const features = level === "features" || level === "all";
      resolve({ passkey, features });
    });
  });
}

export interface UnifiedOnboardingHintBarProps {
  vaultId: string;
  onOpenSecurity: () => void;
  onOpenFeatures: () => void;
}

export function UnifiedOnboardingHintBar({
  vaultId,
  onOpenSecurity,
  onOpenFeatures,
}: UnifiedOnboardingHintBarProps) {
  const [chosen, setChosen] = useState<OnboardingStep | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Collect every input the coordinator needs in parallel.
      const [backupR, passkeyR, featuresR, vaultsR, slhDis, pkDis] =
        await Promise.all([
          bgSlhDsaBackupGet(vaultId),
          bgPasskeyGetState(vaultId),
          bgTwoTierGetState(),
          bgVaultsList(),
          readSlhDsaDismissal(vaultId),
          readPasskeyDismissal(vaultId),
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
      const step = pickHint({
        hasSlhDsaBackup,
        hasPasskey,
        hasAnyFeatureEnabled,
        isMultisigVault,
        dismissed: {
          slhDsaBackupPermanently: slhDis.permanent,
          slhDsaBackupRecently: slhDis.recent,
          passkeyPermanently: pkDis.passkey,
          featuresPermanently: pkDis.features,
        },
      });
      setChosen(step);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  if (loading) return null;
  if (chosen === null) return null;

  if (chosen === "slh-dsa-backup") {
    return (
      <SlhDsaBackupHintBar vaultId={vaultId} onOpenSecurity={onOpenSecurity} />
    );
  }

  // "passkey" or "features" — both rendered by the existing
  // OnboardingHintBar, which has its own internal precedence (passkey
  // first, then features). The wrapper relies on the inner bar's
  // logic to pick which of the two to show. This is intentional: the
  // inner bar already handles the "did the user dismiss only passkey"
  // case correctly.
  return (
    <OnboardingHintBar
      vaultId={vaultId}
      onOpenSecurity={onOpenSecurity}
      onOpenFeatures={onOpenFeatures}
    />
  );
}
