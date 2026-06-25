// Monolythium Wallet — content-script bridge.
//
// Runs in the ISOLATED world at document_start. Acts as the postMessage <->
// chrome.runtime.sendMessage relay between the in-page provider (MAIN world)
// and the background service worker.
//
// Why two scripts: a MAIN-world script can synchronously expose
// `window.ethereum`, but it cannot use chrome.* APIs. ISOLATED-world scripts
// can talk to the service worker but cannot patch `window.ethereum` on the
// page side. So we run one of each, joined via window.postMessage.

interface OutboundEnvelope {
  source: "monolythium-wallet-page";
  id: string;
  args: { method: string; params?: unknown[] | object };
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

// Initial provider-state sync — the SW's reply to the load-time announce,
// relayed to the MAIN-world provider so its eth_accounts/eth_chainId caches
// seed from real connection-scoped state instead of hardcoded defaults.
interface InboundState {
  source: "monolythium-wallet-bridge";
  state: { accounts?: unknown; chainId?: unknown };
}

// Announce this page's origin to the service worker the moment the bridge loads.
// This runs in the ISOLATED world at document_start — before the page's own
// scripts — so the SW learns the tab's CURRENT origin on every navigation, not
// only at the tab's next rpc. It keeps the SW's tabId->origin map fresh so
// account-carrying events (accountsChanged / connect, which carry the wallet
// address) are never delivered to a tab that has navigated away from a connected
// origin. Closes the C6 navigation-staleness residual WITHOUT the "tabs" or
// "webNavigation" permission (both add a "read your browsing history" install
// warning, unacceptable for a fund-holding extension). The announced origin is
// `window.location.origin`, stamped from the ISOLATED world (the page cannot
// forge it) and trusted exactly as the rpc-stamped origin already is — the SW's
// per-dApp authorization key. The SW replies with connection-scoped initial
// provider state ({accounts, chainId} — accounts only for a connected,
// unlocked origin), which we relay to the MAIN-world provider so a reloaded
// dApp's eth_accounts / a late-opened tab's eth_chainId answer real state
// instead of the hardcoded seeds. Read lastError first to suppress the
// harmless "no response" noise if the SW is too old/absent to reply.
chrome.runtime.sendMessage(
  { kind: "announce", origin: window.location.origin },
  (response: { accounts?: unknown; chainId?: unknown } | undefined) => {
    void chrome.runtime.lastError;
    if (!response || typeof response !== "object") return;
    const state: InboundState = {
      source: "monolythium-wallet-bridge",
      state: { accounts: response.accounts, chainId: response.chainId },
    };
    window.postMessage(state, window.location.origin);
  },
);

window.addEventListener("message", (ev) => {
  // Only accept messages posted from THIS window. The MAIN-world provider shares
  // our window, so legitimate provider->bridge traffic has ev.source === window.
  // A forged envelope from another frame/context (e.g. a cross-origin child
  // iframe doing window.top.postMessage, whose ev.source is the iframe's window)
  // is rejected here — closes the F-2.1 page-local spoof and the F-2.2
  // cross-frame confused-deputy. Additive: the source-string check below still runs.
  if (ev.source !== window) return;
  const data = ev.data as OutboundEnvelope | undefined;
  if (!data || data.source !== "monolythium-wallet-page") return;

  // Forward to the service worker. The service worker enforces user approval
  // for every state-changing request and pings back over the same id.
  chrome.runtime.sendMessage(
    { kind: "rpc", id: data.id, args: data.args, origin: window.location.origin },
    (response: { result?: unknown; error?: { code: number; message: string } } | undefined) => {
      const reply: InboundEnvelope = {
        source: "monolythium-wallet-bridge",
        id: data.id,
        ...(response?.error ? { error: response.error } : { result: response?.result }),
      };
      window.postMessage(reply, window.location.origin);
    },
  );
});

// Listen for service-worker-initiated events (account change / chain change /
// disconnect) and forward them to the in-page provider.
chrome.runtime.onMessage.addListener((message: { kind: string; event?: string; payload?: unknown }) => {
  if (message?.kind !== "event") return;
  if (!message.event) return;
  const ev: InboundEvent = {
    source: "monolythium-wallet-bridge",
    event: message.event as InboundEvent["event"],
    payload: message.payload,
  };
  window.postMessage(ev, window.location.origin);
});

// This content script is bundled as an ES module by @crxjs; the explicit export
// keeps it a TS module (so it can be dynamically imported by its test).
export {};

