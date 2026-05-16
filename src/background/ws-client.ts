// Phase 11 Commit 2 — WebSocket subscription manager.
//
// Chain commit 0aaa5fc shipped `lyth_subscribe` / `lyth_unsubscribe`
// over WebSocket transport. The SDK at @0fd8a79 exposes
// `RpcClient.lythSubscribe` but documents it as "WebSocket-only;
// returns an RPC error over HTTP" — i.e. the SDK doesn't itself manage
// a WS transport. The wallet maintains its own WS layer.
//
// Design constraints (MV3 service worker):
//   1. The SW can be terminated by the browser after ~30 s idle. A
//      live WS connection is one of the few things that keeps the SW
//      alive, so the WS handle is a proxy for SW liveness — when WS
//      drops, the SW often dies with it.
//   2. Reconnect must be exponential-backoff: a tight reconnect loop
//      against a dead operator burns battery and never recovers.
//   3. Subscription multiplexing: every popup screen that wants
//      real-time data routes through one shared WS connection — we
//      can't afford a per-screen WS handle (Chrome limits parallel
//      WS connections and the auth costs add up).
//   4. Graceful degradation: when no WS endpoint is reachable, the
//      manager surfaces "ws unavailable" to callers, who fall back
//      to their existing polling path. This is the dominant case
//      pre-mainnet when Sprintnet operators may not all expose wss://.
//
// API:
//   - `getWsClient()` returns the singleton client (lazy).
//   - `client.subscribe(channel, callback)` returns an unsubscribe
//     handle. Multiple subscribers to the same channel share one
//     server-side subscription; the manager fans out events.
//   - `client.status` reports "disconnected" | "connecting" |
//     "connected" | "unavailable" so callers can pick polling fallback.
//
// Whitepaper alignment: §10 (the autonomous-economy positioning means
// users expect real-time settlement signals; balance updates within a
// block of arrival, not "next time the popup opens"). §20.1 specifies
// 3 s deterministic finality — so a WS subscription seeing one new
// head every 3 s is the upper bound on signal velocity.

import { getActiveOperators } from "./networks.js";

/** Public connection status surfaced to callers. */
export type WsStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "unavailable";

/** Callback invoked with the raw `params.result` of every subscription
 *  message. Callers parse the shape; the manager doesn't enforce a
 *  channel-specific contract. */
export type WsCallback = (params: unknown) => void;

interface PendingSubscription {
  channel: string;
  /** All callbacks waiting for this channel's confirmation. */
  callbacks: Set<WsCallback>;
  /** Server-assigned subscription id once the `lyth_subscribe`
   *  acknowledgement lands. */
  subscriptionId: string | null;
  /** RPC id used to correlate the ack. */
  rpcId: number;
}

/** Convert an HTTP/HTTPS operator RPC URL into a wss:// URL. */
export function httpUrlToWss(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  // Already a WS URL or relative path — passthrough.
  return url;
}

/** Backoff schedule for reconnect. Doubles up to 60 s ceiling. */
function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * Math.pow(2, attempt));
}

/** WS connection manager. Singleton — `getWsClient()` is the only entry
 *  point. Tests inject their own factory by calling `setWsFactory()`
 *  before any `subscribe()` call. */
export class WsClient {
  private ws: WebSocket | null = null;
  private currentStatus: WsStatus = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** RPC id allocator for outbound subscribe/unsubscribe. */
  private nextRpcId = 1;
  /** Channel → in-flight subscription state. */
  private subscriptions = new Map<string, PendingSubscription>();
  /** Server-assigned subscriptionId → channel, for inbound message routing. */
  private subscriptionIdToChannel = new Map<string, string>();
  /** Status-change listeners. */
  private statusListeners = new Set<(s: WsStatus) => void>();

  /** Override the factory in tests. Production uses the global
   *  `WebSocket` constructor. */
  static factory: (url: string) => WebSocket =
    typeof WebSocket !== "undefined"
      ? (url) => new WebSocket(url)
      : () => {
          throw new Error("WebSocket unavailable in this environment");
        };

  get status(): WsStatus {
    return this.currentStatus;
  }

  /** Subscribe a callback to a channel. Returns an `unsubscribe` thunk.
   *  When multiple callbacks subscribe to the same channel, the manager
   *  reuses one server-side subscription; unsubscribing only tears down
   *  the server-side subscription when the last callback drops. */
  subscribe(channel: string, cb: WsCallback): () => void {
    let entry = this.subscriptions.get(channel);
    if (!entry) {
      entry = {
        channel,
        callbacks: new Set(),
        subscriptionId: null,
        rpcId: this.nextRpcId++,
      };
      this.subscriptions.set(channel, entry);
      // Lazily open the connection on first subscription.
      this.ensureConnection();
      this.sendSubscribe(entry);
    }
    entry.callbacks.add(cb);

    return () => {
      const e = this.subscriptions.get(channel);
      if (!e) return;
      e.callbacks.delete(cb);
      if (e.callbacks.size === 0) {
        this.subscriptions.delete(channel);
        if (e.subscriptionId !== null) {
          this.subscriptionIdToChannel.delete(e.subscriptionId);
          this.sendUnsubscribe(e.subscriptionId);
        }
      }
    };
  }

