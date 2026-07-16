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

const MAX_RPC_ID_LENGTH = 128;
const MAX_RPC_METHOD_LENGTH = 128;
const WALLET_AUTH_STRING_LIMITS = {
  version: 8,
  domain: 512,
  origin: 528,
  uri: 529,
  chainId: 78,
  genesisHash: 66,
  nonce: 43,
  issuedAt: 24,
  expirationTime: 24,
} as const;
const WALLET_AUTH_FIELDS = new Set<string>([
  ...Object.keys(WALLET_AUTH_STRING_LIMITS),
  "scopes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep oversized authentication payloads from crossing the second structured-
 * clone boundary into the privileged service worker. The authoritative parser
 * still runs there; this only enforces cheap structural/length ceilings first.
 */
function fitsWalletAuthBridgeBudget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  let fieldCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    fieldCount += 1;
    if (fieldCount > WALLET_AUTH_FIELDS.size || !WALLET_AUTH_FIELDS.has(key)) {
      return false;
    }
  }
  if (fieldCount !== WALLET_AUTH_FIELDS.size) return false;

  for (const [field, maxLength] of Object.entries(WALLET_AUTH_STRING_LIMITS)) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue.length > maxLength) {
      return false;
    }
  }
  const scopes = value.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 16) {
    return false;
  }
  return scopes.every(
    (scope) => typeof scope === "string" && scope.length <= 128,
  );
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
  // P4-003 — mirror the provider's origin guard: reject anything not from this
  // page's own origin (robust if `all_frames` ever flips). Additive DiD.
  if (ev.origin !== window.location.origin) return;
  const data = ev.data as OutboundEnvelope | undefined;
  if (!data || data.source !== "monolythium-wallet-page") return;
  if (
    typeof data.id !== "string" ||
    data.id.length === 0 ||
    data.id.length > MAX_RPC_ID_LENGTH ||
    !isRecord(data.args) ||
    typeof data.args.method !== "string" ||
    data.args.method.length === 0 ||
    data.args.method.length > MAX_RPC_METHOD_LENGTH
  ) {
    return;
  }
  if (
    data.args.method === "monolythium_authenticate" &&
    !fitsWalletAuthBridgeBudget(data.args.params)
  ) {
    const reply: InboundEnvelope = {
      source: "monolythium-wallet-bridge",
      id: data.id,
      error: {
        code: -32602,
        message: "wallet authentication challenge is malformed",
      },
    };
    window.postMessage(reply, window.location.origin);
    return;
  }

  // For authentication, rebuild the argument object from its two allowed
  // fields. A page can post an object with arbitrary runtime-only siblings
  // despite the TypeScript interface; none may cross into the service worker.
  const argsToForward =
    data.args.method === "monolythium_authenticate"
      ? { method: data.args.method, params: data.args.params }
      : data.args;

  // Forward to the service worker. The service worker enforces user approval
  // for every state-changing request and pings back over the same id.
  chrome.runtime.sendMessage(
    { kind: "rpc", id: data.id, args: argsToForward, origin: window.location.origin },
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
