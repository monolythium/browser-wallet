// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts
//   - eth_chainId
//   - net_version
//   - eth_sendTransaction (stub: returns a synthetic tx hash)
//   - personal_sign        (stub: returns a synthetic signature)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain (acks if known, errors if unknown)
//
// Keystore is intentionally stubbed: on first wake we generate an ephemeral
// in-memory account so `eth_accounts` has something to return for the design
// review pass. Real keystore (argon2id + xchacha20poly1305 + chrome.storage)
// lands in Stage 4 of plans/browser-wallet.md.
// TODO(monolythium-vision): replace EPHEMERAL_ACCOUNT with the encrypted
// keystore + unlock prompt once Stage 4 ships.

interface RpcArgs {
  method: string;
  params?: unknown[] | object;
}

interface RpcMessage {
  kind: "rpc";
  id: string;
  args: RpcArgs;
  origin: string;
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

// ---- Known networks (subset of demo-data NETWORKS, kept duplicated so the
//      service worker has zero popup-side imports). ----
const KNOWN_CHAINS: Record<string, { name: string; rpc: string }> = {
  "0x1B1C": { name: "LythiumDAG-BFT Testnet", rpc: "https://node-tnt.monolythium.xyz" },
  "0x6970": { name: "Monolythium Mainnet", rpc: "https://node-01.monolythium.xyz" },
  "0x7A69": { name: "Local devnet", rpc: "http://127.0.0.1:8545" },
};

interface WalletState {
  // Currently selected EVM account (lowercased 0x-prefixed hex).
  account: string;
  // Currently selected EVM chain id (0x-prefixed hex).
  chainId: keyof typeof KNOWN_CHAINS;
  // Origins the user has approved. {origin -> true}
  connectedOrigins: Set<string>;
}

// Generate an ephemeral 20-byte address. Not a real key — purely a placeholder
// so dapps can call eth_accounts without crashing. Keystore replaces this.
function ephemeralAddress(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// In-memory state. MV3 service workers go to sleep after ~30s idle; for the
// design pass we accept the loss. Persistent state moves to chrome.storage in
// Stage 4 (keystore).
const state: WalletState = {
  account: ephemeralAddress(),
  chainId: "0x1B1C",
  connectedOrigins: new Set<string>(),
};

console.log("[Monolythium Wallet] service worker boot, ephemeral account:", state.account);

// ---- Helpers ----

function ok(result: unknown): RpcResponse {
  return { result };
}

function err(code: number, message: string): RpcResponse {
  return { error: { code, message } };
}

// EIP-1193 standard error codes.
const ERR_USER_REJECTED = 4001;
const ERR_UNAUTHORIZED = 4100;
const ERR_UNSUPPORTED_METHOD = 4200;
const ERR_CHAIN_NOT_ADDED = 4902;

// Synthetic 0x-prefixed hex of the given byte length. For sendTransaction /
// personal_sign stubs.
function syntheticHex(bytes: number): string {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  return "0x" + Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Broadcast an event to every connected tab. Used for chainChanged /
// accountsChanged. Tabs that don't have our content script ignore it.
function broadcastEvent(event: string, payload: unknown): void {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { kind: "event", event, payload }).catch(() => {
        /* tab may not host our content script; ignore */
      });
    }
  });
}

// ---- RPC dispatch ----

async function handleRpc(message: RpcMessage): Promise<RpcResponse> {
  const { method, params } = message.args;
  const origin = message.origin;

  switch (method) {
    case "eth_chainId":
      return ok(state.chainId);

    case "net_version":
      return ok(String(parseInt(state.chainId, 16)));

    case "eth_accounts":
      // Per EIP-1102, return [] if not connected, [account] if connected.
      return ok(state.connectedOrigins.has(origin) ? [state.account] : []);

    case "eth_requestAccounts": {
      // TODO(monolythium-vision): pop the popup and require explicit user
      // approval (designs/src/ext-requests.jsx ReqConnect). For Stage 3 we
      // auto-approve so dapp round-trip can be exercised end-to-end.
      state.connectedOrigins.add(origin);
      broadcastEvent("accountsChanged", [state.account]);
      broadcastEvent("connect", { chainId: state.chainId });
      return ok([state.account]);
    }

    case "personal_sign": {
      if (!state.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "wallet is locked or origin not connected");
      }
      // params: [message, address] or [address, message] depending on caller.
      // TODO(monolythium-vision): show ReqMessage dialog and require approval.
      // TODO(monolythium-vision): real signature once keystore lands.
      // Return a synthetic but plausible 65-byte signature so the caller
      // can serialize/parse it.
      return ok(syntheticHex(65));
    }

    case "eth_sendTransaction": {
      if (!state.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "wallet is locked or origin not connected");
      }
      // params: [{ from, to, value?, data?, gas?, ... }]
      // TODO(monolythium-vision): show ReqSign dialog and require approval.
      // TODO(monolythium-vision): build + sign + broadcast once keystore + RPC
      // wiring land. For now return a synthetic 32-byte hash so the caller's
      // tx-watcher doesn't crash.
      return ok(syntheticHex(32));
    }

    case "wallet_switchEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_switchEthereumChain: missing chainId param");
      if (!KNOWN_CHAINS[requested as keyof typeof KNOWN_CHAINS]) {
        return err(ERR_CHAIN_NOT_ADDED, "Unknown chain. Use wallet_addEthereumChain first.");
      }
      state.chainId = requested as keyof typeof KNOWN_CHAINS;
      broadcastEvent("chainChanged", state.chainId);
      return ok(null);
    }

    case "wallet_addEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_addEthereumChain: missing chainId param");
      // TODO(monolythium-vision): show user-approval UI for adding new chains.
      // For Stage 3 we only acknowledge known chains.
      if (KNOWN_CHAINS[requested as keyof typeof KNOWN_CHAINS]) {
        return ok(null);
      }
      return err(ERR_USER_REJECTED, "Adding unknown chains not yet implemented");
    }

    default:
      return err(ERR_UNSUPPORTED_METHOD, `Method ${method} is not supported by Monolythium Wallet yet`);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as { kind?: string };
  if (m?.kind !== "rpc") return false;

  const rpc = message as RpcMessage;
  handleRpc(rpc)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: { code: -32603, message: String(e) } }));

  return true; // keep the channel open for async response
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Monolythium Wallet] service worker installed");
});
