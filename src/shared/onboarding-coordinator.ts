// Onboarding hint coordinator + setup health.
//
// The passkey hint bar and the SLH-DSA backup hint bar each render
// hint bar. Both render independently — without coordination they stack
// (Home shows two yellow bars + steals two rows of vertical space).
// This module is the single source of truth for which hint surfaces +
// computes the "setup health" indicator.
//
// Precedence (most → least important):
//   1. SLH-DSA backup (recovery-critical — without it, a future G3
//      cryptographic emergency strands the vault)
//   2. Passkey (small-value-tx convenience tier; user-experience
//      improvement, not safety-critical)
//   3. Feature flags (discoverability — purely additive UX)
//
// Setup health is the inverse view: "you have N of M wallet features
// configured" surfaces as a small chip on Home, drilling into the
// remaining gaps when tapped.
//
// Whitepaper alignment:
//   §28.5  — multisig built-in (counts as a "configured" feature when
//            active vault is multisig)
//   §28.5  — passkey policy (Q30+Q31)
//   §29    — feature toggles (§28.5 Q29 two-tier UX)
//   §30.1  — SLH-DSA backup (post-quantum social recovery)

/** Identifier for each onboarding step. */
export type OnboardingStep = "slh-dsa-backup" | "passkey" | "features";

/** Input state the coordinator needs. The wallet collects these in
 *  parallel from existing storage / IPC reads. */
export interface OnboardingInputs {
  /** True when the active vault has a completed SLH-DSA backup
   *  (cold-storage attestation + chain registration). */
  hasSlhDsaBackup: boolean;
  /** True when the active vault has at least one passkey credential. */
  hasPasskey: boolean;
  /** True when at least one two-tier feature flag is enabled. */
  hasAnyFeatureEnabled: boolean;
  /** True when the active vault is multisig. Multisig vaults count as
   *  "passkey not required" (governance + escrow already exist) so the
   *  passkey hint is suppressed for them. */
  isMultisigVault: boolean;
  /** Per-vault dismissal map. The coordinator suppresses a hint that
   *  the user has dismissed (either permanently or within a re-surface
   *  window). The caller passes a snapshot of the relevant flags. */
  dismissed: {
    slhDsaBackupPermanently: boolean;
    slhDsaBackupRecently: boolean;
    passkeyPermanently: boolean;
    featuresPermanently: boolean;
  };
}

/** The hint coordinator decides which (if any) hint to render. Returns
 *  `null` when nothing should surface. */
export function pickHint(inputs: OnboardingInputs): OnboardingStep | null {
  // 1. SLH-DSA backup — recovery-critical. Surface unless complete OR
  //    permanently dismissed OR recently dismissed (within the re-surface
  //    window).
  if (
    !inputs.hasSlhDsaBackup &&
    !inputs.dismissed.slhDsaBackupPermanently &&
    !inputs.dismissed.slhDsaBackupRecently
  ) {
    return "slh-dsa-backup";
  }
  // 2. Passkey — UX convenience. Skipped for multisig vaults (the
  //    multisig flow already covers the small-value-tx convenience tier
  //    with its propose / co-sign primitives).
  if (
    !inputs.hasPasskey &&
    !inputs.isMultisigVault &&
    !inputs.dismissed.passkeyPermanently
  ) {
    return "passkey";
  }
  // 3. Features — discoverability. Only after the user dealt with the
  //    earlier two; otherwise we'd be marketing during the security
  //    setup flow.
  if (
    !inputs.hasAnyFeatureEnabled &&
    !inputs.dismissed.featuresPermanently
  ) {
    return "features";
  }
  return null;
}

/** Setup health view. Counts configured / total. Used to render the
 *  "N of M configured" chip on Home. */
export interface SetupHealth {
  /** Steps the user has completed. */
  completed: ReadonlyArray<OnboardingStep>;
  /** Steps still incomplete. */
  remaining: ReadonlyArray<OnboardingStep>;
  /** Steps that don't apply to this vault (multisig hides passkey,
   *  for example). */
  notApplicable: ReadonlyArray<OnboardingStep>;
  /** Convenience: `completed.length / (completed + remaining).length`,
   *  rounded to integer percent. */
  percent: number;
}

const ALL_STEPS: ReadonlyArray<OnboardingStep> = [
  "slh-dsa-backup",
  "passkey",
  "features",
];

/** Compute setup health from the same inputs the coordinator reads.
 *  Dismissal flags are NOT respected — a dismissed-but-not-completed
 *  step still counts as incomplete in the health view (the user can
 *  always re-engage from Settings; the health view tracks reality, not
 *  the user's prompt-dismissal preferences). */
export function computeSetupHealth(inputs: OnboardingInputs): SetupHealth {
  const completed: OnboardingStep[] = [];
  const remaining: OnboardingStep[] = [];
  const notApplicable: OnboardingStep[] = [];
  for (const step of ALL_STEPS) {
    if (step === "passkey" && inputs.isMultisigVault) {
      notApplicable.push(step);
      continue;
    }
    const done = isStepComplete(step, inputs);
    if (done) completed.push(step);
    else remaining.push(step);
  }
  const denominator = completed.length + remaining.length;
  const percent =
    denominator === 0 ? 100 : Math.round((completed.length / denominator) * 100);
  return { completed, remaining, notApplicable, percent };
}

function isStepComplete(
  step: OnboardingStep,
  inputs: OnboardingInputs,
): boolean {
  switch (step) {
    case "slh-dsa-backup":
      return inputs.hasSlhDsaBackup;
    case "passkey":
      return inputs.hasPasskey;
    case "features":
      return inputs.hasAnyFeatureEnabled;
  }
}

/** Human-readable label per step — used by the setup-health chip
 *  tooltip + the drill-in CTAs. */
export const STEP_LABEL: Readonly<Record<OnboardingStep, string>> = {
  "slh-dsa-backup": "Post-quantum backup",
  passkey: "Passkey unlock",
  features: "Feature toggles",
};
