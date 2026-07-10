// onboarding coordinator + setup-health tests.

import { describe, expect, it } from "vitest";
import {
  STEP_LABEL,
  computeSetupHealth,
  pickHint,
  type OnboardingInputs,
} from "./onboarding-coordinator.js";

const BLANK_INPUTS: OnboardingInputs = {
  hasSlhDsaBackup: false,
  hasPasskey: false,
  hasAnyFeatureEnabled: false,
  isMultisigVault: false,
  dismissed: {
    slhDsaBackupPermanently: false,
    slhDsaBackupRecently: false,
    passkeyPermanently: false,
    featuresPermanently: false,
  },
};

describe("pickHint — precedence", () => {
  it("prefers SLH-DSA backup over passkey when both are missing", () => {
    expect(pickHint(BLANK_INPUTS)).toBe("slh-dsa-backup");
  });

  it("falls through to passkey when SLH-DSA backup is complete", () => {
    expect(
      pickHint({ ...BLANK_INPUTS, hasSlhDsaBackup: true }),
    ).toBe("passkey");
  });

  it("falls through to features when passkey is also complete", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        hasSlhDsaBackup: true,
        hasPasskey: true,
      }),
    ).toBe("features");
  });

  it("returns null when everything is complete", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        hasSlhDsaBackup: true,
        hasPasskey: true,
        hasAnyFeatureEnabled: true,
      }),
    ).toBeNull();
  });
});

describe("pickHint — dismissal honoured", () => {
  it("skips SLH-DSA backup when permanently dismissed", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        dismissed: {
          ...BLANK_INPUTS.dismissed,
          slhDsaBackupPermanently: true,
        },
      }),
    ).toBe("passkey");
  });

  it("skips SLH-DSA backup when recently dismissed (re-surface window)", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        dismissed: {
          ...BLANK_INPUTS.dismissed,
          slhDsaBackupRecently: true,
        },
      }),
    ).toBe("passkey");
  });

  it("skips passkey when permanently dismissed", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        hasSlhDsaBackup: true,
        dismissed: {
          ...BLANK_INPUTS.dismissed,
          passkeyPermanently: true,
        },
      }),
    ).toBe("features");
  });

  it("skips features when permanently dismissed → returns null", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        hasSlhDsaBackup: true,
        hasPasskey: true,
        dismissed: {
          ...BLANK_INPUTS.dismissed,
          featuresPermanently: true,
        },
      }),
    ).toBeNull();
  });
});

describe("pickHint — multisig special case", () => {
  it("suppresses passkey hint for multisig vaults", () => {
    expect(
      pickHint({
        ...BLANK_INPUTS,
        hasSlhDsaBackup: true,
        isMultisigVault: true,
      }),
    ).toBe("features");
  });
});

describe("computeSetupHealth", () => {
  it("0/3 = 0% when nothing is configured", () => {
    const h = computeSetupHealth(BLANK_INPUTS);
    expect(h.percent).toBe(0);
    expect(h.completed).toEqual([]);
    expect(h.remaining).toEqual(["slh-dsa-backup", "passkey", "features"]);
    // `.mono` name is not-applicable until REGISTRY is enabled.
    expect(h.notApplicable).toEqual(["name"]);
  });

  it("3/3 = 100% when everything is configured", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
      hasAnyFeatureEnabled: true,
    });
    expect(h.percent).toBe(100);
    expect(h.completed.length).toBe(3);
    expect(h.remaining).toEqual([]);
  });

  it("2/3 = 67% on partial setup", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
    });
    expect(h.percent).toBe(67);
    expect(h.completed).toEqual(["slh-dsa-backup", "passkey"]);
    expect(h.remaining).toEqual(["features"]);
  });

  it("excludes passkey from denominator for multisig vaults", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasAnyFeatureEnabled: true,
      isMultisigVault: true,
    });
    // 2 of 2 applicable steps complete; passkey + name are N/A.
    expect(h.percent).toBe(100);
    expect(h.completed).toEqual(["slh-dsa-backup", "features"]);
    expect(h.notApplicable).toEqual(["passkey", "name"]);
  });

  it("ignores dismissal — health tracks reality not preferences", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      dismissed: {
        slhDsaBackupPermanently: true,
        slhDsaBackupRecently: false,
        passkeyPermanently: true,
        featuresPermanently: true,
      },
    });
    expect(h.percent).toBe(0);
    expect(h.completed).toEqual([]);
  });
});

describe("computeSetupHealth — `.mono` name step (REGISTRY-gated)", () => {
  it("is not-applicable (not counted) when REGISTRY is off", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
      hasAnyFeatureEnabled: true,
      // nameApplicable omitted → not-applicable
    });
    expect(h.percent).toBe(100);
    expect(h.notApplicable).toContain("name");
    expect(h.remaining).not.toContain("name");
  });

  it("counts as remaining when REGISTRY is on and the user has no name", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
      hasAnyFeatureEnabled: true,
      nameApplicable: true,
      hasMonoName: false,
    });
    // 3 of 4 applicable (name outstanding).
    expect(h.remaining).toEqual(["name"]);
    expect(h.percent).toBe(75);
  });

  it("counts as complete when the user has a name", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
      hasAnyFeatureEnabled: true,
      nameApplicable: true,
      hasMonoName: true,
    });
    expect(h.completed).toContain("name");
    expect(h.percent).toBe(100);
  });

  it("does NOT nag (treats as complete) when the has-name signal is uncertain", () => {
    const h = computeSetupHealth({
      ...BLANK_INPUTS,
      hasSlhDsaBackup: true,
      hasPasskey: true,
      hasAnyFeatureEnabled: true,
      nameApplicable: true,
      // hasMonoName omitted (undefined) → biased to complete
    });
    expect(h.remaining).not.toContain("name");
    expect(h.completed).toContain("name");
  });
});

describe("STEP_LABEL", () => {
  it("has a label for every onboarding step", () => {
    expect(STEP_LABEL["slh-dsa-backup"]).toBeTruthy();
    expect(STEP_LABEL.passkey).toBeTruthy();
    expect(STEP_LABEL.features).toBeTruthy();
    expect(STEP_LABEL.name).toBeTruthy();
  });
});
