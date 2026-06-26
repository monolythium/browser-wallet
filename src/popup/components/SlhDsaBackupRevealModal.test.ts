// Regression guard for P2-003/P6-006: the SLH-DSA emergency-recovery reveal
// modal must NOT offer an unencrypted .txt file export of the 24-word recovery
// phrase. The on-screen hold-to-reveal stays (the user reads + handwrites the
// phrase); only the file download was removed.
//
// The modal is portal-based (Modal -> createPortal into document.body) and is
// not snapshot-rendered under the Node test env — same posture as
// PasskeyRegisterModal / PasskeySignModal. The file export lived entirely in a
// single exported pure helper, `buildDownloadText`, that built the plaintext
// `.txt` body. Pinning that the helper is GONE is the durable guard that the
// unencrypted-mnemonic file export can't be silently reintroduced.

import { describe, expect, it } from "vitest";
import * as modal from "./SlhDsaBackupRevealModal.js";
import { isBackupAlreadyExistsError } from "./SlhDsaBackupRevealModal.js";

describe("SLH-DSA backup reveal — no unencrypted file export (P2-003/P6-006)", () => {
  it("no longer exports the .txt download body builder", () => {
    expect((modal as Record<string, unknown>).buildDownloadText).toBeUndefined();
  });

  it("still exports the reveal modal component (on-screen reveal intact)", () => {
    expect(typeof modal.SlhDsaBackupRevealModal).toBe("function");
  });
});

// The modal is portal-based (Modal -> createPortal into document.body), so its
// error screen is not statically renderable in the Node test env. The error
// screen branches on this exported predicate to swap the bare "Try again" for
// the Re-export (preferred) + clear-from-the-card affordances, so pinning the
// predicate pins which errors get the affordances (P2-003/P6-006).
describe("already-exists error → re-export / clear affordances", () => {
  it("detects the generate guard's 'already exists' error", () => {
    expect(
      isBackupAlreadyExistsError(
        "backup already exists — clear it first or use the re-export flow",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBackupAlreadyExistsError("Backup ALREADY EXISTS")).toBe(true);
  });

  it("does NOT trigger for other errors (those keep the plain Try again)", () => {
    expect(isBackupAlreadyExistsError("keystore locked")).toBe(false);
    expect(
      isBackupAlreadyExistsError("no backup configured for this vault"),
    ).toBe(false);
    expect(
      isBackupAlreadyExistsError("Chain reverted the registration tx"),
    ).toBe(false);
  });
});