  /** Add a status-change listener (e.g. so the popup can switch between
   *  WS-driven updates and polling). Returns a remove thunk. */
  onStatus(listener: (s: WsStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Tear down the connection and clear all subscriptions. Used by tests
   *  and by the SW's `chrome.runtime.onSuspend` hook so a fresh SW boot
   *  starts clean. */
  shutdown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.subscriptions.clear();
    this.subscriptionIdToChannel.clear();
    this.setStatus("disconnected");
  }

  private setStatus(next: WsStatus): void {
    if (next === this.currentStatus) return;
    this.currentStatus = next;
    for (const l of this.statusListeners) {
      try {
        l(next);
      } catch {
        // listener errors don't tear down the client
      }
    }
  }

  private ensureConnection(): void {
    if (this.ws !== null) return;
    const ops = getActiveOperators();
    if (ops.length === 0) {
      this.setStatus("unavailable");
      return;
    }
    // Use the first operator. Per-operator failover for WS is more
    // complex than HTTP (a WS session is stateful — failover means
    // re-subscribing every channel). v1 picks the first operator and
    // reconnects on drop; multi-operator WS failover is post-mainnet.
    const wsUrl = httpUrlToWss(ops[0]!.rpc);
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = WsClient.factory(wsUrl);
    } catch (e) {
      console.warn("[ws-client] factory threw:", (e as Error).message);
      // Factory failure (no WebSocket in environment) is permanent
      // until the environment changes. Don't schedule a reconnect — the
      // next subscribe call from a caller will re-trigger ensureConnection
      // if conditions changed. setStatus("unavailable") is sticky.
      this.setStatus("unavailable");
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onerror = () => this.onError();
    ws.onclose = () => this.onClose();
  }

  private onOpen(): void {
    this.reconnectAttempts = 0;
    this.setStatus("connected");
    // Re-send every pending subscription so reconnect doesn't lose
    // listeners. The server doesn't remember the subscriptions from
    // the previous connection.
    for (const entry of this.subscriptions.values()) {
      entry.subscriptionId = null;
      this.sendSubscribe(entry);
    }
  }

  private onMessage(ev: MessageEvent): void {
    let parsed: {
      id?: number;
      result?: unknown;
      method?: string;
      params?: { subscription?: string; result?: unknown };
      error?: { code?: number; message?: string };
    };
    try {
      parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    // Subscription event: `{ method: "lyth_subscription", params: { subscription, result } }`
    if (parsed.method === "lyth_subscription" && parsed.params) {
      const subId = parsed.params.subscription;
      if (typeof subId !== "string") return;
      const channel = this.subscriptionIdToChannel.get(subId);
      if (!channel) return;
      const entry = this.subscriptions.get(channel);
      if (!entry) return;
      for (const cb of entry.callbacks) {
        try {
          cb(parsed.params.result);
        } catch {
          // a subscriber's throw doesn't tear down the manager
        }
      }
      return;
    }
    // Subscribe ack: correlate by rpc id.
    if (typeof parsed.id === "number" && typeof parsed.result === "string") {
      for (const entry of this.subscriptions.values()) {
        if (entry.rpcId === parsed.id) {
          entry.subscriptionId = parsed.result;
          this.subscriptionIdToChannel.set(parsed.result, entry.channel);
          return;
        }
      }
    }
  }

  private onError(): void {
    // The browser also fires onclose for us; just record the status.
    this.setStatus("disconnected");
  }

  private onClose(): void {
    this.ws = null;
    // Clear server-assigned ids; the next reconnect will reissue
    // subscribe requests.
    for (const entry of this.subscriptions.values()) {
      if (entry.subscriptionId !== null) {
        this.subscriptionIdToChannel.delete(entry.subscriptionId);
        entry.subscriptionId = null;
      }
    }
    if (this.subscriptions.size > 0) {
      this.scheduleReconnect();
    } else {
      this.setStatus("disconnected");
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = backoffMs(this.reconnectAttempts);
    this.reconnectAttempts++;
    // After 6 consecutive failures (~63 s of accumulated delay) surface
    // "unavailable" so callers can drop to polling without waiting for
    // a recovery that may never come.
    if (this.reconnectAttempts >= 6) {
      this.setStatus("unavailable");
    } else {
      this.setStatus("disconnected");
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, delay);
  }

  private sendSubscribe(entry: PendingSubscription): void {
    if (this.ws === null || this.ws.readyState !== 1 /* OPEN */) return;
    const req = {
      jsonrpc: "2.0",
      id: entry.rpcId,
      method: "lyth_subscribe",
      params: [entry.channel],
    };
    try {
      this.ws.send(JSON.stringify(req));
    } catch {
      // a failed send will trigger onclose; reconnect will retry.
    }
  }

  private sendUnsubscribe(subscriptionId: string): void {
    if (this.ws === null || this.ws.readyState !== 1) return;
    const req = {
      jsonrpc: "2.0",
      id: this.nextRpcId++,
      method: "lyth_unsubscribe",
      params: [subscriptionId],
    };
    try {
      this.ws.send(JSON.stringify(req));
    } catch {
      // ignore
    }
  }
}

let _singleton: WsClient | null = null;

/** Lazy-singleton accessor. Tests can call `__resetWsClient()` between
 *  cases to start fresh. */
export function getWsClient(): WsClient {
  if (_singleton === null) _singleton = new WsClient();
  return _singleton;
}

/** Test seam — drop the singleton so the next `getWsClient()` returns a
 *  fresh instance. */
export function __resetWsClient(): void {
  if (_singleton !== null) _singleton.shutdown();
  _singleton = null;
}
