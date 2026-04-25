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

export type ApprovalKind =
  | "connect"
  | "personal_sign"
  | "send_tx"
  | "switch_chain";

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
}

export interface SwitchChainApprovalReq {
  kind: "switch_chain";
  origin: string;
  chainId: string;
}

export type ApprovalReq =
  | ConnectApprovalReq
  | PersonalSignApprovalReq
  | SendTxApprovalReq
  | SwitchChainApprovalReq;

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
const PENDING_STORAGE_KEY = "mono.pending-approvals";

async function persistPending(): Promise<void> {
  const list = listPending();
  return new Promise((res) => {
    chrome.storage.local.set({ [PENDING_STORAGE_KEY]: list }, () => res());
  });
}
