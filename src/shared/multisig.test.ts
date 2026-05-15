// Phase 8 Commit 1 — pure-helper tests for shared/multisig.ts.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TX_PROPOSAL_TTL_MS,
  GovernanceAction,
  GovernanceProposal,
  MAX_SIGNERS,
  MultisigSigner,
  PendingProposal,
  applyGovernance,
  assertSignerSetUnique,
  defaultThreshold,
  hashGovernanceProposal,
  hashTxProposal,
  isExecutable,
  isGovernanceExecutable,
  pickFirstSelfSigner,
  pickNextLocalVoter,
  reconcileGovernanceStatus,
  reconcileProposalStatus,
  validateSignerInput,
  validateThreshold,
  __testing,
} from "./multisig.js";

// Helper — synthesize a 1952-byte pubkey (3904 hex chars) deterministically.
function fakePubkey(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(1952);
}

function fakeAddress(byte: number): string {
  return "0x" + byte.toString(16).padStart(2, "0").repeat(20);
}

function makeSigner(
  partial: Partial<MultisigSigner> & { id: string; address: string },
): MultisigSigner {
  return {
    label: "Signer",
    pubkey: fakePubkey(0xab),
    role: "external",
    ...partial,
  };
}

function makeProposal(
  partial: Partial<PendingProposal> & Pick<PendingProposal, "id">,
): PendingProposal {
  const now = 1_700_000_000_000;
  return {
    proposedBy: "signer-a",
    createdAt: now,
    expiresAt: now + DEFAULT_TX_PROPOSAL_TTL_MS,
    vaultAddress: fakeAddress(0xcd),
    action: {
      kind: "send",
      to: fakeAddress(0xef),
      valueWeiHex: "0x1",
      chainIdHex: "0x10F2C",
    },
    approvals: [],
    rejections: [],
    status: "pending",
    txHash: null,
    ...partial,
  };
}

function makeGovProposal(
  partial: Partial<GovernanceProposal> & Pick<GovernanceProposal, "id" | "action">,
): GovernanceProposal {
  const now = 1_700_000_000_000;
  return {
    proposedBy: "signer-a",
    createdAt: now,
    expiresAt: now + DEFAULT_TX_PROPOSAL_TTL_MS,
    vaultAddress: fakeAddress(0xcd),
    approvals: [],
    rejections: [],
    status: "pending",
    ...partial,
  };
}

describe("defaultThreshold", () => {
  it("returns simple-majority N for small rosters", () => {
    expect(defaultThreshold(1)).toBe(1);
    expect(defaultThreshold(2)).toBe(2);
    expect(defaultThreshold(3)).toBe(2);
    expect(defaultThreshold(4)).toBe(3);
    expect(defaultThreshold(5)).toBe(3);
    expect(defaultThreshold(6)).toBe(4);
    expect(defaultThreshold(7)).toBe(4);
    expect(defaultThreshold(MAX_SIGNERS)).toBe(MAX_SIGNERS / 2 + 1);
  });

  it("rejects zero/negative signerCount", () => {
    expect(() => defaultThreshold(0)).toThrow();
    expect(() => defaultThreshold(-1)).toThrow();
  });
});

describe("validateThreshold", () => {
  it("accepts (1,1) through (M,N) within bounds", () => {
    expect(() => validateThreshold(1, 1)).not.toThrow();
    expect(() => validateThreshold(3, 5)).not.toThrow();
    expect(() => validateThreshold(MAX_SIGNERS, MAX_SIGNERS)).not.toThrow();
  });

  it("rejects threshold > signerCount", () => {
    expect(() => validateThreshold(3, 2)).toThrow(/exceed/i);
  });

  it("rejects threshold < 1", () => {
    expect(() => validateThreshold(0, 3)).toThrow(/>= 1/);
  });

  it("rejects signerCount > MAX_SIGNERS", () => {
    expect(() => validateThreshold(1, MAX_SIGNERS + 1)).toThrow(/at most/);
  });

  it("rejects non-integers", () => {
    expect(() => validateThreshold(1.5, 3)).toThrow(/integer/);
    expect(() => validateThreshold(2, 3.5)).toThrow(/integer/);
  });
});

