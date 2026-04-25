// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts        (real popup approval)
//   - eth_chainId / net_version
//   - eth_sendTransaction        (real RLP build + secp256k1 sign + raw broadcast)
//   - personal_sign              (real secp256k1 sign over the EIP-191 prefix)
//   - eth_sendRawTransaction     (proxy to RpcClient.ethSendRawTransaction)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain    (acks if known, errors if unknown)
//
// Plus internal channels used by the popup:
//   - get-pending-approval
//   - resolve-approval
//   - keystore.{status, unlock, lock, create-from-new, create-from-mnemonic}

import { RpcClient } from "@monolythium/core-sdk";
import {
  enqueue as enqueueApproval,
  resolve as resolveApproval,
  rejectByWindow,
  getPending,
  listPending,
  type ApprovalDecision,
} from "./approvals.js";
import {
  hasVault,
  getStoredAddress,
  getUnlockedAddress,
  isUnlocked,
  lock as lockKeystore,
  unlock as unlockKeystore,
  createVaultFromNewMnemonic,
  createVaultFromMnemonic,
  personalSign as keystorePersonalSign,
  signLegacyTx,
} from "./keystore.js";

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

// ---- Known networks ----
interface NetInfo {
  name: string;
  rpc: string;
  chainIdNum: number;
}

const KNOWN_CHAINS: Record<string, NetInfo> = {
  "0x1B1C": { name: "LythiumDAG-BFT Testnet", rpc: "https://node-tnt.monolythium.xyz", chainIdNum: 6940 },
  "0x6970": { name: "Monolythium Mainnet", rpc: "https://node-01.monolythium.xyz", chainIdNum: 26992 },
  "0x7A69": { name: "Local devnet", rpc: "http://127.0.0.1:8545", chainIdNum: 31337 },
};

interface SessionState {
  chainId: keyof typeof KNOWN_CHAINS;
  // Origins the user has approved for eth_accounts visibility. {origin -> true}
  connectedOrigins: Set<string>;
}

const session: SessionState = {
  chainId: "0x1B1C",
  connectedOrigins: new Set<string>(),
};

console.log("[Monolythium Wallet] service worker boot");

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
const ERR_INTERNAL = -32603;

