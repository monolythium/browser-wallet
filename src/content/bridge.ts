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

window.addEventListener("message", (ev) => {
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
      window.postMessage(reply, "*");
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
  window.postMessage(ev, "*");
});

