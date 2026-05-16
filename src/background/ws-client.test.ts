// Phase 11 Commit 2 — WS-client tests.
//
// The WsClient is a lifecycle manager over an injected WebSocket
// factory. Tests use a fake WebSocket implementation that records all
// outbound messages and exposes hooks for simulating server events.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WsClient,
  __resetWsClient,
  getWsClient,
  httpUrlToWss,
} from "./ws-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebSocket + getActiveOperators mock
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("./networks.js", () => ({
  getActiveOperators: vi.fn(() => [
    { name: "op-1", region: "lon", rpc: "https://op-1.example.com/rpc" },
  ]),
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
  WsClient.factory = (url) => new FakeWebSocket(url) as unknown as WebSocket;
});

afterEach(() => {
  __resetWsClient();
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
