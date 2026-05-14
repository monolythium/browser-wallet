// Monolythium Wallet — MV3 service worker.
//
// EIP-1193 RPC dispatch lives here. Wired methods:
//   - eth_accounts
//   - eth_requestAccounts        (real popup approval)
//   - eth_chainId / net_version
//   - eth_sendTransaction        (real RLP build + secp256k1 sign + raw broadcast)
//   - eth_sign / personal_sign   (real secp256k1 sign over the EIP-191 prefix)
//   - eth_signTypedData_v4       (EIP-712 typed-data signing)
//   - eth_sendRawTransaction     (proxy through MonolythiumProvider)
//   - wallet_switchEthereumChain
//   - wallet_addEthereumChain    (real approval UI; persists to chrome.storage)
//
// Plus internal channels used by the popup:
//   - get-pending-approval
//   - resolve-approval
//   - keystore.{status, unlock, lock, create-from-new, create-from-mnemonic}
//
// Chain reads/writes go through `MonolythiumProvider` from
// `@monolythium/core-sdk` — the ethers v6 shim. The shim re-uses the SDK's
// JSON-RPC transport (no raw fetch in this file), so any future SDK transport
// feature (auth headers, ws upgrade, registry-aware routing) lights up for the
// wallet automatically.

import {
  MonolythiumProvider,
  MONOLYTHIUM_TESTNET_CHAIN_ID,
} from "@monolythium/core-sdk";
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
  hasLegacyVault,
  getStoredAddress,
  getUnlockedAddress,
  isUnlocked,
  lock as lockKeystore,
  unlock as unlockKeystore,
  personalSign as keystorePersonalSign,
  signLegacyTx,
  signTypedDataV4,
  computeTypedDataDigest,
} from "./keystore.js";
import {
  isUnlockedV3,
  getUnlockedAddressV3,
  hasVaultV3,
  getStoredAddressV3,
  unlockV3,
  lockV3,
  createVaultFromNewMnemonic,
  createVaultFromMnemonic,
  createVaultFromSeedHex,
} from "./keystore-mldsa.js";
import {
  chainRequiresMlDsa,
  SPRINTNET_TRANSFER_GAS_LIMIT_HEX,
  probeFirstAliveOperator,
  BUILTIN_CHAINS as BUILTIN_CHAINS_LIST,
} from "./networks.js";
import {
  submitEncryptedMlDsaTx,
  sprintnetJsonRpc,
} from "./tx-mldsa.js";

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
  /** True for Foundation-attested official chains (Sprintnet). */
  official?: boolean;
  /** Optional explorer URL surfaced by `wallet_addEthereumChain`. */
  blockExplorer?: string;
  /** Native currency descriptor (default: LYTH 18). */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

// Canonical chain id for the LythiumDAG-BFT testnet (Law §13.1, mirrored by
// the SDK's `MONOLYTHIUM_TESTNET_CHAIN_ID`). Stored as the upper-cased hex
// quantity so chain-registry lookups don't drift on casing.
const TESTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // 0x10F2C

// Built-in chains derived from networks.ts. v4.0 ships Sprintnet only;
// user-added chains via `wallet_addEthereumChain` live in `userChains`
// (loaded from chrome.storage at boot) and are merged at lookup time.
const BUILTIN_CHAINS: Record<string, NetInfo> = Object.fromEntries(
  BUILTIN_CHAINS_LIST.map((c) => [
    c.chainId,
    {
      name: c.name,
      rpc: c.rpc,
      chainIdNum: c.chainIdNum,
      builtin: true,
      official: c.official,
      ...(c.blockExplorer ? { blockExplorer: c.blockExplorer } : {}),
      ...(c.nativeCurrency ? { nativeCurrency: c.nativeCurrency } : {}),
    } satisfies NetInfo,
  ]),
);

const USER_CHAINS_STORAGE_KEY = "mono.chains.user";
const ACTIVE_CHAIN_STORAGE_KEY = "mono.chain.active";
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

