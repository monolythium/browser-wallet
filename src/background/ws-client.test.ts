// WS-client tests.
//
// The WsClient is a lifecycle manager over an injected WebSocket
// factory. Tests use a fake WebSocket implementation that records all
// outbound messages and exposes hooks for simulating server events.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WsClient,
  WS_FAILURE_TTL_MS,
  __resetWsClient,
  __resetWsFailureCache,
  deriveWsUrl,
  getWsClient,
  httpUrlToWss,
  isWellFormedBlockNumberHex,
  isWsKnownDown,
  markWsDown,
} from "./ws-client.js";
import { snapshotGenesisCache, verifyOperatorGenesis } from "./networks.js";
import type { OperatorEntry } from "../shared/operators.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebSocket + getActiveOperators mock
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("./networks.js", () => ({
  getActiveOperators: vi.fn(() => [
    { name: "op-1", region: "lon", rpc: "https://op-1.example.com/rpc" },
  ]),
  // F-2.4/#21 genesis gate. Default: op-1 is genesis-trusted in the cache, so
  // the synchronous WS connect path proceeds for the existing tests.
  snapshotGenesisCache: vi.fn(
    () =>
      new Map([
        [
          "https://op-1.example.com/rpc",
          { ok: true, observed: "0xabc", checkedAt: 0 },
        ],
      ]),
  ),
  verifyOperatorGenesis: vi.fn(async () => true),
}));

class FakeWebSocket {
  readonly url: string;
  readyState: number = 0; // 0 = CONNECTING, 1 = OPEN
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // The factory injects this into the singleton so tests can drive
    // open/close/message via the lastInstance ref below.
    FakeWebSocket.lastInstance = this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  static lastInstance: FakeWebSocket | null = null;
  static resetSingleton(): void {
    FakeWebSocket.lastInstance = null;
  }
}

beforeEach(() => {
  FakeWebSocket.resetSingleton();
  __resetWsClient();
  // The module-scoped failure cache leaks state
  // across tests if not reset. A prior test that exercised handshake
  // failure would mark the URL down + the next test's ensureConnection
  // would short-circuit to "unavailable" without ever creating a WS.
  __resetWsFailureCache();
  WsClient.factory = (url) => new FakeWebSocket(url) as unknown as WebSocket;
});