describe("validateSignerInput", () => {
  const base = {
    label: "Alice",
    address: fakeAddress(0x12),
    pubkey: fakePubkey(0x34),
    role: "external" as const,
  };

  it("accepts a well-formed external signer", () => {
    expect(() => validateSignerInput(base)).not.toThrow();
  });

  it("accepts a self signer with vaultId", () => {
    expect(() =>
      validateSignerInput({ ...base, role: "self", vaultId: "v-1" }),
    ).not.toThrow();
  });

  it("rejects empty or oversized label", () => {
    expect(() => validateSignerInput({ ...base, label: "" })).toThrow(
      /non-empty/,
    );
    expect(() =>
      validateSignerInput({ ...base, label: "a".repeat(33) }),
    ).toThrow(/1-32/);
  });

  it("rejects bad address format", () => {
    expect(() =>
      validateSignerInput({ ...base, address: "0x1234" }),
    ).toThrow(/40 hex/);
  });

  it("rejects pubkey of wrong length", () => {
    expect(() =>
      validateSignerInput({ ...base, pubkey: "0xabcd" }),
    ).toThrow(/1952 bytes/);
  });

  it("rejects self without vaultId", () => {
    expect(() => validateSignerInput({ ...base, role: "self" })).toThrow(
      /local vault id/,
    );
  });

  it("rejects external with vaultId", () => {
    expect(() =>
      validateSignerInput({ ...base, role: "external", vaultId: "v-1" }),
    ).toThrow(/must not carry/);
  });
});

describe("assertSignerSetUnique", () => {
  it("accepts a set with distinct addresses + vaultIds", () => {
    const signers = [
      makeSigner({ id: "a", address: fakeAddress(0x01), role: "self", vaultId: "v-1" }),
      makeSigner({ id: "b", address: fakeAddress(0x02) }),
    ];
    expect(() => assertSignerSetUnique(signers)).not.toThrow();
  });

  it("rejects duplicate addresses (case-insensitive)", () => {
    const signers = [
      makeSigner({ id: "a", address: "0x" + "ab".repeat(20) }),
      makeSigner({ id: "b", address: "0x" + "AB".repeat(20) }),
    ];
    expect(() => assertSignerSetUnique(signers)).toThrow(/duplicate signer address/);
  });

  it("rejects duplicate vaultIds", () => {
    const signers = [
      makeSigner({ id: "a", address: fakeAddress(0x01), role: "self", vaultId: "v-1" }),
      makeSigner({ id: "b", address: fakeAddress(0x02), role: "self", vaultId: "v-1" }),
    ];
    expect(() => assertSignerSetUnique(signers)).toThrow(/duplicate signer vaultId/);
  });
});

describe("hashTxProposal", () => {
  it("is deterministic for the same payload", () => {
    const p = makeProposal({ id: "p-1" });
    const h1 = hashTxProposal(p);
    const h2 = hashTxProposal(p);
    expect(h1).toEqual(h2);
    expect(h1.length).toBe(32);
  });

  it("differs when the action value changes", () => {
    const p1 = makeProposal({ id: "p-1" });
    const p2 = makeProposal({
      id: "p-1",
      action: { ...p1.action, valueWeiHex: "0x2" } as PendingProposal["action"],
    });
    expect(hashTxProposal(p1)).not.toEqual(hashTxProposal(p2));
  });

  it("differs when the proposalId changes (replay defense)", () => {
    const p1 = makeProposal({ id: "p-1" });
    const p2 = makeProposal({ id: "p-2" });
    expect(hashTxProposal(p1)).not.toEqual(hashTxProposal(p2));
  });

  it("is case-insensitive for hex fields (addresses, values, calldata)", () => {
    const p1 = makeProposal({
      id: "p-1",
      vaultAddress: "0x" + "ab".repeat(20),
      action: {
        kind: "send",
        to: "0x" + "cd".repeat(20),
        valueWeiHex: "0xABCD",
        chainIdHex: "0x10f2c",
      },
    });
    const p2 = makeProposal({
      id: "p-1",
      vaultAddress: "0x" + "AB".repeat(20),
      action: {
        kind: "send",
        to: "0x" + "CD".repeat(20),
        valueWeiHex: "0xabcd",
        chainIdHex: "0x10F2C",
      },
    });
    expect(hashTxProposal(p1)).toEqual(hashTxProposal(p2));
  });

  it("ignores fields outside the canonical body (signatures, timestamps)", () => {
    const p1 = makeProposal({ id: "p-1" });
    const p2 = makeProposal({
      id: "p-1",
      approvals: [
        { signerId: "s-1", signature: "0xab", signedAt: 1 },
      ],
      createdAt: 999,
    });
    expect(hashTxProposal(p1)).toEqual(hashTxProposal(p2));
  });
});

