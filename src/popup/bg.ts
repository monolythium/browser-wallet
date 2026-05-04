// Popup-side helpers for talking to the background service worker.
// All calls go through chrome.runtime.sendMessage with `{ kind: "popup", ... }`.

export type Custody = "tpm" | "passkey" | "hw" | "sw";
export type SignAlgo = "secp256k1" | "slhdsa" | "mldsa";

export interface KeystoreStatus {
  hasVault: boolean;
  /**
   * `true` when a legacy v1 (PBKDF2+AES-GCM) envelope is on disk. The popup
   * surfaces a "vault format upgraded — re-import your seed" notice on the
   * onboarding screen so the user knows their old keystore is no longer
   * usable. Per the v1→v2 ethos there is no silent re-encryption.
   */
  legacyVault: boolean;
  unlocked: boolean;
  address: string | null;
  /**
   * Custody backend currently used by the keystore. Today this is always
   * `"sw"` (software-encrypted vault). The shape exists so future hardware /
   * passkey / TPM backends can flip the popup's chrome without UI rewrites.
   */
  custody: Custody;
  /** Signature algorithm currently active. `"mldsa"` once a v3 vault is
   * the primary; `"secp256k1"` while a legacy v2 vault is the only one
   * on disk. The `"slhdsa"` slot was reserved for a SLH-DSA pilot that
   * was retired in favour of ML-DSA-65 — kept in the union so the
   * Settings panel's pre-PQ fallback render path still typechecks. */
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
  /** True for Foundation-attested official chains (Sprintnet today).
   * Surfaces the "Official" badge on the Networks screen; user-added
   * chains via `wallet_addEthereumChain` are always `false`. */
  official?: boolean;
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
): Promise<
  | { ok: true; address: string }
  | {
      ok: false;
      reason?: "wrong_password" | "rate_limited" | string;
      secondsRemaining?: number;
      failCount?: number;
    }
> {
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

export async function bgKeystoreImportFromSeedHex(
  password: string,
  seedHex: string,
): Promise<{ ok: true; address: string } | { ok: false; reason?: string }> {
  return send("keystore-create-from-seedhex", { password, seedHex });
}

/**
 * Real account state surfaced to the popup so Home can render the
 * unlocked v3 wallet's address instead of the demo `mono1:…` placeholder.
 * Mirrors the shape the service worker returns from "wallet-active-account".
 */
export interface ActiveAccount {
  /** EVM-style hex address (`0x` + 40 hex chars). */
  address: string;
  algo: SignAlgo;
  custody: Custody;
}

export async function bgWalletActiveAccount(): Promise<
  { ok: true; account: ActiveAccount } | { ok: false; reason?: string }
> {
  // The IPC handler returns the account fields inline rather than nested.
  // Reshape here so callers can keep `r.account.address` etc.
  type Reply =
    | { ok: true; address: string; algo: SignAlgo; custody: Custody }
    | { ok: false; reason?: string };
  const r = await send<Reply>("wallet-active-account");
  if (!r.ok) return r;
  return {
    ok: true,
    account: { address: r.address, algo: r.algo, custody: r.custody },
  };
}

export async function bgWalletBalance(
  address: string,
  chainIdHex: string,
): Promise<{ ok: true; balanceHex: string } | { ok: false; reason?: string }> {
  return send("wallet-balance", { address, chainIdHex });
}

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
}

export interface WalletAddressLabel {
  address: string;
  category: string;
  displayName: string | null;
  updatedAtBlock: number;
}

export interface WalletDelegationHistoryRow {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  wallet: string;
  cluster: number;
  toCluster: number | null;
  kind: string;
  weightBps: number;
  walletTotalBps: number | null;
}

export interface WalletAddressActivityRow {
  blockHeight: number;
  txIndex: number;
  logIndex: number;
  kind: string;
  direction: "in" | "out" | null;
  counterparty: string | null;
  tokenId: string | null;
  amount: string | null;
  cluster: number | null;
  weightBps: number | null;
  subKind: string | null;
}

