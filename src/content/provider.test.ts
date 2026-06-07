// F-2.1 regression — the in-page provider's "message" handler must reject
// envelopes whose ev.source is not THIS window, or whose ev.origin is not THIS
// page's origin, so a co-resident / cross-frame script cannot inject a fake
// accountsChanged/chainChanged (or resolve a pending request). Legitimate
// same-window, same-origin bridge->provider traffic must still be processed.
//
// Default test env is node (no jsdom): window / chrome / CustomEvent are
// hand-stubbed. The provider runs module-level side effects on import (it
// installs window.ethereum), so each test imports a fresh copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (ev: unknown) => void;

let messageListener: Listener | null;
let stubWindow: {
  location: { origin: string };
  addEventListener: (t: string, fn: Listener) => void;
  dispatchEvent: unknown;
  postMessage: unknown;
  ethereum?: { on: (e: string, h: (a: unknown) => void) => void; request: (a: { method: string }) => Promise<unknown> };
};

function installEnv() {
  messageListener = null;
  const listeners = new Map<string, Listener>();
  stubWindow = {
    location: { origin: "https://dapp.example" },
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, fn);
      if (type === "message") messageListener = fn;
    },
    dispatchEvent: vi.fn(),
    postMessage: vi.fn(),
  };
  (globalThis as { window?: unknown }).window = stubWindow;
  (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

async function loadProvider() {
  vi.resetModules();
  await import("./provider");
  return stubWindow.ethereum!;
}

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  vi.restoreAllMocks();
});

const ADDR = "0xaaa0000000000000000000000000000000000001";

function accountsEvent(source: unknown, origin: string) {
  return {
    source,
    origin,
    data: { source: "monolythium-wallet-bridge", event: "accountsChanged", payload: [ADDR] },
  };
}

describe("provider postMessage source/origin guard (F-2.1)", () => {
  it("applies a same-window, same-origin accountsChanged event", async () => {
    const provider = await loadProvider();
    const seen: unknown[] = [];
    provider.on("accountsChanged", (a) => seen.push(a));
    messageListener!(accountsEvent(stubWindow, "https://dapp.example"));
    expect(seen).toHaveLength(1);
    expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDR]);
  });

  it("ignores an event whose ev.source is not this window (forged / cross-frame)", async () => {
    const provider = await loadProvider();
    const seen: unknown[] = [];
    provider.on("accountsChanged", (a) => seen.push(a));
    messageListener!(accountsEvent({}, "https://dapp.example"));
    expect(seen).toHaveLength(0);
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("ignores an event from a different origin even if ev.source is this window", async () => {
    const provider = await loadProvider();
    const seen: unknown[] = [];
    provider.on("accountsChanged", (a) => seen.push(a));
    messageListener!(accountsEvent(stubWindow, "https://evil.example"));
    expect(seen).toHaveLength(0);
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });
});
