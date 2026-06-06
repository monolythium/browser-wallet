// WebSocket subscription manager.
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
//      pre-mainnet when the testnet operators may not all expose wss://.
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
import type { OperatorEntry } from "../shared/operators.js";

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

/** Convert an HTTP/HTTPS operator RPC URL into a wss:// URL. Naive
 *  same-port conversion. Kept for callers that just want the protocol
 *  swap without operator-aware logic; new code should prefer
 *  `deriveWsUrl(operator)` which knows about :8546 + the wsRpc override. */
export function httpUrlToWss(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  // Already a WS URL or relative path — passthrough.
  return url;
}

/** Operator-aware WS URL derivation.
 *
 *  Precedence:
 *    1. `operator.wsRpc` explicit override (set by SDK registry or
 *       user-supplied override list)
 *    2. Geth/Erigon convention: if HTTP is on port 8545, WS is on 8546
 *    3. Fall back to same-port http→ws conversion (legacy behaviour)
 *
 *  The :8546 default fixes the HTTP 303 handshake-failure spam reported
 *  by user against the testnet op-1 (8545 returns redirect for upgrade).
 */
export function deriveWsUrl(operator: OperatorEntry): string {
  if (operator.wsRpc !== undefined && operator.wsRpc.length > 0) {
    return operator.wsRpc;
  }
  let url: URL;
  try {
    url = new URL(operator.rpc);
  } catch {
    // Malformed rpc — fall back to naive conversion (preserves prior
    // behaviour rather than throwing).
    return httpUrlToWss(operator.rpc);
  }
  const isHttps = url.protocol === "https:";
  const wsProtocol = isHttps ? "wss:" : "ws:";
  // Standard Ethereum RPC: HTTP on 8545, WS on 8546. Apply the bump
  // whether port is the literal "8545" or empty + default scheme port.
  if (url.port === "8545") {
    const pathSuffix = url.pathname === "/" ? "" : url.pathname;
    return `${wsProtocol}//${url.hostname}:8546${pathSuffix}${url.search}`;
  }
  // Non-standard port — preserve the legacy same-port conversion.
  return httpUrlToWss(operator.rpc);
}

/** Backoff schedule for reconnect. Doubles up to 60 s ceiling. */
function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * Math.pow(2, attempt));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-URL failure cache.
//
// When a WS handshake fails (303, 404, network refusal, etc.) before
// the connection ever opens, we mark the URL as known-down for TTL
// minutes. Subsequent ensureConnection() short-circuits to
// `unavailable` status without trying again. Prevents the ~5 min of
// console retry spam reported by user against the testnet :8545 (which
// returns HTTP 303 redirect on upgrade attempts).
//
// The cache is module-scoped so it survives WsClient singleton resets
// within a SW lifetime, but resets across SW restarts (chrome may
// terminate the SW after ~30 s idle). That's correct behaviour: a SW
// restart implies enough time has passed that the operator may have
// changed.
// ─────────────────────────────────────────────────────────────────────────────

/** TTL for per-URL handshake-failure cache entries. */
export const WS_FAILURE_TTL_MS = 10 * 60 * 1000;
/** Max retry attempts when WS has never successfully opened. Differs
 *  from the post-open reconnect budget (6 attempts via scheduleReconnect)
 *  — a handshake that never works is a config issue, not a transient
 *  network blip. */
export const MAX_HANDSHAKE_ATTEMPTS = 2;

const wsFailureCache = new Map<string, number>();

/** Test seam — clear the module-scoped failure cache between cases. */
export function __resetWsFailureCache(): void {
  wsFailureCache.clear();
}

/** Returns true when `wsUrl` is in the failure cache within TTL.
 *  Mutates the cache (evicts expired entries on read) so callers don't
 *  have to. */
export function isWsKnownDown(wsUrl: string): boolean {
  const expiresAt = wsFailureCache.get(wsUrl);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    wsFailureCache.delete(wsUrl);
    return false;
  }
  return true;
}