export interface WalletIndexerSnapshot {
  tokenBalances: WalletTokenBalance[];
  addressLabel: WalletAddressLabel | null;
  delegationHistory: WalletDelegationHistoryRow[];
  addressActivity: WalletAddressActivityRow[];
  errors: Partial<Record<"tokenBalances" | "addressLabel" | "delegationHistory" | "addressActivity", string>>;
}

export async function bgWalletIndexerSnapshot(
  address: string,
  chainIdHex: string,
): Promise<{ ok: true; snapshot: WalletIndexerSnapshot } | { ok: false; reason?: string }> {
  return send("wallet-indexer-snapshot", { address, chainIdHex });
}

/** Fee strategy returned by `bgWalletFeeSuggestion`. */
export interface FeeSuggestion {
  /** Hex wei — sender's tip target (the only revenue path on Sprintnet). */
  maxPriorityFeePerGas: string;
  /** Hex wei — hard cap (priority + base). */
  maxFeePerGas: string;
  /** Hex wei — current/next-block base fee. Surfaced for the UI fee preview. */
  baseFeePerGas: string;
  /** Hex gas-limit recommendation. Non-null on Sprintnet (the chain has
   * an intrinsic floor `eth_estimateGas` doesn't report); null on other
   * chains where the popup should estimate itself if needed. */
  gasLimit: string | null;
}

/** Tx hash + diagnostic operator id from `bgWalletSendTx`. */
export interface SendTxResult {
  txHash: string;
  via: string;
}

export async function bgWalletFeeSuggestion(
  chainIdHex: string,
): Promise<{ ok: true; suggestion: FeeSuggestion } | { ok: false; reason?: string }> {
  // The IPC handler returns the fee fields inline; reshape for callers.
  type Reply =
    | ({ ok: true } & FeeSuggestion)
    | { ok: false; reason?: string };
  const r = await send<Reply>("wallet-fee-suggestion", { chainIdHex });
  if (!r.ok) return r;
  return {
    ok: true,
    suggestion: {
      maxPriorityFeePerGas: r.maxPriorityFeePerGas,
      maxFeePerGas: r.maxFeePerGas,
      baseFeePerGas: r.baseFeePerGas,
      gasLimit: r.gasLimit,
    },
  };
}

/**
 * Read the active chain id from chrome.storage. Returns the Sprintnet
 * default (`0x10F2C`) when nothing is stored yet (first launch) or when
 * the stored id no longer maps to a known chain.
 */
export async function bgWalletActiveChain(): Promise<
  { ok: true; chainId: string } | { ok: false; reason?: string }
> {
  return send("wallet-active-chain");
}

/**
 * Switch the active chain. Mirrors `wallet_switchEthereumChain` (validate,
 * persist, broadcast `chainChanged`) but is invoked through the popup IPC
 * channel rather than the dApp RPC channel.
 */
export async function bgWalletSetActiveChain(
  chainId: string,
): Promise<{ ok: true; chainId: string } | { ok: false; reason?: string }> {
  return send("wallet-set-active-chain", { chainId });
}

/**
 * Probe the published Sprintnet operators and report which one answered
 * (or `null` if none did within budget). Backs the chain-status banner;
 * the service worker caches the answer for 10s, so it's safe to call on
 * every popup tick.
 */
export async function bgWalletOperatorStatus(): Promise<
  { ok: true; name: string | null } | { ok: false; reason?: string }
> {
  return send("wallet-operator-status");
}

export async function bgWalletSendTx(args: {
  to: string;
  valueWeiHex: string;
  chainIdHex: string;
}): Promise<
  { ok: true; result: SendTxResult }
  | { ok: false; reason?: string; code?: number }
> {
  type Reply =
    | { ok: true; txHash: string; via: string }
    | { ok: false; reason?: string; code?: number };
  const r = await send<Reply>("wallet-send-tx", args);
  if (!r.ok) return r;
  return { ok: true, result: { txHash: r.txHash, via: r.via } };
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

export async function bgGetAutoLockMinutes(): Promise<{
  autoLockMinutes: number;
  options: readonly number[];
}> {
  return send("get-auto-lock-minutes");
}

export async function bgSetAutoLockMinutes(
  minutes: number,
): Promise<
  | { ok: true; autoLockMinutes: number }
  | { ok: false; reason?: string }
> {
  return send("set-auto-lock-minutes", { minutes });
}