describe("hashGovernanceProposal", () => {
  it("uses a different domain than tx proposals", () => {
    // Build a tx and a gov proposal that happen to share the same id +
    // vaultAddress + similar shape; the hashes must still differ.
    const id = "shared-id";
    const tx = makeProposal({ id });
    const gov = makeGovProposal({
      id,
      action: { kind: "change-threshold", threshold: 2 },
    });
    expect(hashTxProposal(tx)).not.toEqual(hashGovernanceProposal(gov));
  });

  it("is deterministic + content-bound", () => {
    const g1 = makeGovProposal({
      id: "g-1",
      action: { kind: "change-threshold", threshold: 2 },
    });
    const g2 = makeGovProposal({
      id: "g-1",
      action: { kind: "change-threshold", threshold: 3 },
    });
    expect(hashGovernanceProposal(g1)).toEqual(hashGovernanceProposal(g1));
    expect(hashGovernanceProposal(g1)).not.toEqual(hashGovernanceProposal(g2));
  });

  it("encodes domain tags as documented", () => {
    expect(__testing.TX_HASH_DOMAIN).toBe("mono-wallet-multisig-tx-v1");
    expect(__testing.GOV_HASH_DOMAIN).toBe("mono-wallet-multisig-gov-v1");
  });
});

describe("isExecutable", () => {
  const NOW = 1_700_000_000_000;

  it("returns true once approvals >= threshold and not expired", () => {
    const p = makeProposal({
      id: "p",
      approvals: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
    });
    expect(isExecutable(p, 2, NOW)).toBe(true);
  });

  it("returns false below threshold", () => {
    const p = makeProposal({
      id: "p",
      approvals: [{ signerId: "a", signature: "0x01", signedAt: NOW }],
    });
    expect(isExecutable(p, 2, NOW)).toBe(false);
  });

  it("returns false when expired", () => {
    const p = makeProposal({
      id: "p",
      expiresAt: NOW - 1,
      approvals: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
    });
    expect(isExecutable(p, 2, NOW)).toBe(false);
  });

  it("returns false when rejection threshold met", () => {
    const p = makeProposal({
      id: "p",
      approvals: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
      rejections: [
        { signerId: "c", signature: "0x03", signedAt: NOW },
        { signerId: "d", signature: "0x04", signedAt: NOW },
      ],
    });
    expect(isExecutable(p, 2, NOW)).toBe(false);
  });

  it("returns false for terminal statuses", () => {
    for (const status of ["executed", "rejected", "expired"] as const) {
      const p = makeProposal({
        id: "p",
        status,
        approvals: [
          { signerId: "a", signature: "0x01", signedAt: NOW },
          { signerId: "b", signature: "0x02", signedAt: NOW },
        ],
      });
      expect(isExecutable(p, 2, NOW)).toBe(false);
    }
  });
});

describe("isGovernanceExecutable", () => {
  const NOW = 1_700_000_000_000;
  it("mirrors isExecutable on the governance branch", () => {
    const g = makeGovProposal({
      id: "g",
      action: { kind: "change-threshold", threshold: 2 },
      approvals: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
    });
    expect(isGovernanceExecutable(g, 2, NOW)).toBe(true);
    expect(isGovernanceExecutable(g, 3, NOW)).toBe(false);
  });
});