afterEach(() => {
  __resetWsClient();
  __resetWsFailureCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("httpUrlToWss", () => {
  it("upgrades https → wss", () => {
    expect(httpUrlToWss("https://op.example.com/rpc")).toBe(
      "wss://op.example.com/rpc",
    );
  });
  it("upgrades http → ws", () => {
    expect(httpUrlToWss("http://op.example.com/rpc")).toBe(
      "ws://op.example.com/rpc",
    );
  });
  it("passes through wss:// untouched", () => {
    expect(httpUrlToWss("wss://op.example.com/rpc")).toBe(
      "wss://op.example.com/rpc",
    );
  });
});

describe("isWellFormedBlockNumberHex (F-2.4/#21 pushed-payload shape gate)", () => {
  // The SW newHeads subscriber writes the latest-block banner IFF this returns
  // true, so these cases map directly to write (true) vs drop (false).
  it("accepts a well-formed 0x block hex — these UPDATE the banner", () => {
    for (const v of [
      "0x0",
      "0x1",
      "0x1a2b3c",
      "0xdeadbeef",
      "0xffffffffffffffff", // u64 max — 16 hex digits
    ]) {
      expect(isWellFormedBlockNumberHex(v)).toBe(true);
    }
  });

  it("rejects malformed/garbage pushes — these are DROPPED, banner unchanged", () => {
    for (const v of [
      null,
      undefined,
      42,
      {},
      { number: "0x1" }, // the wrapper object, not the extracted height
      "0x", // no digits
      "0xG1", // non-hex digit
      "1a2b", // missing 0x prefix
      "0x" + "f".repeat(17), // oversized — wider than a u64 height
      "garbage",
      "",
    ]) {
      expect(isWellFormedBlockNumberHex(v)).toBe(false);
    }
  });
});

describe("WsClient genesis gate (F-2.4/#21)", () => {
  it("connects when the genesis cache marks the operator trusted", () => {
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    expect(FakeWebSocket.lastInstance).not.toBeNull();
    expect(FakeWebSocket.lastInstance!.url).toBe("wss://op-1.example.com/rpc");
    expect(client.status).toBe("connecting");
  });

  it("refuses to connect when no operator is genesis-trusted (HTTP poll stays source of truth)", () => {
    // Cache reports NO trusted operator, and the cold-cache warm probe also
    // finds none — the WS connect must be refused.
    vi.mocked(snapshotGenesisCache).mockReturnValueOnce(new Map());
    vi.mocked(verifyOperatorGenesis).mockResolvedValueOnce(false);
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    // No WS opened; the banner reflects "unavailable" — not an error, since the
    // genesis-gated HTTP poll remains authoritative.
    expect(FakeWebSocket.lastInstance).toBeNull();
    expect(client.status).toBe("unavailable");
  });
});

describe("WsClient.subscribe", () => {
  it("opens a connection on first subscribe and sends lyth_subscribe over the wire", () => {
    const client = getWsClient();
    const cb = vi.fn();
    client.subscribe("newHeads", cb);
    expect(FakeWebSocket.lastInstance).not.toBeNull();
    const fake = FakeWebSocket.lastInstance!;
    expect(fake.url).toBe("wss://op-1.example.com/rpc");
    // Subscribe ack hasn't happened — but the request can't be sent
    // until readyState is OPEN. Simulate open:
    fake.readyState = 1;
    fake.onopen?.();
    expect(fake.sent.length).toBe(1);
    const parsed = JSON.parse(fake.sent[0]!);
    expect(parsed.method).toBe("lyth_subscribe");
    expect(parsed.params).toEqual(["newHeads"]);
    expect(client.status).toBe("connected");
  });

  it("multiplexes multiple subscribers to one channel onto a single server subscription", () => {
    const client = getWsClient();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    client.subscribe("newHeads", cb1);
    client.subscribe("newHeads", cb2);
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    // Only the first subscribe should have hit the wire.
    expect(fake.sent.length).toBe(1);
  });

  it("fans subscription events out to every callback on the channel", () => {
    const client = getWsClient();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    client.subscribe("newHeads", cb1);
    client.subscribe("newHeads", cb2);
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    // Server ack assigning subscription id.
    const ackPayload = JSON.parse(fake.sent[0]!);
    fake.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: ackPayload.id, result: "sub-0x42" }),
    } as MessageEvent);
    // Now an event:
    fake.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "lyth_subscription",
        params: { subscription: "sub-0x42", result: { number: "0x100" } },
      }),
    } as MessageEvent);
    expect(cb1).toHaveBeenCalledWith({ number: "0x100" });
    expect(cb2).toHaveBeenCalledWith({ number: "0x100" });
  });

  it("unsubscribe with last callback sends lyth_unsubscribe", () => {
    const client = getWsClient();
    const cb = vi.fn();
    const off = client.subscribe("newHeads", cb);
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    const ackPayload = JSON.parse(fake.sent[0]!);
    fake.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: ackPayload.id, result: "sub-0x42" }),
    } as MessageEvent);
    off();
    // Last sent should be lyth_unsubscribe with the assigned id.
    const last = JSON.parse(fake.sent[fake.sent.length - 1]!);
    expect(last.method).toBe("lyth_unsubscribe");
    expect(last.params).toEqual(["sub-0x42"]);
  });

  it("does not unsubscribe server-side while other callbacks remain", () => {
    const client = getWsClient();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const off1 = client.subscribe("newHeads", cb1);
    client.subscribe("newHeads", cb2);
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    const sentBefore = fake.sent.length;
    off1();
    // No new outbound payload — cb2 is still alive.
    expect(fake.sent.length).toBe(sentBefore);
  });
});

