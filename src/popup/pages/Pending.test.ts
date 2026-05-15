// Phase 8 Commit 4 — pure-helper tests for Pending.tsx.

import { describe, expect, it } from "vitest";
import { bucket } from "./Pending.js";
import type { PendingProposal } from "../../shared/multisig.js";

function makeProposal(
  partial: Partial<PendingProposal> & Pick<PendingProposal, "id">,
): PendingProposal {
  const now = 1_700_000_000_000;
  return {
    proposedBy: "s-1",
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    vaultAddress: "0x" + "ab".repeat(20),
    action: {
      kind: "send",
      to: "0x" + "cd".repeat(20),
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

describe("Pending.bucket", () => {
  const NOW = 1_700_000_000_000;

  it("returns 'pending' for a fresh in-window proposal under-threshold", () => {
    const p = makeProposal({ id: "p-1" });
    expect(bucket(p, 2, NOW)).toBe("pending");
  });

  it("returns 'terminal' for an executed proposal", () => {
    const p = makeProposal({ id: "p-1", status: "executed" });
    expect(bucket(p, 2, NOW)).toBe("terminal");
  });

  it("returns 'terminal' for a rejected proposal", () => {
    const p = makeProposal({ id: "p-1", status: "rejected" });
    expect(bucket(p, 2, NOW)).toBe("terminal");
  });

  it("returns 'terminal' when expiry has passed", () => {
    const p = makeProposal({ id: "p-1", expiresAt: NOW - 1 });
    expect(bucket(p, 2, NOW)).toBe("terminal");
  });

  it("returns 'terminal' once rejection count reaches threshold", () => {
    const p = makeProposal({
      id: "p-1",
      rejections: [
        { signerId: "a", signature: "0x01", signedAt: NOW },
        { signerId: "b", signature: "0x02", signedAt: NOW },
      ],
    });
    expect(bucket(p, 2, NOW)).toBe("terminal");
  });
});