describe("reconcileProposalStatus + reconcileGovernanceStatus", () => {
  const NOW = 1_700_000_000_000;

  it("transitions pending → expired when expiry passes", () => {
    const p = makeProposal({ id: "p", expiresAt: NOW - 1 });
    expect(reconcileProposalStatus(p, 2, NOW)).toBe("expired");
  });

  it("transitions pending → rejected once rejection threshold met", () => {
    const p = makeProposal({
      id: "p",
      rejections: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
    });
    expect(reconcileProposalStatus(p, 2, NOW)).toBe("rejected");
  });

  it("leaves terminal statuses unchanged", () => {
    const p = makeProposal({ id: "p", status: "executed" });
    expect(reconcileProposalStatus(p, 2, NOW)).toBe("executed");
  });

  it("governance variant respects its own status union", () => {
    const g = makeGovProposal({
      id: "g",
      action: { kind: "change-threshold", threshold: 2 },
      status: "applied",
    });
    expect(reconcileGovernanceStatus(g, 2, NOW)).toBe("applied");
  });
});

describe("applyGovernance", () => {
  const baseSigners = (): MultisigSigner[] => [
    makeSigner({ id: "a", address: fakeAddress(0x01), label: "Alice" }),
    makeSigner({ id: "b", address: fakeAddress(0x02), label: "Bob" }),
    makeSigner({ id: "c", address: fakeAddress(0x03), label: "Carol" }),
  ];

  const newId = (() => {
    let n = 0;
    return () => `new-${++n}`;
  })();

  it("add-signer appends, validates, assigns id", () => {
    const action: GovernanceAction = {
      kind: "add-signer",
      signer: {
        label: "Dave",
        address: fakeAddress(0x04),
        pubkey: fakePubkey(0x99),
        role: "external",
      },
    };
    const next = applyGovernance(baseSigners(), 2, action, () => "new-1");
    expect(next.signers).toHaveLength(4);
    expect(next.signers[3]).toEqual({
      id: "new-1",
      label: "Dave",
      address: fakeAddress(0x04),
      pubkey: fakePubkey(0x99),
      role: "external",
    });
    expect(next.threshold).toBe(2);
  });

  it("add-signer rejects duplicate address", () => {
    const action: GovernanceAction = {
      kind: "add-signer",
      signer: {
        label: "Dup",
        address: fakeAddress(0x01),
        pubkey: fakePubkey(0x99),
        role: "external",
      },
    };
    expect(() => applyGovernance(baseSigners(), 2, action, newId)).toThrow(
      /duplicate signer address/,
    );
  });

  it("add-signer rejects roster beyond MAX_SIGNERS", () => {
    const signers: MultisigSigner[] = [];
    for (let i = 0; i < MAX_SIGNERS; i++) {
      signers.push(
        makeSigner({
          id: `s-${i}`,
          address: fakeAddress(0x10 + i),
          pubkey: fakePubkey(0x10 + i),
          label: `S${i}`,
        }),
      );
    }
    const action: GovernanceAction = {
      kind: "add-signer",
      signer: {
        label: "Overflow",
        address: fakeAddress(0xff),
        pubkey: fakePubkey(0xff),
        role: "external",
      },
    };
    expect(() => applyGovernance(signers, 2, action, newId)).toThrow(/at most/);
  });

  it("remove-signer drops the target", () => {
    const action: GovernanceAction = { kind: "remove-signer", signerId: "b" };
    const next = applyGovernance(baseSigners(), 2, action, newId);
    expect(next.signers.map((s) => s.id)).toEqual(["a", "c"]);
    expect(next.threshold).toBe(2);
  });

  it("remove-signer refuses to drop below threshold", () => {
    const action: GovernanceAction = { kind: "remove-signer", signerId: "b" };
    expect(() => applyGovernance(baseSigners(), 3, action, newId)).toThrow(
      /below current threshold/,
    );
  });

  it("remove-signer rejects unknown id", () => {
    const action: GovernanceAction = { kind: "remove-signer", signerId: "z" };
    expect(() => applyGovernance(baseSigners(), 2, action, newId)).toThrow(
      /unknown signerId/,
    );
  });

  it("replace-signer rotates pubkey + address while preserving id", () => {
    const action: GovernanceAction = {
      kind: "replace-signer",
      signerId: "b",
      replacement: {
        label: "Bob-2",
        address: fakeAddress(0x22),
        pubkey: fakePubkey(0x22),
        role: "external",
      },
    };
    const next = applyGovernance(baseSigners(), 2, action, newId);
    const bob = next.signers.find((s) => s.id === "b");
    expect(bob?.address).toBe(fakeAddress(0x22));
    expect(bob?.label).toBe("Bob-2");
  });

  it("change-threshold updates the threshold only", () => {
    const action: GovernanceAction = { kind: "change-threshold", threshold: 3 };
    const next = applyGovernance(baseSigners(), 2, action, newId);
    expect(next.threshold).toBe(3);
    expect(next.signers).toEqual(baseSigners());
  });

  it("change-threshold rejects values out of range", () => {
    expect(() =>
      applyGovernance(baseSigners(), 2, { kind: "change-threshold", threshold: 4 }, newId),
    ).toThrow(/exceed/);
    expect(() =>
      applyGovernance(baseSigners(), 2, { kind: "change-threshold", threshold: 0 }, newId),
    ).toThrow(/>= 1/);
  });
});

