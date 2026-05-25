// Phase 8 Commit 2 — MultisigCreateModal pure-helper tests.
//
// These exercise the conversion + validation seam between the
// modal's in-flight DraftSigner shape and the canonical MultisigSigner
// shape the IPC contract expects. The modal's React state machine is
// not snapshot-tested (the codebase doesn't ship a React testing
// surface yet); the rendering is verified manually via the dev popup.

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@monolythium/core-sdk/crypto";
import {
  draftsToSigners,
  pubkeyToAddress,
  type DraftSigner,
} from "./MultisigCreateModal.js";
import { validateSignerInput, validateThreshold } from "../../shared/multisig.js";

function fakePubkey(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(1952);
}

function fakeAddress(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(20);
}

describe("pubkeyToAddress", () => {
  it("returns a 0x + 40-hex-char address for a well-formed 1952-byte pubkey", () => {
    const addr = pubkeyToAddress(fakePubkey(0xab));
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("is deterministic for the same input", () => {
    const a1 = pubkeyToAddress(fakePubkey(0x11));
    const a2 = pubkeyToAddress(fakePubkey(0x11));
    expect(a1).toBe(a2);
  });

  it("differs for different pubkeys", () => {
    const a1 = pubkeyToAddress(fakePubkey(0x11));
    const a2 = pubkeyToAddress(fakePubkey(0x22));
    expect(a1).not.toBe(a2);
  });

  it("returns empty string for malformed input", () => {
    expect(pubkeyToAddress("")).toBe("");
    expect(pubkeyToAddress("0xabcd")).toBe("");
    expect(pubkeyToAddress("not-hex")).toBe("");
    expect(pubkeyToAddress(fakePubkey(0xab).slice(0, -2))).toBe("");
  });

  it("derives an address shorter than the pubkey with ADR-0038", () => {
    const pk = fakePubkey(0xab);
    const addr = pubkeyToAddress(pk);
    // Sanity — the address is hashed-derived, not a literal prefix.
    expect(addr.length).toBe(42);
    expect(addr).not.toBe(pk.slice(0, 42));
    expect(addr).not.toBe(bytesToHex(keccak_256(hexToBytes(pk)).slice(12)));
  });
});

describe("draftsToSigners", () => {
  it("preserves self-signer fields verbatim and assigns a fresh id", () => {
    const drafts: DraftSigner[] = [
      {
        draftId: "d-1",
        label: "Alice",
        source: "self",
        vaultId: "v-1",
        selfPubkey: fakePubkey(0xab),
        selfAddress: fakeAddress(0x01),
        externalPubkey: "",
      },
    ];
    const out = draftsToSigners(drafts);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("Alice");
    expect(out[0]!.address).toBe(fakeAddress(0x01));
    expect(out[0]!.pubkey).toBe(fakePubkey(0xab));
    expect(out[0]!.role).toBe("self");
    expect(out[0]!.vaultId).toBe("v-1");
    expect(out[0]!.id).toMatch(/[0-9a-f]/);
  });

  it("derives external-signer address from the pasted pubkey", () => {
    const drafts: DraftSigner[] = [
      {
        draftId: "d-1",
        label: "Bob",
        source: "external",
        externalPubkey: fakePubkey(0xcd),
      },
    ];
    const out = draftsToSigners(drafts);
    expect(out).toHaveLength(1);
    expect(out[0]!.pubkey).toBe(fakePubkey(0xcd));
    expect(out[0]!.address).toBe(pubkeyToAddress(fakePubkey(0xcd)));
    expect(out[0]!.role).toBe("external");
    expect(out[0]!.vaultId).toBeUndefined();
  });

  it("trims labels + lowercases pasted pubkey", () => {
    const drafts: DraftSigner[] = [
      {
        draftId: "d-1",
        label: "  Mixed  ",
        source: "external",
        externalPubkey: "0x" + "AB".repeat(1952),
      },
    ];
    const out = draftsToSigners(drafts);
    expect(out[0]!.label).toBe("Mixed");
    expect(out[0]!.pubkey).toBe("0x" + "ab".repeat(1952));
  });

  it("throws when a self-signer is missing local vault details", () => {
    const drafts: DraftSigner[] = [
      {
        draftId: "d-1",
        label: "Bad",
        source: "self",
        // vaultId/selfPubkey/selfAddress all missing — the UI's
        // SelfSignerPicker is supposed to fill them before commit.
        externalPubkey: "",
      },
    ];
    expect(() => draftsToSigners(drafts)).toThrow(/local vault details/);
  });

  it("output passes validateSignerInput for both roles", () => {
    const drafts: DraftSigner[] = [
      {
        draftId: "d-1",
        label: "Alice",
        source: "self",
        vaultId: "v-1",
        selfPubkey: fakePubkey(0xab),
        selfAddress: fakeAddress(0x01),
        externalPubkey: "",
      },
      {
        draftId: "d-2",
        label: "Bob",
        source: "external",
        externalPubkey: fakePubkey(0xcd),
      },
    ];
    const out = draftsToSigners(drafts);
    for (const s of out) {
      expect(() => validateSignerInput(s)).not.toThrow();
    }
    expect(() => validateThreshold(2, out.length)).not.toThrow();
  });
});
