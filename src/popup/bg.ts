// Popup-side helpers for talking to the background service worker.
// All calls go through chrome.runtime.sendMessage with `{ kind: "popup", ... }`.

export type Custody = "tpm" | "passkey" | "hw" | "sw";
export type SignAlgo = "secp256k1" | "slhdsa" | "mldsa";

export interface KeystoreStatus {
  hasVault: boolean;
  unlocked: boolean;
  address: string | null;
  /**
   * Custody backend currently used by the keystore. Today this is always
   * `"sw"` (software-encrypted vault). The shape exists so future hardware /
   * passkey / TPM backends can flip the popup's chrome without UI rewrites.
   */
  custody: Custody;
  /** Signature algorithm. Only secp256k1 today. */
  algo: SignAlgo;
}

export type ApprovalKind =
  | "connect"
  | "personal_sign"
  | "typed_sign"
  | "send_tx"
  | "switch_chain"
  | "add_chain";

export interface SendTxView {
  estimatedGas: string | null;
  gasPrice: string | null;
  nonce: string | null;
  simulation:
    | null
    | { success: true; returnData: string }
    | { success: false; error: string };
  chainId: string;
  chainLabel: string;
}

export interface TypedDataEnvelope {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ConnectRequest {
  kind: "connect";
  origin: string;
}

export interface PersonalSignRequest {
  kind: "personal_sign";
  origin: string;
  message: string;
  address: string;
}

export interface TypedSignRequest {
  kind: "typed_sign";
  origin: string;
  address: string;
  rawTypedData: string;
  parsed: TypedDataEnvelope | null;
  digest: string | null;
}

export interface SendTxRequest {
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

export interface AddChainRequest {
  kind: "add_chain";
  origin: string;
  chain: {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    blockExplorerUrls?: string[];
    iconUrls?: string[];
    nativeCurrency?: { name: string; symbol: string; decimals: number };
  };
}

export interface SwitchChainRequest {
  kind: "switch_chain";
  origin: string;
  chainId: string;
}

export type ApprovalRequest =
  | ConnectRequest
  | PersonalSignRequest
  | TypedSignRequest
  | SendTxRequest
  | AddChainRequest
  | SwitchChainRequest;

export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  createdAt: number;
}

export interface ChainEntry {
  chainId: string;
  name: string;
  rpc: string;
  chainIdNum: number;
  builtin: boolean;
  active: boolean;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

function send<T>(op: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ kind: "popup", op, payload }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp as T);
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

export async function bgKeystoreStatus(): Promise<KeystoreStatus> {
  return send<KeystoreStatus>("keystore-status");
}

export async function bgKeystoreUnlock(
  password: string,
): Promise<{ ok: true; address: string } | { ok: false; reason?: string }> {
  return send("keystore-unlock", { password });
}

export async function bgKeystoreLock(): Promise<{ ok: boolean }> {
  return send("keystore-lock");
}

export async function bgKeystoreCreateNew(
  password: string,
): Promise<
  | { ok: true; mnemonic: string; address: string }
  | { ok: false; reason?: string }
> {
  return send("keystore-create-new", { password });
}

export async function bgKeystoreCreateFromMnemonic(
  password: string,
  mnemonic: string,
): Promise<{ ok: true; address: string } | { ok: false; reason?: string }> {
  return send("keystore-create-from-mnemonic", { password, mnemonic });
}

export async function bgListPending(): Promise<PendingApproval[]> {
  return send<PendingApproval[]>("list-pending");
}

export async function bgGetPending(id: string): Promise<PendingApproval | null> {
  return send<PendingApproval | null>("get-pending", { id });
}

export async function bgResolveApproval(
  id: string,
  decision: { ok: boolean; reason?: string },
): Promise<{ found: boolean }> {
  return send<{ found: boolean }>("resolve", { id, decision });
}

export async function bgChainList(): Promise<ChainEntry[]> {
  return send<ChainEntry[]>("chain-list");
}
