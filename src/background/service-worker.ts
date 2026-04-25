// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts        (real popup approval)
//   - eth_chainId / net_version
//   - eth_sendTransaction        (real RLP build + secp256k1 sign + raw broadcast)
//   - personal_sign              (real secp256k1 sign over the EIP-191 prefix)
//   - eth_signTypedData_v4       (EIP-712 typed-data signing)
//   - eth_sendRawTransaction     (proxy to RpcClient.ethSendRawTransaction)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain    (real approval UI; persists to chrome.storage)
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
  type SendTxView,
  type AddChainSpec,
  type TypedDataEnvelope,
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
  signTypedDataV4,
  computeTypedDataDigest,
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
  /** True when this chain is in the built-in Monolythium registry. */
  builtin?: boolean;
  /** Optional explorer URL surfaced by `wallet_addEthereumChain`. */
  blockExplorer?: string;
  /** Native currency descriptor (default: LYTH 18). */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

// Built-in chains. User-added chains live in `userChains` (loaded from
// chrome.storage at boot) and are merged into KNOWN_CHAINS at lookup time.
const BUILTIN_CHAINS: Record<string, NetInfo> = {
  "0x1B1C": {
    name: "LythiumDAG-BFT Testnet",
    rpc: "https://node-tnt.monolythium.xyz",
    chainIdNum: 6940,
    builtin: true,
    nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
  },
  "0x6970": {
    name: "Monolythium Mainnet",
    rpc: "https://node-01.monolythium.xyz",
    chainIdNum: 26992,
    builtin: true,
    nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
  },
  "0x7A69": {
    name: "Local devnet",
    rpc: "http://127.0.0.1:8545",
    chainIdNum: 31337,
    builtin: true,
    nativeCurrency: { name: "Lythium", symbol: "LYTH", decimals: 18 },
  },
};

const USER_CHAINS_STORAGE_KEY = "mono.user-chains";
let userChains: Record<string, NetInfo> = {};

function chainRegistry(): Record<string, NetInfo> {
  return { ...BUILTIN_CHAINS, ...userChains };
}

function lookupChain(id: string): NetInfo | null {
  const reg = chainRegistry();
  // Allow lower-case input.
  const norm = id.toLowerCase();
  for (const [k, v] of Object.entries(reg)) {
    if (k.toLowerCase() === norm) return v;
  }
  return null;
}

async function loadUserChains(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([USER_CHAINS_STORAGE_KEY], (res) => {
      const v = res?.[USER_CHAINS_STORAGE_KEY];
      if (v && typeof v === "object") {
        userChains = v as Record<string, NetInfo>;
      }
      resolve();
    });
  });
}

async function persistUserChains(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [USER_CHAINS_STORAGE_KEY]: userChains }, () =>
      resolve(),
    );
  });
}

interface SessionState {
  chainId: string;
  // Origins the user has approved for eth_accounts visibility. {origin -> true}
  connectedOrigins: Set<string>;
}

const session: SessionState = {
  chainId: "0x1B1C",
  connectedOrigins: new Set<string>(),
};

console.log("[Monolythium Wallet] service worker boot");
// Hydrate user-added chains as soon as the worker spins up. Service worker
// hibernation -> we re-read on every boot.
void loadUserChains();

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

