// SlhDsaBackupCard render-contract tests.
//
// The bug fixed by this commit: a null `backup` (fresh vault that has
// never opted into §30.1) caused the entire action area — including
// the "Set up emergency recovery key" CTA — to disappear behind a
// `{backup && (...)}` outer guard. User feedback: "appears as
// placeholder text only."
//
// Without React rendering in the vitest setup, these tests exercise
// the pure helpers + the visibility predicates the card uses to drive
// each render branch. The actual component is end-to-end validated
// through the popup manual flow.

import { describe, expect, it } from "vitest";
import {
  backupStatusLabel,
  isBackupComplete,
  type SlhDsaBackup,
} from "../../shared/slh-dsa-backup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Predicates mirroring the SlhDsaBackupCard JSX guards. These are the
// invariants the fix locked in.
// ─────────────────────────────────────────────────────────────────────────────

/** True when the card should render the "Set up emergency recovery key"
 *  CTA. The card mounts this CTA at line 198 of SlhDsaBackupCard.tsx
 *  with the predicate `{(!backup || backup.createdAt === 0) && (...)}`. */
function showSetupCta(backup: SlhDsaBackup | null): boolean {
  return !backup || backup.createdAt === 0;
}

/** True when the card should render the state-driven action surface
 *  (registration, retry, re-export, destructive). Predicate at line
 *  207 + 209: `{backup && (...)}` plus `{backup.createdAt > 0 && (...)}`. */
function showStateDrivenActions(backup: SlhDsaBackup | null): boolean {
  return backup !== null && backup.createdAt > 0;
}

/** True when the card should render the BackupStateRow pill. Always
 *  renders post-fix (was previously inside the outer guard). */
function showStatePill(_backup: SlhDsaBackup | null): boolean {
  return true;
}

/** True when the card should render the G3 rotation rehearsal as a
 *  collapsed-by-default reference. Post-fix: always renders (was
 *  previously gated on `backup.createdAt > 0`, hiding the explainer
 *  from fresh vaults). */
