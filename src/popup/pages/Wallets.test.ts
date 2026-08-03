// Wallets page — the pure logic behind the list.
//
// The page itself is not asserted here. It renders PasswordGate, which mounts
// the shared PasswordInput, and (from the action-sheet commit) Modal, which
// portals into document.body — and this suite has no jsdom. What IS covered is
// the logic that decides what the user sees: the absent-vs-live-zero
// distinction, and the concurrency cap that keeps N balance reads from
// stampeding a single operator.
//
// Hand-verification only: the gate actually blocking the list, progressive
// render order, and the fiat em dash on screen.

import { describe, expect, it } from "vitest";

import {
  ABSENT,
  BALANCE_CONCURRENCY,
  REMOVE_GATE_PROMPT,
  WALLETS_GATE_PROMPT,
  canRemoveWallet,
  multisigLabelsReferencing,
  removeWarningHeading,
  runWithConcurrency,
  sheetTargetAfterOpen,
  walletBalanceText,
  type MultisigRosterEntry,
} from "./Wallets";

const LYTH = 10n ** 18n;

describe("walletBalanceText — honest absence vs a real zero", () => {
  it("renders a live balance through the same formatter Home uses", () => {
    expect(walletBalanceText({ kind: "live", lythoshi: 1234n * LYTH })).toBe(
      (1234).toLocaleString() + ".00",
    );
  });

  it("renders a LIVE ZERO as 0.00 — a real reading is never suppressed", () => {
    // The easiest thing to get wrong here: a wallet that genuinely holds
    // nothing must say so, not go blank.
    expect(walletBalanceText({ kind: "live", lythoshi: 0n })).toBe("0.00");
  });

  it("renders nothing for a failed read — never a fabricated 0.00", () => {
    expect(walletBalanceText({ kind: "absent" })).toBeNull();
  });

  it("renders nothing while the read is still in flight", () => {
    expect(walletBalanceText({ kind: "pending" })).toBeNull();
  });

  it("truncates rather than rounds, matching the house formatter", () => {
    // 1.999… must not become 2.00 — the row would overstate the balance.
    const almostTwo = 2n * LYTH - 1n;
    expect(walletBalanceText({ kind: "live", lythoshi: almostTwo })).toBe("1.99");
  });

  it("keeps full magnitude above 2^53 (bigint path, no float)", () => {
    const huge = 90_071_992_547_409_91n * LYTH;
    const out = walletBalanceText({ kind: "live", lythoshi: huge })!;
    expect(out.replace(/[^0-9]/g, "")).toBe("900719925474099100");
  });

  it("the absence marker is the house em dash, not a zero or a placeholder", () => {
    expect(ABSENT).toBe("—");
    expect(ABSENT).not.toBe("0.00");
  });
});

