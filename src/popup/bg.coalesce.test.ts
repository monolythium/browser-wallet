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
import {
  bgWalletBalance,
  bgVaultsList,
  bgVaultRemove,
  bgVaultExportSeed,
  bgTwoTierGetState,
} from "./bg";

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

  // The coalesce key is `${op}|${JSON.stringify(payload)}`. For a
  // password-taking op that key would embed the PLAINTEXT PASSWORD in a Map
  // held in popup memory — so no such op may ever join the allow-list. On top
  // of that, vault-remove is a destructive write (two collapsed calls would
  // report one removal twice) and vault-export-seed returns a secret.
  it("vault-remove is NOT coalesced — a destructive write must never be shared", async () => {
    await Promise.all([
      bgVaultRemove("pw", "v1"),
      bgVaultRemove("pw", "v1"),
    ]);
    expect(sent.filter((s) => s.op === "vault-remove").length).toBe(2);
  });

  it("vault-export-seed is NOT coalesced — a secret read must never be shared", async () => {
    await Promise.all([
      bgVaultExportSeed("pw", "v1"),
      bgVaultExportSeed("pw", "v1"),
    ]);
    expect(sent.filter((s) => s.op === "vault-export-seed").length).toBe(2);
  });

  // Every `useFeature` consumer reads this on mount, and one page mounts many —
  // each gated surface plus a DevBadge on each. In MV3 every IPC can wake the
  // service worker, so the un-coalesced version was several wakes for one
  // answer. Nine stands in for the busiest page (About / OperatorDirectory).
  it("two-tier-get-state: nine concurrent badge reads share ONE sendMessage", async () => {
    const results = await Promise.all(
      Array.from({ length: 9 }, () => bgTwoTierGetState()),
    );
    expect(sent.filter((s) => s.op === "two-tier-get-state").length).toBe(1);
    // Every caller still gets the same answer — no consumer is left unresolved,
    // which is what would make a badge silently fail to appear.
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("two-tier-get-state: a later mount still re-reads, so a flag change lands", async () => {
    await Promise.all([bgTwoTierGetState(), bgTwoTierGetState()]);
    expect(sent.filter((s) => s.op === "two-tier-get-state").length).toBe(1);
    // Cleared on settle: navigating to another page must not be served a stale
    // in-flight promise from the previous one.
    sent = [];
    await bgTwoTierGetState();
    expect(sent.filter((s) => s.op === "two-tier-get-state").length).toBe(1);
  });
});