describe("WsClient status + reconnect", () => {
  it("status flips to disconnected on close", () => {
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    expect(client.status).toBe("connected");
    fake.onclose?.();
    expect(client.status).toBe("disconnected");
  });

  it("status flips to unavailable after 6 consecutive failed reconnect attempts", async () => {
    vi.useFakeTimers();
    try {
      const client = getWsClient();
      client.subscribe("newHeads", vi.fn());
      // Simulate the WS never reaching `onopen` — each reconnect attempt
      // ends in `onclose` before the connection stabilises. onOpen would
      // reset reconnectAttempts to 0 (signalling a healthy connection),
      // so a real "permanently failing" backend never calls onopen.
      //
      // After 6 close events the manager surfaces "unavailable" so
      // callers can drop to polling. Each iteration: close → status
      // updates → advance timer to fire the reconnect → new WS created.
      // We check the status AFTER the close (before the next timer
      // advance) to see the manager's terminal verdict, not the
      // transient "connecting" state of the next reconnect attempt.
      for (let i = 0; i < 6; i++) {
        const fake = FakeWebSocket.lastInstance!;
        fake.onclose?.();
        // Advance the backoff timer so the next reconnect fires.
        await vi.advanceTimersByTimeAsync(120_000);
      }
      // Final close — sixth call to scheduleReconnect bumps attempts
      // to 6 and flips status to "unavailable" without advancing the
      // timer (so the next reconnect doesn't immediately overwrite it).
      const fake = FakeWebSocket.lastInstance!;
      fake.onclose?.();
      expect(client.status).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("onStatus listener fires immediately with current status", () => {
    const client = getWsClient();
    const listener = vi.fn();
    client.onStatus(listener);
    expect(listener).toHaveBeenCalledWith("disconnected");
  });

  it("onStatus listener fires on status changes", () => {
    const client = getWsClient();
    const listener = vi.fn();
    client.onStatus(listener);
    client.subscribe("newHeads", vi.fn());
    expect(listener).toHaveBeenCalledWith("connecting");
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    expect(listener).toHaveBeenCalledWith("connected");
  });

  it("shutdown clears subscriptions and disconnects", () => {
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    const fake = FakeWebSocket.lastInstance!;
    fake.readyState = 1;
    fake.onopen?.();
    expect(client.status).toBe("connected");
    client.shutdown();
    expect(client.status).toBe("disconnected");
  });
});

describe("WsClient reconnect re-subscribes", () => {
  it("re-sends every pending subscription after a reconnect", async () => {
    vi.useFakeTimers();
    try {
      const client = getWsClient();
      client.subscribe("newHeads", vi.fn());
      client.subscribe("logs", vi.fn());
      const first = FakeWebSocket.lastInstance!;
      first.readyState = 1;
      first.onopen?.();
      expect(first.sent.length).toBe(2);
      // Drop the connection.
      first.onclose?.();
      // Backoff timer fires — a new WS opens.
      await vi.advanceTimersByTimeAsync(2000);
      const second = FakeWebSocket.lastInstance!;
      expect(second).not.toBe(first);
      second.readyState = 1;
      second.onopen?.();
      // Both subscriptions reissued on the new connection.
      expect(second.sent.length).toBe(2);
      const methods = second.sent.map((s) => JSON.parse(s).params[0]);
      expect(methods.sort()).toEqual(["logs", "newHeads"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WsClient factory unavailable", () => {
  it("flips to unavailable when factory throws (no WebSocket in environment)", () => {
    WsClient.factory = () => {
      throw new Error("WebSocket unavailable");
    };
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    expect(client.status).toBe("unavailable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveWsUrl
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveWsUrl — operator-aware URL derivation", () => {
  const baseOp = (overrides: Partial<OperatorEntry> = {}): OperatorEntry => ({
    name: "op",
    region: "lon",
    rpc: "http://host.example.com:8545",
    ...overrides,
  });

  it("uses wsRpc override verbatim when provided", () => {
    const op = baseOp({ wsRpc: "wss://custom.example.com:9000/ws" });
    expect(deriveWsUrl(op)).toBe("wss://custom.example.com:9000/ws");
  });

  it("bumps :8545 → :8546 by default (Geth/Erigon convention)", () => {
    // The original user-reported bug: http://host:8545 → ws://host:8545
    // returned 303 because Geth serves WS on a different port.
    const op = baseOp({ rpc: "http://192.0.2.1:8545" });
    expect(deriveWsUrl(op)).toBe("ws://192.0.2.1:8546");
  });

  it("bumps :8545 → :8546 with https → wss", () => {
    const op = baseOp({ rpc: "https://host.example.com:8545" });
    expect(deriveWsUrl(op)).toBe("wss://host.example.com:8546");
  });

  it("preserves path + query when bumping ports", () => {
    const op = baseOp({ rpc: "http://host:8545/rpc?key=abc" });
    expect(deriveWsUrl(op)).toBe("ws://host:8546/rpc?key=abc");
  });

  it("strips the root '/' path (so url ends cleanly)", () => {
    const op = baseOp({ rpc: "http://host:8545/" });
    expect(deriveWsUrl(op)).toBe("ws://host:8546");
  });

  it("falls back to same-port conversion for non-8545 ports", () => {
    const op = baseOp({ rpc: "http://host:1234" });
    expect(deriveWsUrl(op)).toBe("ws://host:1234");
  });

  it("falls back to same-port for default-port (no explicit port)", () => {
    // Port omitted (implicit 443) — not 8545, so no bump.
    const op = baseOp({ rpc: "https://host.example.com/rpc" });
    expect(deriveWsUrl(op)).toBe("wss://host.example.com/rpc");
  });

  it("treats empty wsRpc string as 'not set' (uses auto-derive)", () => {
    const op = baseOp({ wsRpc: "", rpc: "http://host:8545" });
    expect(deriveWsUrl(op)).toBe("ws://host:8546");
  });

  it("falls back to naive conversion on malformed rpc URL", () => {
    const op = baseOp({ rpc: "not-a-url" });
    // Doesn't throw; passes through httpUrlToWss which just preserves.
    expect(deriveWsUrl(op)).toBe("not-a-url");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// failure cache
// ─────────────────────────────────────────────────────────────────────────────

describe("WS failure cache (per-URL TTL)", () => {
  it("isWsKnownDown returns false before marking", () => {
    expect(isWsKnownDown("ws://example.com:8546")).toBe(false);
  });

  it("isWsKnownDown returns true within TTL after markWsDown", () => {
    markWsDown("ws://example.com:8546");
    expect(isWsKnownDown("ws://example.com:8546")).toBe(true);
  });

  it("isWsKnownDown returns false after TTL expires", () => {
    vi.useFakeTimers();
    try {
      markWsDown("ws://example.com:8546");
      expect(isWsKnownDown("ws://example.com:8546")).toBe(true);
      // Advance past the TTL window.
      vi.advanceTimersByTime(WS_FAILURE_TTL_MS + 1000);
      expect(isWsKnownDown("ws://example.com:8546")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-URL isolation — marking one URL does not affect another", () => {
    markWsDown("ws://example.com:8546");
    expect(isWsKnownDown("ws://example.com:8546")).toBe(true);
    expect(isWsKnownDown("ws://other.example.com:8546")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handshake-failure tighter retry budget
// ─────────────────────────────────────────────────────────────────────────────

describe("WsClient handshake-failure retry budget", () => {
  it("after MAX_HANDSHAKE_ATTEMPTS without onopen, marks URL down + flips to unavailable", async () => {
    vi.useFakeTimers();
    try {
      const client = getWsClient();
      client.subscribe("newHeads", vi.fn());
      // Simulate the WS never opening — onclose fires repeatedly.
      // The expected sequence with MAX_HANDSHAKE_ATTEMPTS=2:
      //  - 1st close (attempts 0→1): allow ONE retry, schedule reconnect
      //  - 2nd close (attempts 1→2): exhausts budget, marks URL down,
      //                              flips to "unavailable"
      const first = FakeWebSocket.lastInstance!;
      first.onclose?.();
      // Advance timer so the scheduled reconnect fires.
      await vi.advanceTimersByTimeAsync(120_000);
      const second = FakeWebSocket.lastInstance!;
      expect(second).not.toBe(first);
      second.onclose?.();
      // No more reconnect — status is "unavailable" + URL is cached down.
      expect(client.status).toBe("unavailable");
      // Verify URL is in the failure cache (deriveWsUrl(https://op-1...) →
      // wss://op-1.example.com/rpc per the test mock's default port).
      expect(isWsKnownDown("wss://op-1.example.com/rpc")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subsequent ensureConnection short-circuits to unavailable for cached-down URLs", () => {
    // Pre-poison the failure cache for the URL the test mock yields.
    markWsDown("wss://op-1.example.com/rpc");
    const client = getWsClient();
    client.subscribe("newHeads", vi.fn());
    // No FakeWebSocket should be created; we never attempted the connection.
    expect(FakeWebSocket.lastInstance).toBeNull();
    expect(client.status).toBe("unavailable");
  });

  it("post-open close uses the permissive reconnect budget (not handshake-fail path)", async () => {
    vi.useFakeTimers();
    try {
      const client = getWsClient();
      client.subscribe("newHeads", vi.fn());
      const fake = FakeWebSocket.lastInstance!;
      fake.readyState = 1;
      // onOpen fires first → openedOnce becomes true.
      fake.onopen?.();
      expect(client.status).toBe("connected");
      // Now a close — should NOT mark URL down (this is a transient
      // network drop, not a handshake failure).
      fake.onclose?.();
      expect(isWsKnownDown("wss://op-1.example.com/rpc")).toBe(false);
      // And the reconnect should be scheduled (using the permissive
      // 6-attempt budget).
      await vi.advanceTimersByTimeAsync(2000);
      const second = FakeWebSocket.lastInstance!;
      expect(second).not.toBe(fake);
    } finally {
      vi.useRealTimers();
    }
  });
});
