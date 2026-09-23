// ConfirmWordDialog — the match rule and the warning copy.
//
// The dialog is portal-based (Modal -> createPortal into document.body) and so
// is NOT statically rendered under the Node test env — same posture as the
// auto-compound / passkey / SLH-DSA modals, which document the same limit.
// There is no jsdom in this suite, so typing, the Enter-key route, the submit
// guard, and the clear-on-close effect are NOT covered here and are not
// claimed to be.
//
// What IS covered is what carries the weight: the match rule that decides
// whether an irreversible action fires, and the warning copy that is the only
// place the user is told the action is unrecoverable.

import { describe, expect, it } from "vitest";

import { LOOPBACK_CONFIRM_WORD, WIPE_CONFIRM_WORD } from "../../shared/constants";
import {
  RECOVERY_PHRASE_WARNING,
  confirmWordMatches,
} from "./ConfirmWordDialog";

describe("confirmWordMatches — the rule the three existing surfaces use", () => {
  it("accepts the exact word", () => {
    expect(confirmWordMatches("DELETE")).toBe(true);
  });

  it("is case-insensitive, matching .trim().toUpperCase()", () => {
    expect(confirmWordMatches("delete")).toBe(true);
    expect(confirmWordMatches("Delete")).toBe(true);
    expect(confirmWordMatches("dElEtE")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(confirmWordMatches("  DELETE  ")).toBe(true);
    expect(confirmWordMatches("\tdelete\n")).toBe(true);
  });

  it("rejects a near miss", () => {
    expect(confirmWordMatches("DELET")).toBe(false);
    expect(confirmWordMatches("DELETES")).toBe(false);
    expect(confirmWordMatches("DEL ETE")).toBe(false);
  });

  it("rejects an empty or blank field — a bare Enter can never confirm", () => {
    expect(confirmWordMatches("")).toBe(false);
    expect(confirmWordMatches("   ")).toBe(false);
    expect(confirmWordMatches("\n\t")).toBe(false);
  });

  it("rejects the word the requirements originally proposed", () => {
    // trace-agent's Decision 1 settled on the wallet's existing DELETE rather
    // than introducing a second word; this pins that "confirm" is not live.
    expect(confirmWordMatches("confirm")).toBe(false);
  });

  it("is bound to the shared constant, not a local literal", () => {
    // The service worker's keystore-wipe-unauth check compares against this
    // same constant, so the popup and the SW cannot drift apart.
    expect(confirmWordMatches(WIPE_CONFIRM_WORD)).toBe(true);
    expect(WIPE_CONFIRM_WORD).toBe("DELETE");
  });
});

// The loopback opt-in needs a typed confirmation too, but DELETE would be the
// wrong word: nothing is being destroyed, and reusing it erodes the word on the
// three paths where it does signal destruction. So the comparator takes the
// expected word, defaulting to the wipe word so no existing caller moves.
describe("confirmWordMatches — a second word, without moving the first", () => {
  it("defaults to the wipe word when no expectation is given", () => {
    expect(confirmWordMatches("DELETE")).toBe(true);
    expect(confirmWordMatches("CONNECT")).toBe(false);
  });

  it("matches an explicit word with the same trim + case rule", () => {
    expect(confirmWordMatches("CONNECT", LOOPBACK_CONFIRM_WORD)).toBe(true);
    expect(confirmWordMatches("connect", LOOPBACK_CONFIRM_WORD)).toBe(true);
    expect(confirmWordMatches("  Connect  ", LOOPBACK_CONFIRM_WORD)).toBe(true);
  });

  it("does not accept the wipe word where CONNECT is expected", () => {
    expect(confirmWordMatches("DELETE", LOOPBACK_CONFIRM_WORD)).toBe(false);
  });

  it("rejects partials and empties against the explicit word", () => {
    expect(confirmWordMatches("CONNEC", LOOPBACK_CONFIRM_WORD)).toBe(false);
    expect(confirmWordMatches("CONNECTS", LOOPBACK_CONFIRM_WORD)).toBe(false);
    expect(confirmWordMatches("", LOOPBACK_CONFIRM_WORD)).toBe(false);
    expect(confirmWordMatches("   ", LOOPBACK_CONFIRM_WORD)).toBe(false);
  });

  it("the loopback word is not a destructive one", () => {
    expect(LOOPBACK_CONFIRM_WORD).toBe("CONNECT");
    expect(LOOPBACK_CONFIRM_WORD).not.toBe(WIPE_CONFIRM_WORD);
  });
});

describe("RECOVERY_PHRASE_WARNING — the unrecoverability disclosure", () => {
  it("reads exactly as ResetWallet's confirm step does", () => {
    const full =
      RECOVERY_PHRASE_WARNING.lead +
      RECOVERY_PHRASE_WARNING.emphasis +
      RECOVERY_PHRASE_WARNING.tail;
    expect(full).toBe(
      "Your funds are safe only if you have your 24-word recovery phrase. This action cannot be undone.",
    );
  });

  it("still states that the action cannot be undone", () => {
    // The load-bearing half. Removal destroys the only local copy of the seed;
    // if this sentence is ever softened the user is under-warned about an
    // irreversible act.
    expect(RECOVERY_PHRASE_WARNING.tail).toContain("cannot be undone");
  });

  it("still names the recovery phrase as the one thing that saves the funds", () => {
    expect(RECOVERY_PHRASE_WARNING.emphasis).toContain("24-word recovery phrase");
    expect(RECOVERY_PHRASE_WARNING.emphasis).toContain("only if");
  });
});
