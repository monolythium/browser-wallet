// The confirm modal is portal-based (Modal -> createPortal into document.body),
// so it isn't statically rendered under the Node test env — same posture as the
// passkey / SLH-DSA modals. The load-bearing logic (the fund-relevant
// enable-claims disclosure — the safety anchor) lives in exported pure helpers,
// pinned here.

import { describe, expect, it } from "vitest";
import {
  AutoCompoundConfirmModal,
  autoCompoundClaimDisclosure,
  autoCompoundFeeLine,
} from "./AutoCompoundConfirmModal.js";

const FIVE_LYTH = 5n * 10n ** 18n;

describe("autoCompoundClaimDisclosure — the safety anchor", () => {
  it("discloses the immediate claim when ENABLING with a pending reward", () => {
    const note = autoCompoundClaimDisclosure(true, FIVE_LYTH);
    expect(note).not.toBeNull();
    expect(note).toContain("This also claims your pending");
    expect(note).toContain("5 LYTH");
  });

  it("returns null when DISABLING (no claim side effect), even with a pending reward", () => {
    expect(autoCompoundClaimDisclosure(false, FIVE_LYTH)).toBeNull();
  });

  it("returns null when enabling with ZERO pending (nothing to claim)", () => {
    expect(autoCompoundClaimDisclosure(true, 0n)).toBeNull();
  });

  it("formats a fractional pending amount", () => {
    // 1.5 LYTH pending
    const note = autoCompoundClaimDisclosure(true, 15n * 10n ** 17n);
    expect(note).toContain("1.5 LYTH");
  });
});

describe("autoCompoundFeeLine — honest fee copy (no fabricated number)", () => {
  it("shows the quoted fee when available", () => {
    expect(autoCompoundFeeLine("0.0002")).toBe("0.0002 LYTH");
  });
  it("shows a generic note when the fee couldn't be quoted (never 'null')", () => {
    expect(autoCompoundFeeLine(null)).toBe("applies (paid in LYTH)");
  });
});

describe("AutoCompoundConfirmModal", () => {
  it("is exported as a component", () => {
    expect(typeof AutoCompoundConfirmModal).toBe("function");
  });
});