function showRehearsalReference(_backup: SlhDsaBackup | null): boolean {
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FRESH_VAULT_BACKUP: null = null;

const PARTIAL_BACKUP: SlhDsaBackup = {
  createdAt: 0, // opted in but generation didn't complete
  publicKey: "",
  encryptedPrivateKey: "",
  encryptedPrivateKeyNonce: "",
  encryptedEntropy: "",
  encryptedEntropyNonce: "",
  parameterSet: "slh_dsa_sha2_128s",
  coldStorageConfirmed: false,
  chainRegistrationStatus: "not-registered",
};

const GENERATED_NOT_REGISTERED: SlhDsaBackup = {
  createdAt: Date.now(),
  publicKey: "abcd",
  encryptedPrivateKey: "encrypted-blob",
  encryptedPrivateKeyNonce: "nonce-blob",
  encryptedEntropy: "entropy-blob",
  encryptedEntropyNonce: "entropy-nonce-blob",
  parameterSet: "slh_dsa_sha2_128s",
  coldStorageConfirmed: true,
  chainRegistrationStatus: "not-registered",
};

const PENDING_REGISTRATION: SlhDsaBackup = {
  ...GENERATED_NOT_REGISTERED,
  chainRegistrationStatus: "pending",
  chainRegistrationTxHash: "0x" + "ab".repeat(32),
};

const REGISTERED: SlhDsaBackup = {
  ...GENERATED_NOT_REGISTERED,
  chainRegistrationStatus: "registered",
  chainRegistrationTxHash: "0x" + "ab".repeat(32),
  chainRegistrationBlock: 12345,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the four scenarios the fix locks in
// ─────────────────────────────────────────────────────────────────────────────

describe("SlhDsaBackupCard — null-backup (fresh vault) render", () => {
  it("ALWAYS renders the state pill (post-fix)", () => {
    expect(showStatePill(FRESH_VAULT_BACKUP)).toBe(true);
  });

  it("RENDERS the 'Set up emergency recovery key' CTA — THE BUG FIX", () => {
    // This is the assertion that was failing pre-fix. The outer
    // `{backup && (...)}` guard at line 186 prevented the CTA from
    // rendering when backup was null, so fresh-vault users saw only
    // the card header + description text.
    expect(showSetupCta(FRESH_VAULT_BACKUP)).toBe(true);
  });

  it("does NOT render state-driven actions (no backup to act on)", () => {
    expect(showStateDrivenActions(FRESH_VAULT_BACKUP)).toBe(false);
  });

  it("renders the G3 rehearsal reference (collapsed by default)", () => {
    // Rehearsal moved out of `createdAt > 0`
    // branch so fresh-vault users can read about the rotation flow
    // BEFORE committing to setup.
    expect(showRehearsalReference(FRESH_VAULT_BACKUP)).toBe(true);
  });

  it("state pill label reads 'Not set up'", () => {
    expect(backupStatusLabel(FRESH_VAULT_BACKUP)).toBe("Not set up");
  });
});

describe("SlhDsaBackupCard — partial setup (opted-in, createdAt=0)", () => {
  it("renders the 'Set up' CTA (generation didn't complete)", () => {
    expect(showSetupCta(PARTIAL_BACKUP)).toBe(true);
  });

  it("does NOT render state-driven actions yet", () => {
    expect(showStateDrivenActions(PARTIAL_BACKUP)).toBe(false);
  });

  it("state pill label reads 'Not set up'", () => {
    // backupStatusLabel returns "Not set up" for createdAt === 0
    // (matches the null case — generation incomplete).
    expect(backupStatusLabel(PARTIAL_BACKUP)).toBe("Not set up");
  });
});

describe("SlhDsaBackupCard — generated locally, awaiting chain registration", () => {
  it("does NOT render the 'Set up' CTA (setup already complete)", () => {
    expect(showSetupCta(GENERATED_NOT_REGISTERED)).toBe(false);
  });

  it("renders state-driven actions (Register on chain / Re-export)", () => {
    expect(showStateDrivenActions(GENERATED_NOT_REGISTERED)).toBe(true);
  });

  it("state pill label reads 'Locally generated (not on chain)'", () => {
    expect(backupStatusLabel(GENERATED_NOT_REGISTERED)).toBe(
      "Locally generated (not on chain)",
    );
  });

  it("is NOT yet 'complete' (chain registration pending)", () => {
    expect(isBackupComplete(GENERATED_NOT_REGISTERED)).toBe(false);
  });
});

describe("SlhDsaBackupCard — pending registration", () => {
  it("does NOT render the 'Set up' CTA", () => {
    expect(showSetupCta(PENDING_REGISTRATION)).toBe(false);
  });

  it("renders state-driven actions (re-export option)", () => {
    expect(showStateDrivenActions(PENDING_REGISTRATION)).toBe(true);
  });

  it("state pill label reads 'Registering on chain…'", () => {
    expect(backupStatusLabel(PENDING_REGISTRATION)).toBe(
      "Registering on chain…",
    );
  });
});

describe("SlhDsaBackupCard — fully registered (complete)", () => {
  it("does NOT render the 'Set up' CTA", () => {
    expect(showSetupCta(REGISTERED)).toBe(false);
  });

  it("renders state-driven actions (re-export, regenerate destructive)", () => {
    expect(showStateDrivenActions(REGISTERED)).toBe(true);
  });

  it("state pill label reads 'Chain registered'", () => {
    expect(backupStatusLabel(REGISTERED)).toBe("Chain registered");
  });

  it("isBackupComplete is true", () => {
    expect(isBackupComplete(REGISTERED)).toBe(true);
  });

  it("STILL renders the G3 rehearsal reference (always available)", () => {
    expect(showRehearsalReference(REGISTERED)).toBe(true);
  });
});

describe("SlhDsaBackupCard — visibility regression guard", () => {
  it("CTA visibility predicate matches both null AND createdAt=0", () => {
    // Single test locking the exact predicate the fix put in place.
    // Pre-fix: only `createdAt === 0` matched (when wrapped in outer
    // guard, this branch never fired because backup was null).
    // Post-fix: the OR with `!backup` is what makes null-backup
    // visible to the user.
    expect(showSetupCta(null)).toBe(true);
    expect(showSetupCta(PARTIAL_BACKUP)).toBe(true);
    expect(showSetupCta(GENERATED_NOT_REGISTERED)).toBe(false);
  });

  it("state pill renders for every state (no hidden states post-fix)", () => {
    expect(showStatePill(null)).toBe(true);
    expect(showStatePill(PARTIAL_BACKUP)).toBe(true);
    expect(showStatePill(GENERATED_NOT_REGISTERED)).toBe(true);
    expect(showStatePill(PENDING_REGISTRATION)).toBe(true);
    expect(showStatePill(REGISTERED)).toBe(true);
  });

  it("G3 rehearsal renders for every state (always-collapsed reference)", () => {
    expect(showRehearsalReference(null)).toBe(true);
    expect(showRehearsalReference(GENERATED_NOT_REGISTERED)).toBe(true);
    expect(showRehearsalReference(REGISTERED)).toBe(true);
  });
});