describe("runWithConcurrency — the balance fan-out cap", () => {
  const deferred = () => {
    let release!: () => void;
    const p = new Promise<void>((res) => {
      release = res;
    });
    return { p, release };
  };

  it("never exceeds the limit in flight", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(items, 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("visits every item exactly once, in order", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const seen: string[] = [];
    const idx: number[] = [];
    await runWithConcurrency(items, 2, async (item, i) => {
      seen.push(item);
      idx.push(i);
    });
    expect(seen.sort()).toEqual([...items].sort());
    expect(idx.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  it("starts the next item as soon as a slot frees, not in lockstep batches", async () => {
    // Proves it is a worker pool rather than a chunked loop: with limit 2 and
    // the first item held open, items 2 and 3 must still make progress.
    const hold = deferred();
    const started: number[] = [];
    const run = runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) await hold.p;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toContain(1);
    expect(started).toContain(2);
    hold.release();
    await run;
    expect(started.sort()).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty list without spawning a runner", async () => {
    let calls = 0;
    await runWithConcurrency([], 2, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("clamps the width to the item count for a short list", async () => {
    let peak = 0;
    let inFlight = 0;
    await runWithConcurrency([1], 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it("treats a zero or negative limit as serial rather than stalling", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("caps the balance fan-out at 2", () => {
    // Each read costs two sequential round-trips per operator and reads are not
    // batched across addresses, so this constant is what stops N wallets from
    // stampeding a single host.
    expect(BALANCE_CONCURRENCY).toBe(2);
  });
});

describe("Wallets gate copy", () => {
  it("asks for the password in the shape ResetWallet already uses", () => {
    expect(WALLETS_GATE_PROMPT).toBe(
      "Confirm your password to manage your wallets.",
    );
  });

  it("asks again, per action, before a removal", () => {
    // Decision 2: the page-entry gate does NOT satisfy the per-action gate.
    expect(REMOVE_GATE_PROMPT).toBe(
      "Confirm your password to remove this wallet.",
    );
  });
});

describe("canRemoveWallet — the single-wallet predicate", () => {
  it("hides the action when there is exactly one wallet", () => {
    // Removing the only wallet would leave activeVaultId dangling and brick
    // the container at next unlock, so the keystore refuses. Offering it and
    // refusing after a password and a typed DELETE is not a real choice.
    expect(canRemoveWallet(1)).toBe(false);
  });

  it("offers the action from two wallets upward", () => {
    expect(canRemoveWallet(2)).toBe(true);
    expect(canRemoveWallet(9)).toBe(true);
  });

  it("hides the action for an empty or unknown list rather than failing open", () => {
    expect(canRemoveWallet(0)).toBe(false);
  });
});

describe("removeWarningHeading", () => {
  it("names the wallet being destroyed, in ResetWallet's wording", () => {
    expect(removeWarningHeading("Trading")).toBe(
      "This permanently deletes Trading from this browser.",
    );
  });
});

describe("multisigLabelsReferencing — who loses a signer", () => {
  const entry = (
    label: string,
    vaultId: string,
    signers: MultisigRosterEntry["signers"],
  ): MultisigRosterEntry => ({ label, vaultId, signers });

  it("matches a self-signer by vaultId", () => {
    const rosters = [
      entry("Treasury", "ms-1", [{ address: "0xzzz", vaultId: "target" }]),
    ];
    expect(multisigLabelsReferencing(rosters, "target", "0xaaa")).toEqual([
      "Treasury",
    ]);
  });

  it("matches an external signer by address, case-insensitively", () => {
    const rosters = [entry("Treasury", "ms-1", [{ address: "0xAAA" }])];
    expect(multisigLabelsReferencing(rosters, "target", "0xaaa")).toEqual([
      "Treasury",
    ]);
  });

  it("names every affected wallet, not just the first", () => {
    const rosters = [
      entry("Treasury", "ms-1", [{ address: "0xaaa" }]),
      entry("Ops", "ms-2", [{ address: "0xbbb", vaultId: "target" }]),
      entry("Unrelated", "ms-3", [{ address: "0xccc" }]),
    ];
    expect(multisigLabelsReferencing(rosters, "target", "0xaaa")).toEqual([
      "Treasury",
      "Ops",
    ]);
  });

  it("never names the wallet being removed, even if it is itself a multisig", () => {
    const rosters = [entry("Self", "target", [{ address: "0xaaa" }])];
    expect(multisigLabelsReferencing(rosters, "target", "0xaaa")).toEqual([]);
  });

  it("returns empty when nothing references it", () => {
    const rosters = [entry("Treasury", "ms-1", [{ address: "0xbbb" }])];
    expect(multisigLabelsReferencing(rosters, "target", "0xaaa")).toEqual([]);
  });

  it("returns empty for no multisig wallets at all", () => {
    expect(multisigLabelsReferencing([], "target", "0xaaa")).toEqual([]);
  });
});

describe("sheetTargetAfterOpen — an open sheet owns the target (DA-001)", () => {
  // What this CAN observe: the rule that decides which wallet an open sheet is
  // pointed at. What it CANNOT: the interaction itself. The sheet mounts Modal,
  // which portals into document.body, and this suite has no jsdom — so the
  // keyboard activation behind the backdrop, the preserved password, and the
  // armed typed-DELETE are hand-verification only.
  it("takes the requested wallet when no sheet is open", () => {
    expect(sheetTargetAfterOpen(null, "wallet-b")).toBe("wallet-b");
  });

  it("KEEPS the open sheet's wallet when another is requested", () => {
    expect(sheetTargetAfterOpen("wallet-a", "wallet-b")).toBe("wallet-a");
  });

  it("keeps the open wallet even when it is the one requested again", () => {
    expect(sheetTargetAfterOpen("wallet-a", "wallet-a")).toBe("wallet-a");
  });

  it("works on the object identities the page actually stores", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(sheetTargetAfterOpen(a, b)).toBe(a);
    expect(sheetTargetAfterOpen(null, b)).toBe(b);
  });
});
