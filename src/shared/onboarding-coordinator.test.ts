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
    expect(h.notApplicable).toEqual([]);
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
    // 2 of 2 applicable steps complete; passkey is N/A.
    expect(h.percent).toBe(100);
    expect(h.completed).toEqual(["slh-dsa-backup", "features"]);
    expect(h.notApplicable).toEqual(["passkey"]);
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

describe("STEP_LABEL", () => {
  it("has a label for every onboarding step", () => {
    expect(STEP_LABEL["slh-dsa-backup"]).toBeTruthy();
    expect(STEP_LABEL.passkey).toBeTruthy();
    expect(STEP_LABEL.features).toBeTruthy();
  });
});
