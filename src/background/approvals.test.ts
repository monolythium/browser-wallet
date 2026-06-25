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

describe("approvals — rejectAllPending + reapExpired (P4-001)", () => {
  it("rejectAllPending: every pending approval resolves rejected and the bus is cleared (D1a)", async () => {
    const a = await import("./approvals.js");
    const p1 = a.enqueue(sendTx("https://a.example", "0xAAA", "0x1"));
    const p2 = a.enqueue(sendTx("https://b.example", "0xBBB", "0x2"));
    await tick();
    expect(a.listPending().length).toBe(2);
    // A locked wallet can't sign — every waiting dApp call must resolve rejected,
    // not hang, and the bus must drain.
    a.rejectAllPending("wallet locked");
    expect(await p1).toEqual({ ok: false, reason: "wallet locked" });
    expect(await p2).toEqual({ ok: false, reason: "wallet locked" });
    expect(a.listPending().length).toBe(0);
  });

  it("reapExpired: rejects approvals older than ttl, keeps fresh ones, reports counts (D1b)", async () => {
    const a = await import("./approvals.js");
    const pOld = a.enqueue(sendTx("https://old.example", "0xAAA", "0x1"));
    await tick();
    const createdAt = a.listPending()[0]!.createdAt;
    // now is 1s past createdAt with a 1ms ttl → the entry is expired and reaped.
    const r1 = a.reapExpired(1, createdAt + 1000);
    expect(r1).toEqual({ reaped: 1, remaining: 0 });
    expect(await pOld).toEqual({
      ok: false,
      reason: "approval expired — please retry",
    });
    expect(a.listPending().length).toBe(0);

    // A fresh entry within the ttl is NOT reaped.
    const pFresh = a.enqueue(sendTx("https://fresh.example", "0xBBB", "0x2"));
    await tick();
    const freshCreatedAt = a.listPending()[0]!.createdAt;
    const r2 = a.reapExpired(180_000, freshCreatedAt + 1000); // 1s elapsed < 3min
    expect(r2).toEqual({ reaped: 0, remaining: 1 });
    expect(a.listPending().length).toBe(1);
    // settle the survivor so the test leaves no dangling promise
    a.resolve(a.listPending()[0]!.id, { ok: false });
    await pFresh;
  });
});

describe("approvals — resolve window-binding (P4-005)", () => {
  it("rejects a resolve from a window that does not own the approval", async () => {
    const a = await import("./approvals.js");
    void a.enqueue(sendTx("https://a.example", "0x1", "0x1"));
    await tick(); // openApprovalWindow sets entry.windowId = 1
    const id = a.listPending()[0]!.id;
    expect(a.resolve(id, { ok: true }, 999)).toBe(false); // wrong window
    expect(a.listPending().some((p) => p.id === id)).toBe(true); // still pending
    a.resolve(id, { ok: false }, 1); // settle the dangling promise
  });

  it("resolves from the owning window", async () => {
    const a = await import("./approvals.js");
    void a.enqueue(sendTx("https://b.example", "0x2", "0x2"));
    await tick();
    const id = a.listPending()[0]!.id;
    expect(a.resolve(id, { ok: true }, 1)).toBe(true); // entry.windowId === 1
    expect(a.listPending().some((p) => p.id === id)).toBe(false); // removed
  });

  it("fail-open: a resolve with no caller windowId still resolves", async () => {
    const a = await import("./approvals.js");
    void a.enqueue(sendTx("https://c.example", "0x3", "0x3"));
    await tick();
    const id = a.listPending()[0]!.id;
    expect(a.resolve(id, { ok: false })).toBe(true); // no callerWindowId
    expect(a.listPending().some((p) => p.id === id)).toBe(false);
  });

  it("fail-open: a resolve when entry.windowId was never captured still resolves", async () => {
    const chromeStub = (globalThis as unknown as {
      chrome: { windows: { create: (...a: unknown[]) => Promise<{ id?: number }> } };
    }).chrome;
    chromeStub.windows.create = vi.fn(async () => ({})); // no id captured
    const a = await import("./approvals.js");
    void a.enqueue(sendTx("https://d.example", "0x4", "0x4"));
    await tick();
    const id = a.listPending()[0]!.id;
    // entry.windowId is undefined → cross-check skipped even with a caller id.
    expect(a.resolve(id, { ok: true }, 42)).toBe(true);
    expect(a.listPending().some((p) => p.id === id)).toBe(false);
  });
});
