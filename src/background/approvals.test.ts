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
const personalSign = (origin: string, message: string, address = "0xabc") => ({
  kind: "personal_sign" as const,
  origin,
  message,
  address,
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
  it("dedup: a duplicate (same kind+origin) reuses the open window; one decision resolves all", async () => {
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

  it("dedup is payload-aware: two DISTINCT personal_sign messages get separate windows", async () => {
    const a = await import("./approvals.js");
    const p1 = a.enqueue(personalSign("https://a.example", "hello"));
    const p2 = a.enqueue(personalSign("https://a.example", "goodbye"));
    await tick();
    // Distinct payloads must NOT collapse — one user decision cannot sign both.
    expect(createCalls).toBe(2);
    expect(a.listPending().length).toBe(2);
    // Resolving the first window must not resolve the second caller.
    const first = a
      .listPending()
      .find((x) => x.request.kind === "personal_sign" && x.request.message === "hello")!;
    a.resolve(first.id, { ok: true });
    expect(await p1).toEqual({ ok: true });
    let p2Settled = false;
    void p2.then(() => {
      p2Settled = true;
    });
    await tick();
    expect(p2Settled).toBe(false);
    const second = a.listPending()[0]!;
    a.resolve(second.id, { ok: false, reason: "user rejected" });
    expect(await p2).toEqual({ ok: false, reason: "user rejected" });
  });

  it("dedup still collapses IDENTICAL personal_sign requests onto one window", async () => {
    const a = await import("./approvals.js");
    const p1 = a.enqueue(personalSign("https://a.example", "same"));
    const p2 = a.enqueue(personalSign("https://a.example", "same"));
    await tick();
    expect(createCalls).toBe(1);
    expect(a.listPending().length).toBe(1);
    a.resolve(a.listPending()[0]!.id, { ok: true });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
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
