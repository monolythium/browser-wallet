// Monolythium Wallet — request approval bus.
//
// Lifecycle of a user-facing RPC request (eth_requestAccounts, personal_sign,
// eth_sendTransaction):
//
//   1. service-worker.ts handler calls `enqueue(...)` with the request shape.
//   2. We register a pending entry, open the extension popup window, and
//      return a promise that resolves with the user's decision.
//   3. The popup mounts, calls `getPendingApproval()` to read its job, renders
//      the matching Req screen, and finally calls `resolveApproval(id, decision)`
//      via chrome.runtime.sendMessage.
//   4. We dispatch the decision to the original promise so the dapp call returns.
//
// Why a popup window (chrome.windows.create) rather than just relying on the
// browser-action popup: the action popup is only visible if the user clicks the
// extension icon. Spawning a small dedicated window guarantees the dapp gets
// the user's eyeballs on the request, which is the EIP-1193 contract.

import { STORAGE_KEY_PENDING_APPROVALS } from "../shared/constants";

export type ApprovalKind =
  | "connect"
  | "personal_sign"
  | "typed_sign"
  | "send_tx"
  | "switch_chain"
  | "add_chain";

export interface ConnectApprovalReq {
  kind: "connect";
  origin: string;
}

export interface PersonalSignApprovalReq {
  kind: "personal_sign";
  origin: string;
  message: string; // raw input from dapp (utf8 or 0x-hex)
  address: string;
}

/** EIP-712 typed-data v4. The popup decodes / hashes for display. */
export interface TypedSignApprovalReq {
  kind: "typed_sign";
  origin: string;
  address: string;
  /**
   * The raw param the dapp sent. Either a JSON string (modern wallets pass a
   * string) or a pre-parsed object. We keep both so the popup can display the
   * source the dapp actually transmitted alongside the structured render.
   */
  rawTypedData: string;
  /** Best-effort parsed envelope: domain, types, primaryType, message. */
  parsed: TypedDataEnvelope | null;
  /** Hex-encoded EIP-712 digest the keystore will sign over, when computable. */
  digest: string | null;
}

export interface TypedDataEnvelope {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Pre-computed view of a send-tx request — populated by the service worker
 * before opening the popup so the approval screen can render real numbers
 * without making its own RPC calls (the popup has no RpcClient).
 */
export interface SendTxView {
  /** Estimated gas as a hex quantity, populated from `eth_estimateGas`. */
  estimatedGas: string | null;
  /** Node minimum gas price, hex quantity, from `eth_gasPrice`. */
  gasPrice: string | null;
  /** Sender's pending nonce, hex quantity. */
  nonce: string | null;
  /**
   * `eth_call` simulation result. `null` if the tx has no `data` (plain
   * transfer) or the simulation hasn't been attempted. `success: false`
   * captures revert reasons surfaced by the node.
   */
  simulation:
    | null
    | { success: true; returnData: string }
    | { success: false; error: string };
  /** Active chain id at enqueue time (hex), so the popup can show the right name. */
  chainId: string;
  /** Display-ready chain label resolved from KNOWN_CHAINS / user-added chains. */
  chainLabel: string;
}

export interface SendTxApprovalReq {
  kind: "send_tx";
  origin: string;
  tx: {
    from?: string;
    to?: string;
    value?: string;
    data?: string;
    gas?: string;
    gasPrice?: string;
    nonce?: string;
    chainId?: string;
  };
  view: SendTxView;
}

export interface SwitchChainApprovalReq {
  kind: "switch_chain";
  origin: string;
  chainId: string;
}

/** `wallet_addEthereumChain` parameter (EIP-3085). */
export interface AddChainSpec {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls?: string[];
  iconUrls?: string[];
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

export interface AddChainApprovalReq {
  kind: "add_chain";
  origin: string;
  chain: AddChainSpec;
}

export type ApprovalReq =
  | ConnectApprovalReq
  | PersonalSignApprovalReq
  | TypedSignApprovalReq
  | SendTxApprovalReq
  | SwitchChainApprovalReq
  | AddChainApprovalReq;

export interface PendingApproval {
  id: string;
  request: ApprovalReq;
  createdAt: number;
}

export type ApprovalDecision =
  | { ok: true }
  | { ok: false; reason?: string };

interface PendingResolver {
  approval: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  windowId?: number;
}

const pending = new Map<string, PendingResolver>();

function newId(): string {
  return (
    crypto.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

async function openApprovalWindow(approvalId: string): Promise<number | undefined> {
  if (!chrome.windows?.create) {
    // Fallback: in test environments without windows API, just open the popup.
    return undefined;
  }
  try {
    const url = chrome.runtime.getURL(
      `src/popup/index.html?approval=${encodeURIComponent(approvalId)}`,
    );
    const win = await chrome.windows.create({
      url,
      type: "popup",
      width: 380,
      height: 620,
      focused: true,
    });
    return win?.id;
  } catch (e) {
    console.warn("[Monolythium Wallet] failed to open approval window:", e);
    return undefined;
  }
}

/**
 * Enqueue a request, open the approval window, and resolve when the user acts.
 */
export function enqueue(request: ApprovalReq): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const approval: PendingApproval = {
      id: newId(),
      request,
      createdAt: Date.now(),
    };
    pending.set(approval.id, { approval, resolve });
    void persistPending();
    void openApprovalWindow(approval.id).then((winId) => {
      const entry = pending.get(approval.id);
      if (entry && winId != null) entry.windowId = winId;
    });
  });
}

/**
 * Snapshot of pending approvals for the popup to read.
 */
export function listPending(): PendingApproval[] {
  return Array.from(pending.values()).map((p) => p.approval);
}

export function getPending(id: string): PendingApproval | null {
  return pending.get(id)?.approval ?? null;
}

export function resolve(id: string, decision: ApprovalDecision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  void persistPending();
  if (entry.windowId != null && chrome.windows?.remove) {
    chrome.windows.remove(entry.windowId).catch(() => {
      /* user might already have closed it */
    });
  }
  entry.resolve(decision);
  return true;
}

/**
 * Treat a closed approval window as a reject (matches MetaMask semantics).
 */
export function rejectByWindow(windowId: number): void {
  for (const [id, entry] of pending.entries()) {
    if (entry.windowId === windowId) {
      pending.delete(id);
      void persistPending();
      entry.resolve({ ok: false, reason: "user closed approval window" });
    }
  }
}

// Mirror pending list to chrome.storage so the popup can read it before the
// background sends a message back. Service workers may sleep, but storage
// survives — popups read from storage, then resolve through the runtime
// message channel which wakes the worker.

async function persistPending(): Promise<void> {
  const list = listPending();
  return new Promise((res) => {
    chrome.storage.local.set({ [STORAGE_KEY_PENDING_APPROVALS]: list }, () => res());
  });
}

// Reconcile storage with in-memory state. Called at SW startup: when the
// worker sleeps and is revived by a new request, the in-memory `pending`
// Map is empty but storage still holds entries from the previous session
// whose Promise resolvers are dead. Without this, the popup would render
// zombie rows that never disappear and never respond to taps.
export async function clearPending(): Promise<void> {
  pending.clear();
  await new Promise<void>((res) => {
    chrome.storage.local.set({ [STORAGE_KEY_PENDING_APPROVALS]: [] }, () => res());
  });
}