/**
 * Load the persisted active chain id from chrome.storage. Returns the
 * Sprintnet default when nothing is stored yet (first launch) or when
 * the stored id no longer maps to a known chain (e.g. user removed the
 * user-added chain that was active).
 */
async function loadActiveChainId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([ACTIVE_CHAIN_STORAGE_KEY], (res) => {
      const v = res?.[ACTIVE_CHAIN_STORAGE_KEY];
      if (typeof v === "string" && lookupChain(v)) {
        resolve(canonicalChainKey(v));
        return;
      }
      resolve(TESTNET_CHAIN_ID_HEX);
    });
  });
}

async function persistActiveChainId(chainId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [ACTIVE_CHAIN_STORAGE_KEY]: chainId },
      () => resolve(),
    );
  });
}

interface SessionState {
  chainId: string;
  // Origins the user has approved for eth_accounts visibility. {origin -> true}
  connectedOrigins: Set<string>;
}

const session: SessionState = {
  chainId: TESTNET_CHAIN_ID_HEX,
  connectedOrigins: new Set<string>(),
};

console.log("[Monolythium Wallet] service worker boot");
// Hydrate user-added chains and the persisted active chain id as soon as
// the worker spins up. Service-worker hibernation → we re-read on every
// boot. The active-chain hydration runs after user-chains so a stored id
// pointing at a user-added chain resolves cleanly via lookupChain.
void (async () => {
  await loadUserChains();
  session.chainId = await loadActiveChainId();
})();

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

/**
 * Build a `MonolythiumProvider` for the given chain. The provider is the
 * ethers v6 shim from `@monolythium/core-sdk` and re-uses the SDK's transport,
 * so every JSON-RPC call benefits from the SDK's error envelope handling.
 *
 * We keep an in-memory cache keyed by `<chainId, rpcUrl>` so each chain reuses
 * a single transport across calls — the service worker rebuilds the cache on
 * cold start, which is fine because the underlying transport holds no state
 * beyond the endpoint URL.
 */
const providerCache = new Map<string, MonolythiumProvider>();

function providerFor(chainId: string): MonolythiumProvider {
  const net = lookupChain(chainId);
  if (!net) throw new Error(`unknown chain ${chainId}`);
  const key = `${chainId}|${net.rpc}`;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = new MonolythiumProvider(net.rpc, {
      network: { chainId: BigInt(net.chainIdNum), name: net.name },
    });
    providerCache.set(key, provider);
  }
  return provider;
}

/**
 * Send a single JSON-RPC method through the SDK transport that the
 * `MonolythiumProvider` uses. Surfaces `{ result }` / `{ error }` from the
 * provider's `_send` exactly as a JSON-RPC server would, then unwraps to a
 * native value or throws.
 */
