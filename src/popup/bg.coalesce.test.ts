// C4: popup-side read coalescing in send().
//
// The popup fires the chain-gated reads (balance, activity) from several
// independent component mounts + effects per open, each launching its own SW
// round-trip → its own operator walk. send() collapses concurrent IDENTICAL
// reads (op+payload) onto ONE in-flight round-trip via a default-DENY allow-list
// (wallet-balance / wallet-activity-get / wallet-indexer-snapshot). Writes,
// keystore ops, locals, and any unlisted op bypass — so no submit is ever
// shared. The map clears on SETTLE (not a TTL): only truly-concurrent reads
// merge; a later identical read is always a fresh round-trip.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bgWalletBalance, bgVaultsList } from "./bg";

let sent: Array<{ op: string }>;

beforeEach(() => {
  sent = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: unknown, cb: (resp: unknown) => void) => {
        sent.push({ op: (msg as { op: string }).op });
        // Resolve on a later tick so the two concurrent calls genuinely overlap
        // in-flight (the coalescing window is "while a prior identical call is
        // still unsettled").
        setTimeout(
          () =>
            cb({
              ok: true,
              balanceHex: "0x1",
              spendGuardHex: "0x1",
              vaults: [],
            }),
          5,
        );
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("popup send() read coalescing (C4 / T7)", () => {
  it("T7: two concurrent identical bgWalletBalance share ONE sendMessage", async () => {
    const [a, b] = await Promise.all([
      bgWalletBalance("0xabc", "0x10f2c"),
      bgWalletBalance("0xabc", "0x10f2c"),
    ]);
    expect(sent.filter((s) => s.op === "wallet-balance").length).toBe(1);
    expect(a).toEqual(b);

    // After settle the key is cleared → a later identical read re-fetches.
    sent = [];
    await bgWalletBalance("0xabc", "0x10f2c");
    expect(sent.filter((s) => s.op === "wallet-balance").length).toBe(1);
  });

  it("T7b: bgVaultsList (not in the allow-list) is NOT coalesced", async () => {
    await Promise.all([bgVaultsList(), bgVaultsList()]);
    expect(sent.filter((s) => s.op === "vault-list").length).toBe(2);
  });

  it("T7c: different payloads (distinct accounts) are NOT coalesced", async () => {
    await Promise.all([
      bgWalletBalance("0xaaa", "0x10f2c"),
      bgWalletBalance("0xbbb", "0x10f2c"),
    ]);
    expect(sent.filter((s) => s.op === "wallet-balance").length).toBe(2);
  });
});