function rpcClientFor(chainId: keyof typeof KNOWN_CHAINS): RpcClient {
  const net = KNOWN_CHAINS[chainId]!;
  return new RpcClient(net.rpc);
}

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
      return ok(session.chainId);

    case "net_version":
      return ok(String(parseInt(session.chainId, 16)));

    case "eth_accounts": {
      const addr = getUnlockedAddress() ?? (await getStoredAddress());
      if (!addr) return ok([]);
      return ok(session.connectedOrigins.has(origin) ? [addr] : []);
    }

    case "eth_requestAccounts": {
      // If wallet doesn't exist yet, surface a clear error so the dapp can
      // tell the user to onboard. We could also auto-open the popup at the
      // onboarding screen — left to next stage.
      if (!(await hasVault())) {
        return err(ERR_UNAUTHORIZED, "Monolythium Wallet has no vault — open the extension and complete onboarding first");
      }
      const decision = await enqueueApproval({ kind: "connect", origin });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the connection");
      }
      // After approval the keystore must be unlocked (popup unlocks before
      // confirming). If not, fail closed.
      const addr = getUnlockedAddress();
      if (!addr) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      session.connectedOrigins.add(origin);
      broadcastEvent("accountsChanged", [addr]);
      broadcastEvent("connect", { chainId: session.chainId });
      return ok([addr]);
    }

    case "personal_sign": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      // EIP-191 personal_sign params: [message, address] (modern) or
      // [address, message] (legacy MetaMask). Detect by looking at which arg
      // is an address.
      const arr = Array.isArray(params) ? params : [];
      let messageParam: unknown;
      const a = arr[0];
      const b = arr[1];
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        messageParam = b;
      } else {
        messageParam = a;
      }
      if (typeof messageParam !== "string") {
        return err(-32602, "personal_sign expects a message string");
      }

      const decision = await enqueueApproval({
        kind: "personal_sign",
        origin,
        message: messageParam,
        address: getUnlockedAddress() ?? (await getStoredAddress()) ?? "",
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the message");
      }
      if (!isUnlocked()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }
      try {
        const sig = await keystorePersonalSign(messageParam);
        return ok("0x" + bytesToHex(sig));
      } catch (e) {
        return err(ERR_INTERNAL, `signing failed: ${(e as Error).message}`);
      }
    }

    case "eth_sendTransaction": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      const txReq = (arr[0] as Record<string, string> | undefined) ?? {};

      const decision = await enqueueApproval({ kind: "send_tx", origin, tx: txReq });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the transaction");
      }
      if (!isUnlocked()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }

      try {
        const net = KNOWN_CHAINS[session.chainId]!;
        const client = rpcClientFor(session.chainId);
        const fromAddr = getUnlockedAddress() ?? "0x0000000000000000000000000000000000000000";

        // Fill in defaults (nonce / gasPrice / gas) from the node when missing.
        const nonceHex =
          txReq.nonce ??
          numberToHexQuantity(await client.ethGetTransactionCount(fromAddr, "pending"));
        const gasPriceHex =
          txReq.gasPrice ?? numberToHexQuantity(await client.ethGasPrice());
        const gasHex =
          txReq.gas ??
          numberToHexQuantity(
            await client.ethEstimateGas({
              from: fromAddr,
              ...(txReq.to !== undefined ? { to: txReq.to } : {}),
              ...(txReq.value !== undefined ? { value: txReq.value } : {}),
              ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            }),
          );

        const { rawTx, txHash } = await signLegacyTx({
          ...(txReq.to !== undefined ? { to: txReq.to } : {}),
          ...(txReq.value !== undefined ? { value: txReq.value } : {}),
          ...(txReq.data !== undefined ? { data: txReq.data } : {}),
          nonce: nonceHex,
          gas: gasHex,
          gasPrice: gasPriceHex,
          chainId: net.chainIdNum,
        });

        // Best-effort broadcast. If the RPC rejects, surface the message but
        // also return the locally-computed hash so the caller can poll. We
        // strongly prefer a successful broadcast though.
        try {
          const accepted = await client.ethSendRawTransaction(rawTx);
          return ok(accepted || txHash);
        } catch (e) {
          return err(ERR_INTERNAL, `broadcast failed: ${(e as Error).message}`);
        }
      } catch (e) {
        return err(ERR_INTERNAL, `tx build failed: ${(e as Error).message}`);
      }
    }

    case "eth_sendRawTransaction": {
      const arr = Array.isArray(params) ? params : [];
      const raw = arr[0];
      if (typeof raw !== "string") {
        return err(-32602, "eth_sendRawTransaction expects a hex string");
      }
      try {
        const client = rpcClientFor(session.chainId);
        const hash = await client.ethSendRawTransaction(raw);
        return ok(hash);
      } catch (e) {
        return err(ERR_INTERNAL, `broadcast failed: ${(e as Error).message}`);
      }
    }

    case "wallet_switchEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_switchEthereumChain: missing chainId param");
      if (!KNOWN_CHAINS[requested as keyof typeof KNOWN_CHAINS]) {
        return err(ERR_CHAIN_NOT_ADDED, "Unknown chain. Use wallet_addEthereumChain first.");
      }
      session.chainId = requested as keyof typeof KNOWN_CHAINS;
      broadcastEvent("chainChanged", session.chainId);
      return ok(null);
    }

    case "wallet_addEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as { chainId?: string } | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_addEthereumChain: missing chainId param");
      // TODO(monolythium-vision): show user-approval UI for adding new chains.
      if (KNOWN_CHAINS[requested as keyof typeof KNOWN_CHAINS]) {
        return ok(null);
      }
      return err(ERR_USER_REJECTED, "Adding unknown chains not yet implemented");
    }

    default:
      return err(ERR_UNSUPPORTED_METHOD, `Method ${method} is not supported by Monolythium Wallet yet`);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function numberToHexQuantity(n: number | bigint): string {
  const big = typeof n === "bigint" ? n : BigInt(n);
  return "0x" + big.toString(16);
}

// ---- internal popup messages ----

interface PopupMessage {
  kind: "popup";
  op: string;
  payload?: unknown;
}

async function handlePopup(message: PopupMessage): Promise<unknown> {
  switch (message.op) {
    case "list-pending":
      return listPending();
    case "get-pending": {
      const id = (message.payload as { id?: string } | undefined)?.id;
      return id ? getPending(id) : null;
    }
    case "resolve": {
      const p = message.payload as { id: string; decision: ApprovalDecision };
      const found = resolveApproval(p.id, p.decision);
      return { found };
    }
    case "keystore-status": {
      return {
        hasVault: await hasVault(),
        unlocked: isUnlocked(),
        address: getUnlockedAddress() ?? (await getStoredAddress()),
      };
    }
    case "keystore-unlock": {
      const p = message.payload as { password: string };
      try {
        const r = await unlockKeystore(p.password);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-lock": {
      lockKeystore();
      return { ok: true };
    }
    case "keystore-create-new": {
      const p = message.payload as { password: string };
      try {
        const r = await createVaultFromNewMnemonic(p.password);
        return { ok: true, mnemonic: r.mnemonic, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-create-from-mnemonic": {
      const p = message.payload as { password: string; mnemonic: string };
      try {
        const r = await createVaultFromMnemonic(p.password, p.mnemonic);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    default:
      return { error: `unknown popup op ${message.op}` };
  }
}

// ---- message routing ----

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as { kind?: string };
  if (m?.kind === "rpc") {
    const rpc = message as RpcMessage;
    handleRpc(rpc)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: { code: -32603, message: String(e) } }));
    return true;
  }
  if (m?.kind === "popup") {
    handlePopup(message as PopupMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Monolythium Wallet] service worker installed");
});

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    rejectByWindow(winId);
  });
}
