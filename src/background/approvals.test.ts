// T4-06 — approval-bus window-bomb guards: dedup, concurrency cap, rate limit.
//
// The module holds a process-level `pending` Map, so each test imports a fresh
// copy via vi.resetModules(). chrome.windows/runtime/storage are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let createCalls: number;

function installChrome() {
  createCalls = 0;
  (globalThis as { chrome?: unknown }).chrome = {
    windows: {
      create: vi.fn(async () => {
        createCalls += 1;
        return { id: createCalls };
      }),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
    storage: { local: { set: (_o: unknown, cb?: () => void) => cb && cb() } },
  };
}

const connect = (origin: string) => ({ kind: "connect" as const, origin });

// A minimal-but-valid send_tx approval request. `to`/`value` vary per call so a
// test can build distinct or byte-identical sends from one origin.
const sendTx = (origin: string, to: string, value: string) => ({
  kind: "send_tx" as const,
  origin,
  tx: { to, value },
  view: {
    executionUnitLimitHex: null,
    pricePerExecutionUnitLythoshiHex: null,
    nonce: null,
    simulation: null,
    chainId: "0x10F2C",
    chainLabel: "Monolythium Testnet",
  },
});

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  installChrome();
  vi.resetModules();
});
afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("approvals — window-bomb guards (T4-06)", () => {
  it("dedup: a duplicate connect (same kind+origin) reuses the open window; one decision resolves all", async () => {
    // connect is the ONE idempotent kind dedup still collapses (C7): no
    // consent-relevant payload, and double-execution merely re-returns accounts.
    const a = await import("./approvals.js");
    const p1 = a.enqueue(connect("https://a.example"));
    const p2 = a.enqueue(connect("https://a.example"));
    await tick();
    // Only ONE window opened for both callers.
    expect(createCalls).toBe(1);
    expect(a.listPending().length).toBe(1);
    const id = a.listPending()[0]!.id;
    a.resolve(id, { ok: true });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
  });

  it("C7: two DISTINCT send_tx (different to/value) from one origin → two windows, two separate decisions", async () => {
    // The confused-deputy case. A payload-bearing kind must NEVER collapse: the
    // user must consent to each tx, and a decision on one must not resolve the
    // other (else an unseen distinct tx would be signed off tx#1's approval).
    const a = await import("./approvals.js");
    const p1 = a.enqueue(sendTx("https://dapp.example", "0xAAA", "0x1"));
    const p2 = a.enqueue(sendTx("https://dapp.example", "0xBBB", "0x999"));
    await tick();
    expect(createCalls).toBe(2);
    expect(a.listPending().length).toBe(2);
    // Resolve each window with a DIFFERENT decision; each must land on its OWN
    // promise (proof they never shared a resolver).
    const pendings = a.listPending();
    const e1 = pendings.find((p) => p.request.kind === "send_tx" && p.request.tx.to === "0xAAA")!;
    const e2 = pendings.find((p) => p.request.kind === "send_tx" && p.request.tx.to === "0xBBB")!;
    a.resolve(e1.id, { ok: true });
    a.resolve(e2.id, { ok: false, reason: "rejected #2" });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: false, reason: "rejected #2" });
  });

  it("C7: two BYTE-IDENTICAL send_tx from one origin → still two windows, two decisions (no double-submit off one consent)", async () => {
    // Even identical sends must not collapse: each request's continuation
    // independently submits, so one approval covering both would put TWO txs
    // on-chain from ONE consent. Full-identity dedup keying would re-open this
    // hole — hence dedup is restricted to connect, not "identical".
    const a = await import("./approvals.js");
    const p1 = a.enqueue(sendTx("https://dapp.example", "0xAAA", "0x1"));
    const p2 = a.enqueue(sendTx("https://dapp.example", "0xAAA", "0x1"));
    await tick();
    expect(createCalls).toBe(2);
    expect(a.listPending().length).toBe(2);
    // Two independent consents — distinct decisions must split across the two
    // promises (a collapse would force both to share one decision).
    const ids = a.listPending().map((p) => p.id);
    a.resolve(ids[0]!, { ok: true });
    a.resolve(ids[1]!, { ok: false, reason: "second consent" });
    const settled = [await p1, await p2];
    expect(settled).toContainEqual({ ok: true });
    expect(settled).toContainEqual({ ok: false, reason: "second consent" });
  });

  it("C7: two switch_chain to DIFFERENT chainIds from one origin → two windows (distinct intents not collapsed)", async () => {
    const a = await import("./approvals.js");
    const p1 = a.enqueue({ kind: "switch_chain", origin: "https://d.example", chainId: "0x1" });
    const p2 = a.enqueue({ kind: "switch_chain", origin: "https://d.example", chainId: "0x2" });
    await tick();
    expect(createCalls).toBe(2);
    expect(a.listPending().length).toBe(2);
    for (const p of a.listPending()) a.resolve(p.id, { ok: false });
    await Promise.all([p1, p2]);
  });

  it("concurrency cap: the 6th distinct pending approval is rejected", async () => {
    const a = await import("./approvals.js");
    const open = ["b", "c", "d", "e", "f"].map((o) =>
      a.enqueue(connect(`https://${o}.example`)),
    );
    await tick();
    expect(a.listPending().length).toBe(5);
    const sixth = await a.enqueue(connect("https://g.example"));
    expect(sixth.ok).toBe(false);
    expect((sixth as { reason?: string }).reason).toContain("too many pending");
    // resolve the 5 open ones so their promises settle
    for (const p of a.listPending()) a.resolve(p.id, { ok: false });
    await Promise.all(open);
  });

  it("rate limit: the 9th request from one origin in the window is rejected", async () => {
    const a = await import("./approvals.js");
    const spam = [];
    for (let i = 0; i < 8; i++) spam.push(a.enqueue(connect("https://spam.example")));
    const ninth = await a.enqueue(connect("https://spam.example"));
    expect(ninth.ok).toBe(false);
    expect((ninth as { reason?: string }).reason).toContain("too many requests");
    // The 8 deduped callers share one window; resolve it so they settle.
    const id = a.listPending()[0]?.id;
    if (id) a.resolve(id, { ok: false });
    await Promise.all(spam);
  });
});