describe("pickFirstSelfSigner", () => {
  it("returns the first self signer with a vaultId", () => {
    const signers: MultisigSigner[] = [
      makeSigner({ id: "ext-1", address: fakeAddress(0x01) }),
      makeSigner({
        id: "self-1",
        address: fakeAddress(0x02),
        role: "self",
        vaultId: "v-1",
      } as Partial<MultisigSigner> & { id: string; address: string }),
      makeSigner({
        id: "self-2",
        address: fakeAddress(0x03),
        role: "self",
        vaultId: "v-2",
      } as Partial<MultisigSigner> & { id: string; address: string }),
    ];
    expect(pickFirstSelfSigner(signers)?.id).toBe("self-1");
  });

  it("returns undefined when no self signer exists", () => {
    const signers: MultisigSigner[] = [
      makeSigner({ id: "ext-1", address: fakeAddress(0x01) }),
      makeSigner({ id: "ext-2", address: fakeAddress(0x02) }),
    ];
    expect(pickFirstSelfSigner(signers)).toBeUndefined();
  });

  it("returns undefined for an empty roster", () => {
    expect(pickFirstSelfSigner([])).toBeUndefined();
  });
});

describe("pickNextLocalVoter", () => {
  function buildRoster(): MultisigSigner[] {
    return [
      makeSigner({
        id: "self-a",
        address: fakeAddress(0x01),
        role: "self",
        vaultId: "v-a",
      } as Partial<MultisigSigner> & { id: string; address: string }),
      makeSigner({
        id: "self-b",
        address: fakeAddress(0x02),
        role: "self",
        vaultId: "v-b",
      } as Partial<MultisigSigner> & { id: string; address: string }),
      makeSigner({ id: "ext-c", address: fakeAddress(0x03) }),
    ];
  }

  it("skips already-approved self signers and returns the next eligible", () => {
    const roster = buildRoster();
    const approved = new Set(["self-a"]);
    const rejected = new Set<string>();
    expect(pickNextLocalVoter(roster, approved, rejected)?.id).toBe("self-b");
  });

  it("skips already-rejected self signers", () => {
    const roster = buildRoster();
    const approved = new Set<string>();
    const rejected = new Set(["self-a"]);
    expect(pickNextLocalVoter(roster, approved, rejected)?.id).toBe("self-b");
  });

  it("returns undefined when all self signers have voted", () => {
    const roster = buildRoster();
    const approved = new Set(["self-a"]);
    const rejected = new Set(["self-b"]);
    expect(pickNextLocalVoter(roster, approved, rejected)).toBeUndefined();
  });

  it("never returns external signers even when they haven't voted", () => {
    const roster = buildRoster();
    const approved = new Set(["self-a", "self-b"]);
    const rejected = new Set<string>();
    expect(pickNextLocalVoter(roster, approved, rejected)).toBeUndefined();
  });
});

describe("canonicalStringify", () => {
  const { canonicalStringify } = __testing;

  it("sorts keys", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined fields", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("encodes nested arrays + objects deterministically", () => {
    const v = { z: [3, 1, { y: 2, x: 1 }], a: null };
    expect(canonicalStringify(v)).toBe('{"a":null,"z":[3,1,{"x":1,"y":2}]}');
  });
});