async function rpcSend<T>(
  provider: MonolythiumProvider,
  method: string,
  params: unknown[],
): Promise<T> {
  const [response] = await provider._send({
    id: 1,
    jsonrpc: "2.0",
    method,
    params,
  });
  if (!response) {
    throw new Error(`provider returned no response for ${method}`);
  }
  if ("error" in response && response.error) {
    const e = new Error(response.error.message ?? `rpc error ${method}`) as Error & { code?: number };
    e.code = response.error.code;
    throw e;
  }
  return (response as { result: T }).result;
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

    case "eth_sign":
    case "personal_sign": {
      // `eth_sign` is the legacy alias dapp libraries still send. We treat it
      // identically to `personal_sign` (apply the EIP-191 prefix and require
      // user approval) — this is the safe MetaMask-shaped behaviour. Wallets
      // that bypass the prefix have shipped phishing-friendly attack
      // surfaces; we deliberately do not.
      if (!session.connectedOrigins.has(origin)) {
        return err(ERR_UNAUTHORIZED, "origin not connected — call eth_requestAccounts first");
      }
      // EIP-191 personal_sign params: [message, address] (modern) or
      // [address, message] (legacy MetaMask / `eth_sign` order). Detect by
      // looking at which arg is an address.
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

      // Monolythium-protocol chains reject the legacy RLP+secp256k1
      // envelope at the decoder layer (Law §2.1) — route to the SDK's
      // ML-DSA-65 bincode wire format instead. The v3 keystore holds
      // the unlocked backend; reads/writes funnel through the published
      // Sprintnet operators since the canonical alias is NXDOMAIN.
      if (chainRequiresMlDsa(session.chainId)) {
        if (!isUnlockedV3()) {
          return err(ERR_UNAUTHORIZED, "wallet is locked");
        }
        try {
          const fromAddr =
            getUnlockedAddressV3() ?? "0x0000000000000000000000000000000000000000";
          // Resolve missing nonce/gas/fee from the operators directly —
          // the chain registry's RPC alias resolves NXDOMAIN and the
          // existing `view` was built against that broken alias too, so
          // its fields are usually null on Sprintnet.
          const nonceHex =
            txReq.nonce ?? view.nonce ??
            (await sprintnetJsonRpc<string>("eth_getTransactionCount", [fromAddr, "pending"])).result;
          const gasPriceHex =
            txReq.gasPrice ?? view.gasPrice ??
            (await sprintnetJsonRpc<string>("eth_gasPrice", [])).result;
          // Sprintnet's mempool intrinsic floor is above what
          // `eth_estimateGas` reports (the latter only covers EVM
          // execution). Honour an explicit dapp gas hint if provided —
          // a dapp may know better than us and we'd rather surface a
          // chain reject than silently override — otherwise default to
          // the wallet's audited Sprintnet floor with headroom.
          const gasHex =
            txReq.gas ?? view.estimatedGas ?? SPRINTNET_TRANSFER_GAS_LIMIT_HEX;

          // Sign + ML-KEM-768/ChaCha20-Poly1305 wrap + lyth_submitEncrypted.
          // The chain rejects plaintext at admission (Law §4.5 / Q2), so
          // there is no eth_sendRawTransaction fallback path on Sprintnet.
          const { txHash } = await submitEncryptedMlDsaTx({
            ...(txReq.to !== undefined ? { to: txReq.to } : {}),
            ...(txReq.value !== undefined ? { value: txReq.value } : {}),
            ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            nonce: nonceHex,
            gas: gasHex,
            gasPrice: gasPriceHex,
            chainIdHex: session.chainId,
          });
          return ok(txHash);
        } catch (e) {
          return err(ERR_INTERNAL, `ml-dsa tx failed: ${(e as Error).message}`);
        }
      }

      if (!isUnlocked()) {
        return err(ERR_UNAUTHORIZED, "wallet is locked");
      }

      try {
        const net = lookupChain(session.chainId);
        if (!net) throw new Error(`unknown chain ${session.chainId}`);
        const provider = providerFor(session.chainId);

        // Re-resolve gas with the latest node values at sign time. The view
        // we showed the user is the same shape (and usually identical
        // numbers) but we don't trust stale views to be authoritative.
        const fromAddr = getUnlockedAddress() ?? "0x0000000000000000000000000000000000000000";
        const nonceHex =
          txReq.nonce ?? view.nonce ??
          (await rpcSend<string>(provider, "eth_getTransactionCount", [fromAddr, "pending"]));
        const gasPriceHex =
          txReq.gasPrice ?? view.gasPrice ?? (await rpcSend<string>(provider, "eth_gasPrice", []));
        const gasHex =
          txReq.gas ?? view.estimatedGas ??
          (await rpcSend<string>(provider, "eth_estimateGas", [
            {
              from: fromAddr,
              ...(txReq.to !== undefined ? { to: txReq.to } : {}),
              ...(txReq.value !== undefined ? { value: txReq.value } : {}),
              ...(txReq.data !== undefined ? { data: txReq.data } : {}),
            },
          ]));

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
          const accepted = await rpcSend<string>(provider, "eth_sendRawTransaction", [rawTx]);
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
        const provider = providerFor(session.chainId);
        const hash = await rpcSend<string>(provider, "eth_sendRawTransaction", [raw]);
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
      await persistActiveChainId(session.chainId);
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

  const provider = providerFor(chainId);
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
      ? rpcSend<string>(provider, "eth_call", [callShape, "latest"])
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
      : rpcSend<string>(provider, "eth_estimateGas", [callShape])
          .catch(() => null as string | null),
    view.gasPrice != null
      ? Promise.resolve(view.gasPrice)
      : rpcSend<string>(provider, "eth_gasPrice", [])
          .catch(() => null as string | null),
    view.nonce != null
      ? Promise.resolve(view.nonce)
      : rpcSend<string>(provider, "eth_getTransactionCount", [fromAddr, "pending"])
          .catch(() => null as string | null),
    simPromise,
  ]);

  view.estimatedGas = gasEst;
  view.gasPrice = gasPrice;
  view.nonce = nonce;
  view.simulation = sim;
  return view;
}

