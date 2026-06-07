// Monolythium Wallet — EIP-1193 in-page provider.
//
// Injected into the dapp's MAIN world at document_start so dapps can detect
// `window.ethereum` synchronously. Forwards every RPC request to the
// content-script bridge (ISOLATED world) via window.postMessage. The bridge
// relays to the service worker, which holds the keystore + RPC client.
//
// This file ships zero dependencies: it must run in any page including those
// with strict CSP that bans `unsafe-eval`. Keep it small.

interface RequestArgs {
  method: string;
  params?: unknown[] | object;
}

type EventHandler = (...args: unknown[]) => void;

interface OutboundEnvelope {
  source: "monolythium-wallet-page";
  id: string;
  args: RequestArgs;
}

interface InboundEnvelope {
  source: "monolythium-wallet-bridge";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface InboundEvent {
  source: "monolythium-wallet-bridge";
  event: "accountsChanged" | "chainChanged" | "connect" | "disconnect";
  payload: unknown;
}

// Methods the chain retired in mono-core b2f0c498 (EVM mutation,
// simulation, and the six polling-filter methods). Note that
// eth_sendRawTransaction is also retired by the chain but kept in
// the service-worker dispatcher as a wallet-policy rejection — the
// provider lets it through and the SW returns the historical 4200.
const RETIRED_METHODS: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_estimateGas",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_uninstallFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
]);

class MonolythiumProvider {
  // ---- EIP-1193 identity hints (also used by EIP-6963 below) ----
  readonly isMonolythium = true;
  // Set true so wallet detection libs that gate on isMetaMask still see us as
  // an injected provider. We expose isMonolythium as the source-of-truth flag.
  readonly isMetaMask = false;

  private listeners = new Map<string, Set<EventHandler>>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  // Locally cached state — updated by the bridge when the user picks a
  // different account or network in the popup. The default reflects the
  // LythiumDAG-BFT testnet chain id from Whitepaper §13; the bridge will overwrite
  // this on `chainChanged` if the user is on a different chain.
  private cachedAccounts: string[] = [];
  private cachedChainId: string = "0x10F2C"; // LythiumDAG-BFT testnet (69420)

  constructor() {
    window.addEventListener("message", (ev) => this.handleMessage(ev));
  }

  // ---- Public EIP-1193 surface ----

  async request(args: RequestArgs): Promise<unknown> {
    if (!args || typeof args.method !== "string") {
      throw this.rpcError(-32600, "Invalid request");
    }

    // Some methods can be answered locally for snappier UX (still authoritative
    // because the bridge pushes updates).
    if (args.method === "eth_chainId") return this.cachedChainId;
    if (args.method === "eth_accounts") return this.cachedAccounts;
    if (args.method === "net_version") return String(parseInt(this.cachedChainId, 16));

    // Methods retired by mono-core b2f0c498 (v4.1 §22.9 — no EVM
    // simulation / polling-filters on Monolythium). Reject at the
    // provider boundary with EIP-1193 code 4200 so dapps get a clear,
    // synchronous answer without a chain round-trip. The service
    // worker carries the same rejection arms as a defense-in-depth
    // backstop for callers that bypass this provider.
    if (RETIRED_METHODS.has(args.method)) {
      throw this.rpcError(
        4200,
        `${args.method} is unavailable on Monolythium — the chain retired EVM simulation and polling-filter methods. Use native reads or submit via the wallet UI.`,
      );
    }

    return this.send(args);
  }

  on(event: string, handler: EventHandler): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }

  removeListener(event: string, handler: EventHandler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  // ---- Internal ----

  private send(args: RequestArgs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2));
      this.pending.set(id, { resolve, reject });
      const msg: OutboundEnvelope = {
        source: "monolythium-wallet-page",
        id,
        args,
      };
      window.postMessage(msg, "*");
    });
  }

  private handleMessage(ev: MessageEvent) {
    // Only accept messages from THIS window and THIS origin. The ISOLATED-world
    // bridge shares the page window and posts replies/events back here, so
    // legitimate bridge->provider traffic has ev.source === window and
    // ev.origin === this page's origin. Reject anything from another frame /
    // context / origin so a co-resident or cross-frame script cannot resolve a
    // pending request or inject accountsChanged/chainChanged (F-2.1). Additive:
    // the source-string check below still runs.
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    const data = ev.data as InboundEnvelope | InboundEvent | undefined;
    if (!data || data.source !== "monolythium-wallet-bridge") return;

    if ("event" in data) {
      this.handleEvent(data);
      return;
    }

    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.error) {
      pending.reject(this.rpcError(data.error.code, data.error.message));
    } else {
      pending.resolve(data.result);
    }
  }

  private handleEvent(ev: InboundEvent) {
    if (ev.event === "accountsChanged" && Array.isArray(ev.payload)) {
      this.cachedAccounts = ev.payload as string[];
    }
    if (ev.event === "chainChanged" && typeof ev.payload === "string") {
      this.cachedChainId = ev.payload;
    }
    const listeners = this.listeners.get(ev.event);
    if (!listeners) return;
    for (const h of listeners) {
      try {
        h(ev.payload);
      } catch (e) {
        console.error("[Monolythium Wallet] listener threw", e);
      }
    }
  }

  private rpcError(code: number, message: string): Error & { code: number } {
    const e = new Error(message) as Error & { code: number };
    e.code = code;
    return e;
  }
}

// Inject into the dapp's window. We attach to `window.ethereum` (the legacy
// well-known name) and also publish ourselves over EIP-6963 so coexistence
// with other injected wallets works.
const provider = new MonolythiumProvider();

const w = window as Window & {
  ethereum?: MonolythiumProvider;
  monolythium?: MonolythiumProvider;
};

// Don't clobber an existing wallet — let the user choose via EIP-6963.
if (!w.ethereum) {
  try {
    Object.defineProperty(w, "ethereum", {
      value: provider,
      configurable: false,
      writable: false,
    });
  } catch {
    w.ethereum = provider;
  }
}
w.monolythium = provider;

// EIP-6963: announce provider so multi-wallet UIs can list us alongside others.
const announce = () => {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: {
          uuid: "f1c0e8a4-5a2f-4d2a-9e36-9f0a5e8a1b40",
          name: "Monolythium Wallet",
          icon: "data:image/svg+xml;utf8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%2F%3E",
          rdns: "xyz.monolythium.wallet",
        },
        provider,
      }),
    }),
  );
};

window.addEventListener("eip6963:requestProvider", announce);
announce();

// This content script is bundled as an ES module by @crxjs; the explicit export
// keeps it a TS module (so it can be dynamically imported by its test).
export {};

