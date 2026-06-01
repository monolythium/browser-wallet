// Pure-helper tests for MultisigGovernance.tsx.

import { describe, expect, it } from "vitest";
import {
  describeAction,
  pubkeyToAddress,
} from "./MultisigGovernance.js";
import type {
  GovernanceAction,
  MultisigSigner,
} from "../../shared/multisig.js";

function fakeAddress(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(20);
}

function fakePubkey(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(1952);
}

const ROSTER: MultisigSigner[] = [
  {
    id: "s-alice",
    label: "Alice",
    address: fakeAddress(0x01),
    pubkey: fakePubkey(0xab),
    role: "self",
    vaultId: "v-1",
  },
  {
    id: "s-bob",
    label: "Bob",
    address: fakeAddress(0x02),
    pubkey: fakePubkey(0xcd),
    role: "external",
  },
];

describe("describeAction", () => {
  it("formats add-signer with the new label", () => {
    const a: GovernanceAction = {
      kind: "add-signer",
      signer: {
        label: "Carol",
        address: fakeAddress(0x03),
        pubkey: fakePubkey(0xef),
        role: "external",
      },
    };
    expect(describeAction(a, ROSTER)).toBe("Add signer · Carol");
  });

  it("formats remove-signer with the target's existing label", () => {
    const a: GovernanceAction = { kind: "remove-signer", signerId: "s-alice" };
    expect(describeAction(a, ROSTER)).toBe("Remove signer · Alice");
  });

  it("formats remove-signer with 'unknown' for unmatched id", () => {
    const a: GovernanceAction = { kind: "remove-signer", signerId: "missing" };
    expect(describeAction(a, ROSTER)).toBe("Remove signer · unknown");
  });

  it("formats replace-signer with both labels", () => {
    const a: GovernanceAction = {
      kind: "replace-signer",
      signerId: "s-bob",
      replacement: {
        label: "Bob-v2",
        address: fakeAddress(0x22),
        pubkey: fakePubkey(0x22),
        role: "external",
      },
    };
    expect(describeAction(a, ROSTER)).toBe("Replace · Bob → Bob-v2");
  });

  it("formats change-threshold with the new value", () => {
    const a: GovernanceAction = { kind: "change-threshold", threshold: 3 };
    expect(describeAction(a, ROSTER)).toBe("Change threshold → 3");
  });
});

describe("MultisigGovernance.pubkeyToAddress", () => {
  it("returns a 0x + 40 hex chars address for a well-formed pubkey", () => {
    expect(pubkeyToAddress(fakePubkey(0xab))).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("matches the MultisigCreateModal helper output (same derivation)", async () => {
    const create = await import("./MultisigCreateModal.js");
    expect(pubkeyToAddress(fakePubkey(0x12))).toBe(
      create.pubkeyToAddress(fakePubkey(0x12)),
    );
  });

  it("returns empty string for malformed input", () => {
    expect(pubkeyToAddress("")).toBe("");
    expect(pubkeyToAddress("0xabcd")).toBe("");
    expect(pubkeyToAddress("not-hex")).toBe("");
  });
});