// ---- fee suggestion ----

/**
 * Sprintnet-specific minimum priority tip discovered empirically via
 * smoke-test admission rejection: 10 gwei (10_000_000_000 wei). The
 * chain doesn't expose this via RPC and `eth_maxPriorityFeePerGas`
 * is method-not-found, so it lives here as a chain constant. If the
 * chain operators ever change the floor, this is the one place to bump.
 */
const SPRINTNET_MIN_PRIORITY_FEE_HEX = "0x2540be400";

// ---- Operator liveness cache ----
//
// Backs the popup's chain-status banner. We probe the published Sprintnet
// operators in order and remember which one answered. The cache lives at
// module scope inside the service worker, so it survives across popup
// re-renders but resets when the worker hibernates — that's fine because
// hibernation is itself a "re-check liveness" signal.
//
// `name === null` means we probed and nothing answered. We still cache
// that result for the same TTL so the popup doesn't hammer dead nodes
// every render; the popup's own 10-second tick will retry once the TTL
// lapses.
const OPERATOR_CACHE_TTL_MS = 10_000;
let cachedOperator: { name: string | null; checkedAt: number } | null = null;

/**
 * Suggest `(maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas)` for a
 * given chain. On Sprintnet we ignore `eth_gasPrice` (returns `0x0`)
 * and `eth_maxPriorityFeePerGas` (method-not-found) and instead read
 * the next-block base fee via `eth_feeHistory(1, "latest", [])` and
 * stack the hardcoded 10 gwei tip floor on top.
 *
 * For non-Sprintnet chains we fall back to `eth_gasPrice` for now —
 * close enough for the legacy path that the popup may eventually use,
 * and the existing `eth_sendTransaction` handler does the same.
 */
async function suggestFee(chainIdHex: string): Promise<{
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  baseFeePerGas: string;
  /** Hex gas-limit recommendation. Sprintnet has a known intrinsic
   * floor that `eth_estimateGas` doesn't reflect — surface the
   * pre-resolved value to the popup so the fee preview is accurate.
   * Other chains return null and let the caller estimate themselves. */
  gasLimit: string | null;
}> {
  if (chainRequiresMlDsa(chainIdHex)) {
    const { result } = await sprintnetJsonRpc<{
      baseFeePerGas?: string[];
      gasUsedRatio?: number[];
      oldestBlock?: string;
      reward?: unknown[];
    }>("eth_feeHistory", ["0x1", "latest", []]);
    const baseList = Array.isArray(result?.baseFeePerGas) ? result.baseFeePerGas : [];
    if (baseList.length === 0) {
      throw new Error("eth_feeHistory returned no baseFeePerGas entries");
    }
    // Last entry is the next-block estimate when feeHistory returns the
    // pending base fee; with a single requested block we get two
    // entries (current + next).
    const baseHex = baseList[baseList.length - 1]!;
    const baseWei = BigInt(baseHex);
    const tipWei = BigInt(SPRINTNET_MIN_PRIORITY_FEE_HEX);
    return {
      baseFeePerGas: baseHex,
      maxPriorityFeePerGas: SPRINTNET_MIN_PRIORITY_FEE_HEX,
      maxFeePerGas: "0x" + (baseWei + tipWei).toString(16),
      gasLimit: SPRINTNET_TRANSFER_GAS_LIMIT_HEX,
    };
  }
  const provider = providerFor(chainIdHex);
  const gasPriceHex = await rpcSend<string>(provider, "eth_gasPrice", []);
  return {
    baseFeePerGas: gasPriceHex,
    maxPriorityFeePerGas: gasPriceHex,
    maxFeePerGas: gasPriceHex,
    gasLimit: null,
  };
}

