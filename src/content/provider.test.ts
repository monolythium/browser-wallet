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

// ---- BROKEN-1/2 fix — initial-state sync seeds the locally-answered arms ----

function stateEnvelope(
  source: unknown,
  origin: string,
  state: { accounts?: unknown; chainId?: unknown },
) {
  return {
    source,
    origin,
    data: { source: "monolythium-wallet-bridge", state },
  };
}

describe("initial-state sync (BROKEN-1/2 fix)", () => {
  it("seeds eth_accounts / eth_chainId / net_version from the synced state (CT-1 / CT-3)", async () => {
    const provider = await loadProvider();
    // The bridge relays the SW's announce reply on load — before any request.
    messageListener!(
      stateEnvelope(stubWindow, "https://dapp.example", {
        accounts: [ADDR],
        chainId: "0x2a",
      }),
    );
    expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDR]);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x2a");
    expect(await provider.request({ method: "net_version" })).toBe("42");
  });

  it("an empty-state sync (non-connected / locked origin) resolves [] promptly", async () => {
    const provider = await loadProvider();
    messageListener!(
      stateEnvelope(stubWindow, "https://dapp.example", {
        accounts: [],
        chainId: "0x10F2C",
      }),
    );
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("falls back to the legacy defaults after the timeout when no sync arrives (dead SW)", async () => {
    vi.useFakeTimers();
    try {
      const provider = await loadProvider();
      const accounts = provider.request({ method: "eth_accounts" });
      const chainId = provider.request({ method: "eth_chainId" });
      await vi.advanceTimersByTimeAsync(250);
      expect(await accounts).toEqual([]);
      expect(await chainId).toBe("0x10F2C");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a forged state envelope (wrong source window) — F-2.1 posture holds", async () => {
    vi.useFakeTimers();
    try {
      const provider = await loadProvider();
      messageListener!(
        stateEnvelope({}, "https://dapp.example", {
          accounts: ["0xevil0000000000000000000000000000000000ee"],
          chainId: "0x1",
        }),
      );
      const accounts = provider.request({ method: "eth_accounts" });
      await vi.advanceTimersByTimeAsync(250);
      expect(await accounts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pushed event outranks a later-arriving sync (race: event won)", async () => {
    const provider = await loadProvider();
    messageListener!(accountsEvent(stubWindow, "https://dapp.example"));
    messageListener!(
      stateEnvelope(stubWindow, "https://dapp.example", {
        accounts: [],
        chainId: "0x10F2C",
      }),
    );
    expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDR]);
  });

  it("rejects malformed synced shapes (non-string accounts / non-hex chainId)", async () => {
    vi.useFakeTimers();
    try {
      const provider = await loadProvider();
      messageListener!(
        stateEnvelope(stubWindow, "https://dapp.example", {
          accounts: [42],
          chainId: "not-hex",
        }),
      );
      // Malformed fields are dropped; the gate still settles (channel alive),
      // so the arms answer the fallbacks without waiting for the timeout.
      expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
      expect(await provider.request({ method: "eth_chainId" })).toBe("0x10F2C");
    } finally {
      vi.useRealTimers();
    }
  });
});

// CodeQL js/cross-window-information-leak — the provider's request envelope to the
// bridge must target the page origin, never "*".
describe("outbound request post targets the page origin (not '*')", () => {
  it("posts the page->bridge request envelope with the page origin as targetOrigin", async () => {
    const provider = await loadProvider();
    const spy = stubWindow.postMessage as ReturnType<typeof vi.fn>;
    const before = spy.mock.calls.length;
    // A method not answered locally routes through send() -> window.postMessage.
    // The promise stays pending (no bridge reply in the stub); we only inspect
    // the synchronous outbound post.
    void provider.request({ method: "eth_blockNumber" }).catch(() => {});
    const reqCall = spy.mock.calls
      .slice(before)
      .find((c: unknown[]) => (c[0] as { source?: string })?.source === "monolythium-wallet-page");
    expect(reqCall).toBeTruthy();
    expect(reqCall![1]).toBe("https://dapp.example");
    expect(reqCall![1]).not.toBe("*");
  });
});
