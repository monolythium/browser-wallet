// F-2.1 / F-2.2 regression — the bridge's window "message" listener must reject
// envelopes whose ev.source is not THIS window (forged / cross-frame posts, e.g.
// a cross-origin child iframe doing window.top.postMessage) while still
// forwarding legitimate same-window provider->bridge traffic to the SW.
//
// Default test env is node (no jsdom), so window + chrome are hand-stubbed. The
// bridge runs module-level side effects on import, so each test imports a fresh
// copy via vi.resetModules() after the stubs are installed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (ev: unknown) => void;

let messageListener: Listener | null;
let sendMessageCalls: Array<{ kind?: string; origin?: string }>;
let stubWindow: { location: { origin: string }; addEventListener: (t: string, fn: Listener) => void; postMessage: unknown };

function installEnv() {
  messageListener = null;
  sendMessageCalls = [];
  const listeners = new Map<string, Listener>();
  stubWindow = {
    location: { origin: "https://dapp.example" },
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, fn);
      if (type === "message") messageListener = fn;
    },
    postMessage: vi.fn(),
  };
  (globalThis as { window?: unknown }).window = stubWindow;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-ext-id",
      lastError: undefined,
      sendMessage: (msg: { kind?: string; origin?: string }, cb?: (r: unknown) => void) => {
        sendMessageCalls.push(msg);
        if (cb) cb(undefined);
      },
      onMessage: { addListener: vi.fn() },
    },
  };
}

async function loadBridge() {
  vi.resetModules();
  await import("./bridge");
}

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

const pageEnvelope = {
  source: "monolythium-wallet-page",
  id: "req-1",
  args: { method: "eth_chainId" },
};

function rpcForwards(fromIndex: number) {
  return sendMessageCalls.slice(fromIndex).filter((m) => m?.kind === "rpc");
}

describe("bridge postMessage source guard (F-2.1/F-2.2)", () => {
  it("forwards a same-window page envelope to the service worker", async () => {
    await loadBridge();
    expect(messageListener).toBeTruthy();
    const before = sendMessageCalls.length; // import-time announce
    messageListener!({ source: stubWindow, origin: "https://dapp.example", data: pageEnvelope });
    const rpc = rpcForwards(before);
    expect(rpc).toHaveLength(1);
    expect(rpc[0]!.origin).toBe("https://dapp.example");
  });

  it("ignores an envelope whose ev.source is not this window (forged / cross-frame)", async () => {
    await loadBridge();
    const before = sendMessageCalls.length;
    // ev.source is a different window object — a cross-origin child iframe's
    // window.top.postMessage, or any co-resident frame.
    messageListener!({ source: {}, origin: "https://dapp.example", data: pageEnvelope });
    expect(rpcForwards(before)).toHaveLength(0);
  });

  it("still ignores a same-window envelope with the wrong source tag", async () => {
    await loadBridge();
    const before = sendMessageCalls.length;
    messageListener!({ source: stubWindow, origin: "https://dapp.example", data: { source: "evil", id: "x", args: {} } });
    expect(rpcForwards(before)).toHaveLength(0);
  });
});