function rpcClientFor(chainId: string): RpcClient {
  const net = lookupChain(chainId);
  if (!net) throw new Error(`unknown chain ${chainId}`);
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

      // Build the approval view BEFORE opening the popup so the user sees
      // real numbers (gas estimate, simulation outcome, nonce) instead of
      // demo placeholders. RPC failures degrade gracefully — we still let
      // the user approve, but the popup will surface the gap.
      const view = await buildSendTxView(txReq);

      const decision = await enqueueApproval({
        kind: "send_tx",
        origin,
        tx: txReq,
        view,
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the transaction");
      }
      if (!isUnlocked()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }

      try {
        const net = lookupChain(session.chainId);
        if (!net) throw new Error(`unknown chain ${session.chainId}`);
        const client = rpcClientFor(session.chainId);

        // Re-resolve gas with the latest node values at sign time. The view
        // we showed the user is the same shape (and usually identical
        // numbers) but we don't trust stale views to be authoritative.
        const fromAddr = getUnlockedAddress() ?? "0x0000000000000000000000000000000000000000";
        const nonceHex =
          txReq.nonce ?? view.nonce ??
          numberToHexQuantity(await client.ethGetTransactionCount(fromAddr, "pending"));
        const gasPriceHex =
          txReq.gasPrice ?? view.gasPrice ?? numberToHexQuantity(await client.ethGasPrice());
        const gasHex =
          txReq.gas ?? view.estimatedGas ??
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

    case "eth_signTypedData_v4":
    case "eth_signTypedData": {
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      const arr = Array.isArray(params) ? params : [];
      // EIP-712 dapps pass [address, typedData]. Some pass them swapped — we
      // recognize an address-shaped string in either slot to be tolerant.
      let address: string | null = null;
      let dataParam: unknown = null;
      const a = arr[0];
      const b = arr[1];
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        address = a;
        dataParam = b;
      } else if (typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(b)) {
        address = b;
        dataParam = a;
      } else {
        // Fall back: assume canonical [address, data].
        address = typeof a === "string" ? a : "";
        dataParam = b;
      }
      if (dataParam == null) {
        return err(-32602, "eth_signTypedData_v4 expects [address, typedData]");
      }
      const rawTypedData =
        typeof dataParam === "string" ? dataParam : JSON.stringify(dataParam);
      const parsed = parseTypedData(rawTypedData);
      let digest: string | null = null;
      if (parsed) {
        try {
          digest = "0x" + bytesToHex(computeTypedDataDigest(parsed));
        } catch {
          digest = null;
        }
      }

      const decision = await enqueueApproval({
        kind: "typed_sign",
        origin,
        address: address ?? getUnlockedAddress() ?? (await getStoredAddress()) ?? "",
        rawTypedData,
        parsed,
        digest,
      });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the typed data");
      }
      if (!isUnlocked()) return err(ERR_UNAUTHORIZED, "wallet is locked");
      if (!parsed) {
        return err(-32602, "typed data could not be parsed as EIP-712 v4");
      }
      try {
        const sig = await signTypedDataV4(parsed);
        return ok("0x" + bytesToHex(sig));
      } catch (e) {
        return err(ERR_INTERNAL, `typed-data sign failed: ${(e as Error).message}`);
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
      const found = lookupChain(requested);
      if (!found) {
        return err(ERR_CHAIN_NOT_ADDED, "Unknown chain. Use wallet_addEthereumChain first.");
      }
      session.chainId = canonicalChainKey(requested);
      broadcastEvent("chainChanged", session.chainId);
      return ok(null);
    }

    case "wallet_addEthereumChain": {
      const p = Array.isArray(params) ? (params[0] as Partial<AddChainSpec> | undefined) : undefined;
      const requested = p?.chainId;
      if (!requested) return err(-32602, "wallet_addEthereumChain: missing chainId param");
      // EIP-3085 says we may silently no-op if the chain is already known.
      if (lookupChain(requested)) {
        return ok(null);
      }
      // Validate minimal shape; unknown chain — ask the user.
      if (!Array.isArray(p?.rpcUrls) || (p?.rpcUrls?.length ?? 0) === 0) {
        return err(-32602, "wallet_addEthereumChain: rpcUrls must be a non-empty array");
      }
      const spec: AddChainSpec = {
        chainId: requested,
        chainName: typeof p?.chainName === "string" ? p.chainName : "Unnamed chain",
        rpcUrls: p.rpcUrls as string[],
        ...(Array.isArray(p?.blockExplorerUrls) ? { blockExplorerUrls: p.blockExplorerUrls } : {}),
        ...(Array.isArray(p?.iconUrls) ? { iconUrls: p.iconUrls } : {}),
        ...(p?.nativeCurrency ? { nativeCurrency: p.nativeCurrency } : {}),
      };
      const decision = await enqueueApproval({ kind: "add_chain", origin, chain: spec });
      if (!decision.ok) {
        return err(ERR_USER_REJECTED, decision.reason ?? "user rejected the new chain");
      }
      // Persist for subsequent sessions.
      const key = canonicalChainKey(spec.chainId);
      const chainIdNum = parseHexQuantity(spec.chainId);
      userChains[key] = {
        name: spec.chainName,
        rpc: spec.rpcUrls[0]!,
        chainIdNum,
        ...(spec.blockExplorerUrls?.[0] ? { blockExplorer: spec.blockExplorerUrls[0] } : {}),
        ...(spec.nativeCurrency ? { nativeCurrency: spec.nativeCurrency } : {}),
      };
      await persistUserChains();
      return ok(null);
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

function parseHexQuantity(hex: string): number {
  const r = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (r.length === 0) return 0;
  const n = parseInt(r, 16);
  return Number.isNaN(n) ? 0 : n;
}

// EIP-3085 chain ids are hex-encoded but case-insensitive on the wire. We
// normalize to the casing used by the BUILTIN_CHAINS keys (`0x1B1C` style)
// so lookups don't drift.
function canonicalChainKey(id: string): string {
  if (!id.startsWith("0x") && !id.startsWith("0X")) {
    // Allow decimal input and convert.
    const asNum = Number.parseInt(id, 10);
    if (!Number.isNaN(asNum)) {
      return "0x" + asNum.toString(16).toUpperCase();
    }
    return "0x" + id.toUpperCase();
  }
  return "0x" + id.slice(2).toUpperCase();
}

/**
 * Best-effort EIP-712 v4 parser. Accepts the JSON string the dapp sent
 * (modern wallets pass strings; some legacy wallets pass an object). Returns
 * null when the input cannot be coerced into the canonical envelope shape.
 */
function parseTypedData(raw: string): TypedDataEnvelope | null {
  try {
    const obj = JSON.parse(raw) as {
      domain?: Record<string, unknown>;
      types?: Record<string, Array<{ name: string; type: string }>>;
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    if (!obj.domain || !obj.types || !obj.primaryType || !obj.message) return null;
    return {
      domain: obj.domain,
      types: obj.types,
      primaryType: obj.primaryType,
      message: obj.message,
    };
  } catch {
    return null;
  }
}

/**
 * Pre-populate the `SendTxView` shown on the approval popup. We attempt every
 * RPC in parallel so the popup opens fast; an individual failure leaves that
 * field `null` and the UI surfaces the gap rather than blocking approval.
 */
async function buildSendTxView(
  txReq: Record<string, string>,
): Promise<SendTxView> {
  const chainId = session.chainId;
  const net = lookupChain(chainId);
  const chainLabel = net?.name ?? chainId;

  const view: SendTxView = {
    estimatedGas: txReq.gas ?? null,
    gasPrice: txReq.gasPrice ?? null,
    nonce: txReq.nonce ?? null,
    simulation: null,
    chainId,
    chainLabel,
  };
  if (!net) return view;

  const client = rpcClientFor(chainId);
  const fromAddr =
    txReq.from ?? getUnlockedAddress() ?? (await getStoredAddress()) ?? "0x0000000000000000000000000000000000000000";

  const callShape = {
    from: fromAddr,
    ...(txReq.to !== undefined ? { to: txReq.to } : {}),
    ...(txReq.value !== undefined ? { value: txReq.value } : {}),
    ...(txReq.data !== undefined ? { data: txReq.data } : {}),
  };

  type SimResult = SendTxView["simulation"];
  const simPromise: Promise<SimResult> =
    txReq.data && txReq.data !== "0x" && txReq.data.length > 2
      ? client
          .ethCall(callShape)
          .then(
            (r): SimResult => ({ success: true, returnData: r ?? "0x" }),
          )
          .catch(
            (e: Error): SimResult => ({
              success: false,
              error: e.message ?? "revert",
            }),
          )
      : Promise.resolve(null);

  const [gasEst, gasPrice, nonce, sim] = await Promise.all([
    view.estimatedGas != null
      ? Promise.resolve(view.estimatedGas)
      : client
          .ethEstimateGas(callShape)
          .then((n) => numberToHexQuantity(n))
          .catch(() => null as string | null),
    view.gasPrice != null
      ? Promise.resolve(view.gasPrice)
      : client
          .ethGasPrice()
          .then((n) => numberToHexQuantity(n))
          .catch(() => null as string | null),
    view.nonce != null
      ? Promise.resolve(view.nonce)
      : client
          .ethGetTransactionCount(fromAddr, "pending")
          .then((n) => numberToHexQuantity(n))
          .catch(() => null as string | null),
    simPromise,
  ]);

  view.estimatedGas = gasEst;
  view.gasPrice = gasPrice;
  view.nonce = nonce;
  view.simulation = sim;
  return view;
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
        // Expose the actual custody mode so the popup can show real settings
        // instead of a hard-coded "sw / slhdsa" stub. Only software keystores
        // exist today; future TPM/passkey/HW backends slot in here.
        custody: "sw" as const,
        algo: "secp256k1" as const,
      };
    }
    case "chain-list": {
      return Object.entries(chainRegistry()).map(([id, n]) => ({
        chainId: id,
        name: n.name,
        rpc: n.rpc,
        chainIdNum: n.chainIdNum,
        builtin: !!n.builtin,
        active: id === session.chainId,
        ...(n.blockExplorer ? { blockExplorer: n.blockExplorer } : {}),
        ...(n.nativeCurrency ? { nativeCurrency: n.nativeCurrency } : {}),
      }));
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
