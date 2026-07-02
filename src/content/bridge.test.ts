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
let stubWindow: { location: { origin: string }; addEventListener: (t: string, fn: Listener) => void; postMessage: ReturnType<typeof vi.fn> };
// What the stub SW replies to the load-time announce (the initial-state sync).
// `undefined` = legacy/absent SW (no reply).
let announceResponse: unknown;

function installEnv() {
  messageListener = null;
  sendMessageCalls = [];
  announceResponse = undefined;
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
        if (cb) cb(msg?.kind === "announce" ? announceResponse : undefined);
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

  it("ignores an envelope whose ev.origin is not this page's origin (P4-003)", async () => {
    await loadBridge();
    const before = sendMessageCalls.length;
    // Passes the ev.source check (same window object) but the origin string is
    // a different origin → the new ev.origin guard drops it.
    messageListener!({ source: stubWindow, origin: "https://evil.example", data: pageEnvelope });
    expect(rpcForwards(before)).toHaveLength(0);
  });
});

// ---- BROKEN-1/2 fix — announce reply relayed as the initial-state sync ----

describe("announce state relay (initial provider-state sync)", () => {
  function statePosts(): Array<{ source?: string; state?: unknown }> {
    return stubWindow.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as { source?: string; state?: unknown })
      .filter((m) => m?.source === "monolythium-wallet-bridge" && "state" in (m ?? {}));
  }

  it("relays the SW's announce reply to the page as a state envelope", async () => {
    announceResponse = { accounts: ["0xaaa0000000000000000000000000000000000001"], chainId: "0x2a" };
    await loadBridge();
    const posts = statePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.state).toEqual({
      accounts: ["0xaaa0000000000000000000000000000000000001"],
      chainId: "0x2a",
    });
  });

  it("posts no state envelope when the SW does not reply (legacy/absent SW)", async () => {
    announceResponse = undefined;
    await loadBridge();
    expect(statePosts()).toHaveLength(0);
  });

  it("relays an empty-state reply verbatim (non-connected origin carries no accounts)", async () => {
    announceResponse = { accounts: [], chainId: "0x10F2C" };
    await loadBridge();
    const posts = statePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.state).toEqual({ accounts: [], chainId: "0x10F2C" });
    expect(JSON.stringify(posts)).not.toContain("0xaaa");
  });
});

// CodeQL js/cross-window-information-leak — every outbound post must target the
// page origin, never "*" (a "*" broadcast leaks accounts/chainId/RPC results to
// any co-resident or post-redirect cross-origin frame).
describe("outbound postMessage targets the page origin (not '*')", () => {
  it("posts the initial-state sync with the page origin as targetOrigin", async () => {
    announceResponse = { accounts: ["0xaaa0000000000000000000000000000000000001"], chainId: "0x2a" };
    await loadBridge();
    const stateCall = stubWindow.postMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { state?: unknown })?.state !== undefined,
    );
    expect(stateCall).toBeTruthy();
    expect(stateCall![1]).toBe("https://dapp.example");
    expect(stateCall![1]).not.toBe("*");
  });

  it("posts the RPC reply with the page origin as targetOrigin", async () => {
    await loadBridge();
    const before = stubWindow.postMessage.mock.calls.length;
    messageListener!({ source: stubWindow, origin: "https://dapp.example", data: pageEnvelope });
    const replyCall = stubWindow.postMessage.mock.calls
      .slice(before)
      .find((c: unknown[]) => (c[0] as { id?: string })?.id === "req-1");
    expect(replyCall).toBeTruthy();
    expect(replyCall![1]).toBe("https://dapp.example");
    expect(replyCall![1]).not.toBe("*");
  });

  it("never uses '*' as a targetOrigin on any outbound post", async () => {
    announceResponse = { accounts: [], chainId: "0x2a" };
    await loadBridge();
    messageListener!({ source: stubWindow, origin: "https://dapp.example", data: pageEnvelope });
    for (const call of stubWindow.postMessage.mock.calls) {
      expect(call[1]).toBe("https://dapp.example");
    }
  });
});