// ---- internal popup messages ----

interface PopupMessage {
  kind: "popup";
  op: string;
  payload?: unknown;
}

interface SettledRpc<T> {
  value: T | null;
  error: string | null;
}

async function settleSprintnetRpc<T>(method: string, params: unknown[]): Promise<SettledRpc<T>> {
  try {
    const { result } = await sprintnetJsonRpc<T>(method, params);
    return { value: result, error: null };
  } catch (e) {
    return { value: null, error: (e as Error).message };
  }
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
      // Strategy A — v3 (ML-DSA-65) is the new primary vault. Detection
      // order: v3 first (current canonical shape), v2 next (still
      // unlockable for non-Sprintnet chains pending a v2→v3 migration
      // rule), v1 last (PBKDF2+AES-GCM, surfaced as legacy-only so the
      // popup nudges re-creation).
      //
      // `legacyVault` is the popup's banner trigger ("vault format
      // upgraded — re-import your seed"). It fires whenever any
      // non-current vault is on disk: v1 always, plus v2 once v3 is
      // the new primary or once we've deprecated v2.
      const v3Exists = await hasVaultV3();
      const v2Exists = await hasVault();
      const v1Exists = await hasLegacyVault();
      if (v3Exists) {
        return {
          hasVault: true,
          legacyVault: v1Exists || v2Exists,
          unlocked: isUnlockedV3(),
          address: getUnlockedAddressV3() ?? (await getStoredAddressV3()),
          custody: "sw" as const,
          algo: "mldsa" as const,
        };
      }
      // No v3 vault. If a v2 vault exists, the user can still unlock it
      // for legacy chains; the banner flips on so the home/onboarding
      // surface tells them v2 is the older format.
      return {
        hasVault: v2Exists,
        legacyVault: v1Exists || v2Exists,
        unlocked: isUnlocked(),
        address: getUnlockedAddress() ?? (await getStoredAddress()),
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
        official: !!n.official,
        active: id === session.chainId,
        ...(n.blockExplorer ? { blockExplorer: n.blockExplorer } : {}),
        ...(n.nativeCurrency ? { nativeCurrency: n.nativeCurrency } : {}),
      }));
    }
    case "wallet-active-chain": {
      return { ok: true, chainId: session.chainId };
    }
    case "wallet-set-active-chain": {
      // Popup-side chain switch. Mirrors `wallet_switchEthereumChain`'s
      // contract (validate against the known set, persist, broadcast
      // chainChanged) but is invoked through the popup IPC channel
      // rather than the dApp RPC channel.
      const p = message.payload as { chainId?: string };
      if (typeof p?.chainId !== "string") {
        return { ok: false, reason: "missing chainId" };
      }
      if (!lookupChain(p.chainId)) {
        return { ok: false, reason: "unknown chainId" };
      }
      session.chainId = canonicalChainKey(p.chainId);
      await persistActiveChainId(session.chainId);
      broadcastEvent("chainChanged", session.chainId);
      return { ok: true, chainId: session.chainId };
    }
    case "keystore-unlock": {
      const p = message.payload as { password: string };
      try {
        // Route to v3 when the v3 envelope is on disk; otherwise fall
        // through to legacy v2 unlock so a user with only an old vault
        // can still operate on non-Sprintnet chains.
        if (await hasVaultV3()) {
          const r = await unlockV3(p.password);
          return { ok: true, address: r.address };
        }
        const r = await unlockKeystore(p.password);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "keystore-lock": {
      // Lock both — no-op when one isn't unlocked.
      lockV3();
      lockKeystore();
      return { ok: true };
    }
    case "keystore-create-new": {
      // Strategy A — every new wallet from this point is v3 (ML-DSA-65).
      // PQM-1 is the canonical recovery format: 24 BIP-39 words carrying
      // the PQM-1 algo/version payload and 30 bytes of entropy.
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
    case "keystore-create-from-seedhex": {
      const p = message.payload as { password: string; seedHex: string };
      try {
        const r = await createVaultFromSeedHex(p.password, p.seedHex);
        return { ok: true, address: r.address };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-operator-status": {
      // Liveness probe for the popup's chain-status banner. We iterate
      // SPRINTNET_OPERATOR_RPCS and return the first that answers
      // `net_version` with the expected chain id (within a 1-second
      // per-host budget). Result is cached for 10s so a banner that
      // re-renders on every screen change doesn't hammer the chain.
      const now = Date.now();
      if (
        cachedOperator !== null &&
        now - cachedOperator.checkedAt < OPERATOR_CACHE_TTL_MS
      ) {
        return { ok: true, name: cachedOperator.name };
      }
      try {
        const hit = await probeFirstAliveOperator(undefined, 1_000);
        const name = hit?.name ?? null;
        cachedOperator = { name, checkedAt: now };
        return { ok: true, name };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-active-account": {
      // Surface the unlocked v3 keypair to the popup so Home can render
      // the real ML-DSA-65 address instead of the demo `mono1:…` placeholder.
      // Stays scoped to v3 — the legacy v2 keystore goes through the
      // existing demo-data path until the Networks list switch lands.
      if (!(await hasVaultV3())) {
        return { ok: false, reason: "no v3 vault" };
      }
      if (!isUnlockedV3()) {
        return { ok: false, reason: "locked" };
      }
      const address = getUnlockedAddressV3() ?? (await getStoredAddressV3());
      if (!address) {
        return { ok: false, reason: "v3 vault has no stored address" };
      }
      return {
        ok: true,
        address,
        algo: "mldsa" as const,
        custody: "sw" as const,
      };
    }
    case "wallet-balance": {
      // Read-only `eth_getBalance` for the popup Home balance pill.
      // Sprintnet routes through the operator-fallback helper from the
      // SDK-bundled registry; every other chain id flows through `providerFor` so user-added
      // chains via wallet_addEthereumChain just work.
      //
      // Sprintnet returns a NON-STANDARD `eth_getBalance` shape — instead
      // of `{ result: "0x..." }` it returns `{ result: { value: "0x...",
      // blockNumber, proof, stateRoot } }` so light clients can verify
      // the balance against `stateRoot`. We accept both shapes here:
      // `value` field for the proof variant, raw hex string for plain
      // chains. Other Sprintnet RPC methods stay standard.
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      try {
        if (chainRequiresMlDsa(p.chainIdHex)) {
          const { result } = await sprintnetJsonRpc<unknown>("eth_getBalance", [
            p.address,
            "latest",
          ]);
          console.log(
            "[wallet] balance shape:",
            typeof result === "string"
              ? "hex"
              : Object.keys((result as object | null) ?? {}).join(","),
          );
          if (typeof result === "string" && result.startsWith("0x")) {
            return { ok: true, balanceHex: result };
          }
          if (
            result !== null &&
            typeof result === "object" &&
            typeof (result as { value?: unknown }).value === "string" &&
            ((result as { value: string }).value).startsWith("0x")
          ) {
            return { ok: true, balanceHex: (result as { value: string }).value };
          }
          return { ok: false, reason: "unexpected balance shape" };
        }
        const provider = providerFor(p.chainIdHex);
        const balanceHex = await rpcSend<string>(provider, "eth_getBalance", [
          p.address,
          "latest",
        ]);
        return { ok: true, balanceHex };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-indexer-snapshot": {
      const p = message.payload as { address?: string; chainIdHex?: string };
      if (typeof p?.address !== "string" || typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing address or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        return { ok: false, reason: "indexer snapshot is only wired for Sprintnet today" };
      }
      const [tokenBalances, addressLabel, delegationHistory, addressActivity] = await Promise.all([
        settleSprintnetRpc<unknown[]>("lyth_getTokenBalances", [p.address]),
        settleSprintnetRpc<unknown | null>("lyth_getAddressLabel", [p.address]),
        settleSprintnetRpc<unknown[]>("lyth_getDelegationHistory", [p.address, 20]),
        settleSprintnetRpc<unknown[]>("lyth_getAddressActivity", [p.address, 30]),
      ]);
      const errors: Record<string, string> = {};
      if (tokenBalances.error) errors.tokenBalances = tokenBalances.error;
      if (addressLabel.error) errors.addressLabel = addressLabel.error;
      if (delegationHistory.error) errors.delegationHistory = delegationHistory.error;
      if (addressActivity.error) errors.addressActivity = addressActivity.error;
      return {
        ok: true,
        snapshot: {
          tokenBalances: Array.isArray(tokenBalances.value) ? tokenBalances.value : [],
          addressLabel: addressLabel.value ?? null,
          delegationHistory: Array.isArray(delegationHistory.value) ? delegationHistory.value : [],
          addressActivity: Array.isArray(addressActivity.value) ? addressActivity.value : [],
          errors,
        },
      };
    }
    case "wallet-fee-suggestion": {
      const p = message.payload as { chainIdHex?: string };
      if (typeof p?.chainIdHex !== "string") {
        return { ok: false, reason: "missing chainIdHex" };
      }
      try {
        const fee = await suggestFee(p.chainIdHex);
        return { ok: true, ...fee };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
    case "wallet-send-tx": {
      const p = message.payload as {
        to?: string;
        valueWeiHex?: string;
        chainIdHex?: string;
      };
      if (
        typeof p?.to !== "string" ||
        typeof p?.valueWeiHex !== "string" ||
        typeof p?.chainIdHex !== "string"
      ) {
        return { ok: false, reason: "missing to, valueWeiHex, or chainIdHex" };
      }
      if (!chainRequiresMlDsa(p.chainIdHex)) {
        // Real-send through the legacy secp256k1 path is not in scope yet —
        // the popup only wires Sprintnet for now. When non-Sprintnet send
        // lands it'll route through providerFor + signLegacyTx like the
        // existing `eth_sendTransaction` handler does.
        return { ok: false, reason: "send is only wired for Sprintnet today" };
      }
      if (!isUnlockedV3()) {
        return { ok: false, reason: "wallet locked" };
      }
      const fromAddr = getUnlockedAddressV3();
      if (!fromAddr) {
        return { ok: false, reason: "wallet has no unlocked address" };
      }
      try {
        const nonceRes = await sprintnetJsonRpc<string>(
          "eth_getTransactionCount",
          [fromAddr, "latest"],
        );
        const fee = await suggestFee(p.chainIdHex);
        // Sprintnet's mempool enforces an intrinsic-gas floor (~24309 as
        // of audit) that `eth_estimateGas` doesn't reflect — it returns
        // EVM execution gas only and ignores ML-DSA verify + envelope
        // decrypt + state proof overhead. Use the pre-resolved hex from
        // suggestFee instead. Falls back to 0x5208 if the suggestion
        // somehow returns null on the Sprintnet branch (shouldn't happen
        // — defensive).
        const gasHex = fee.gasLimit ?? "0x5208";
        const { txHash, via } = await submitEncryptedMlDsaTx({
          to: p.to,
          value: p.valueWeiHex,
          gas: gasHex,
          nonce: nonceRes.result,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          chainIdHex: p.chainIdHex,
        });
        return { ok: true, txHash, via };
      } catch (e) {
        const err = e as Error & { code?: number };
        const code = typeof err.code === "number" ? err.code : undefined;
        const reason = err.message ?? "send failed";
        if (code !== undefined) {
          return { ok: false, reason, code };
        }
        return { ok: false, reason };
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