/** Mark a WS URL as known-down. Sticky for `WS_FAILURE_TTL_MS`. */
export function markWsDown(wsUrl: string): void {
  wsFailureCache.set(wsUrl, Date.now() + WS_FAILURE_TTL_MS);
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
  /** Tracks whether the current WS connection EVER
   *  fired `onopen`. A close without a preceding open means the handshake
   *  failed (303 redirect, 404, etc.) — we apply MAX_HANDSHAKE_ATTEMPTS
   *  before marking the URL down + falling to polling. After a successful
   *  open we use the more permissive reconnect budget. */
  private openedOnce = false;
  /** The URL the current WS connection is using. Cached so onClose can
   *  mark the right URL down when a handshake fails. */
  private currentWsUrl: string | null = null;
  /** First-occurrence guard for the console.warn on factory-throw, so
   *  repeated subscribe calls into a broken environment don't spam. */
  private factoryWarnedOnce = false;

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
    this.openedOnce = false;
    this.currentWsUrl = null;
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
    //
    // `deriveWsUrl` knows about the `wsRpc`
    // override + the :8546 Geth convention. Previously we used the
    // naive `httpUrlToWss` which kept the HTTP port, causing 303
    // handshake-failure spam against the testnet operators.
    const wsUrl = deriveWsUrl(ops[0]!);
    // Failure-cache short-circuit. If the URL is in the failure cache
    // within TTL, skip the connection attempt entirely + go straight
    // to "unavailable" so callers fall back to polling without spam.
    if (isWsKnownDown(wsUrl)) {
      this.setStatus("unavailable");
      return;
    }
    this.currentWsUrl = wsUrl;
    this.openedOnce = false;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = WsClient.factory(wsUrl);
    } catch (e) {
      // Factory failure (no WebSocket in environment) is permanent
      // until the environment changes. Don't schedule a reconnect — the
      // next subscribe call from a caller will re-trigger ensureConnection
      // if conditions changed. setStatus("unavailable") is sticky.
      // First-occurrence guard so repeated subscribe calls don't spam.
      if (!this.factoryWarnedOnce) {
        console.warn("[ws-client] factory threw:", (e as Error).message);
        this.factoryWarnedOnce = true;
      }
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
    this.openedOnce = true;
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
    // A close without a preceding open is a
    // handshake failure (the most common cause is HTTP 303 redirect or
    // 404 against a port that doesn't serve WS — e.g. Geth on :8545
    // refusing upgrades). Tighter retry budget + URL-cache poisoning so
    // we don't keep hammering an endpoint that will never work.
    const handshakeFailed = !this.openedOnce;
    const wsUrlAtFailure = this.currentWsUrl;
    // Clear server-assigned ids; the next reconnect will reissue
    // subscribe requests.
    for (const entry of this.subscriptions.values()) {
      if (entry.subscriptionId !== null) {
        this.subscriptionIdToChannel.delete(entry.subscriptionId);
        entry.subscriptionId = null;
      }
    }
    if (this.subscriptions.size === 0) {
      this.setStatus("disconnected");
      return;
    }
    if (handshakeFailed) {
      // Use the tighter MAX_HANDSHAKE_ATTEMPTS budget. After it's
      // exhausted, mark the URL down so future ensureConnection short-
      // circuits to "unavailable" for WS_FAILURE_TTL_MS.
      if (this.reconnectAttempts + 1 >= MAX_HANDSHAKE_ATTEMPTS) {
        if (wsUrlAtFailure !== null) markWsDown(wsUrlAtFailure);
        this.setStatus("unavailable");
        // Don't schedule another reconnect — caller falls back to polling.
        return;
      }
      // Allow ONE retry before giving up — covers the case where the
      // first connection raced a SW resurrection.
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = backoffMs(this.reconnectAttempts);
    this.reconnectAttempts++;
    // After 6 consecutive failures (~63 s of accumulated delay) surface
    // "unavailable" so callers can drop to polling without waiting for
    // a recovery that may never come. The handshake-failure path takes
    // the tighter MAX_HANDSHAKE_ATTEMPTS budget in onClose() instead.
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
