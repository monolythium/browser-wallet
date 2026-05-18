// Monolythium Wallet — ML-DSA-65 encrypted-submit bridge.
//
// Protocol-critical signing, native tx encoding, and encrypted-envelope
// construction live in `@monolythium/core-sdk/crypto`. This module keeps
// browser-wallet responsibilities local: translate EIP-1193 fields,
// iterate Sprintnet operator RPCs, and surface wallet-friendly errors.

import {
  buildEncryptedSubmission as sdkBuildEncryptedSubmission,
  type EncryptionKey,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { getUnlockedBackendV4 } from "./keystore-mldsa.js";
import { getActiveOperators } from "./networks.js";
// Phase 11.6 — `verifyOperatorGenesis` import dropped from this module
// because no call site invokes it (enforcement disabled). Re-add it to
// the import line above when restoring the GAP #11 guards below.

/** EIP-1193 `eth_sendTransaction` hex-quantity inputs this bridge accepts. */
export interface EthSendTxFields {
  to?: string;
  value?: string;
  data?: string;
  /** Gas limit (EIP-1193 calls this `gas`). */
  gas: string;
  nonce: string;
  /** Legacy single-fee field; mapped onto `maxFeePerGas` when 1559 fields are absent. */
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  /** Hex chain id of the target chain (e.g. `0x10F2C` for Sprintnet). */
  chainIdHex: string;
}

/** Chain response shape for `lyth_getEncryptionKey`. */
interface SprintnetEncryptionKeyJson {
  algo: string;
  epoch: number | string;
  encapsulationKey: string;
}

/** Decoded form of `lyth_getEncryptionKey` for downstream callers. */
export interface SprintnetEncryptionKey extends EncryptionKey {}

function hexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length % 2 !== 0) {
    throw new Error("hex must have even length");
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex byte");
    out[i] = b;
  }
  return out;
}

/**
 * Iterate the published Sprintnet operators in order, returning the
 * first one that produces a non-error JSON-RPC response. Transport-level
 * failures trigger fallback to the next operator; RPC-level rejections
 * propagate immediately because they are state-level consensus answers.
 */
export async function sprintnetJsonRpc<T>(
  method: string,
  params: unknown[],
): Promise<{ result: T; via: string }> {
  let lastTransportErr: Error | null = null;
  for (const v of getActiveOperators()) {
    // Phase 11.6 — genesis-hash enforcement disabled for Beta. The wallet
    // accepts any operator regardless of block-0 hash, enabling val-1
    // (192.0.2.7) pre-regenesis orphan and other non-canonical
    // operators while Sprintnet ferveo rollout is in flight. Re-enable
    // for mainnet by restoring the throw below:
    // if (!(await verifyOperatorGenesis(v.rpc))) {
    //   lastTransportErr = new Error(`${v.name}: untrusted genesis`);
    //   continue;
    // }
    let res: Response;
    try {
      res = await fetch(v.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      lastTransportErr = e as Error;
      continue;
    }
    if (!res.ok) {
      lastTransportErr = new Error(`HTTP ${res.status} from ${v.name}`);
      continue;
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (body.error) {
      const err = new Error(body.error.message ?? `rpc error from ${v.name}`) as Error & {
        code?: number;
        via?: string;
        method?: string;
      };
      if (typeof body.error.code === "number") err.code = body.error.code;
      err.via = v.name;
      err.method = method;
      throw err;
    }
    if (body.result === undefined) {
      lastTransportErr = new Error(`empty result body from ${v.name}`);
      continue;
    }
    return { result: body.result, via: v.name };
  }
  throw lastTransportErr ?? new Error("no Sprintnet operator reachable");
}

/**
 * Result of `sprintnetMaxBalanceConsensus`. `contributing` and `failing`
 * sum to the active-operator-list length; the consensus value is the
 * MAX across `contributing`.
 */
export interface BalanceConsensusResult {
  /** Max balance across responding operators, hex-quantity. */
  balanceHex: string;
  /** Operators that returned a valid balance envelope. */
  contributing: ReadonlyArray<{ name: string; balanceHex: string }>;
  /** Operators that didn't contribute, with one-line reason each. */
  failing: ReadonlyArray<{ name: string; reason: string }>;
}

/** Per-operator timeout for the parallel balance probe. */
const BALANCE_CONSENSUS_TIMEOUT_MS = 5_000;

/** Accept both the proof-envelope shape `{ value, blockNumber, proof,
 *  stateRoot }` and the plain hex-string shape; reject everything else.
 *
 *  SDK contract: AccountProofResponse (binding, not top-level exported)
 *    @ mono-core-sdk 0fd8a79.
 *  Strict shape: `{ value, state_root, block_number, proof? }`.
 *
 *  Wire-vs-binding case mismatch (intentional, observed Phase 7.1): the
 *  chain serializer emits camelCase (`stateRoot`, `blockNumber`) even
 *  though the ts-rs binding annotates snake_case. The wallet's parser
 *  only reads `.value`, so the case mismatch doesn't affect balance
 *  reads — but downstream callers that need the proof envelope's other
 *  fields should consult the live wire form, not the binding annotations.
 *
 *  Resilience posture (Phase 7.1 commit 7): keep the dual-shape accept —
 *  rejecting only when neither `value: 0x…` nor plain `0x…` is present.
 *  Operators on a future binary that drops the envelope wrapper in
 *  favour of bare hex (or vice versa) keep working without a wallet
 *  bump. */
function parseBalanceFromRpcResult(result: unknown): string | null {
  if (typeof result === "string" && result.startsWith("0x")) {
    return result;
  }
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as { value?: unknown }).value === "string" &&
    (result as { value: string }).value.startsWith("0x")
  ) {
    return (result as { value: string }).value;
  }
  return null;
}

/**
 * Query every active Sprintnet operator in parallel for `eth_getBalance`
 * and return the MAX value across responses.
 *
 * Operators may briefly lag behind each other after a regenesis or
 * binary rollout. The single-operator-with-failover pattern in
 * `sprintnetJsonRpc` latches onto the first responder, which for
 * balance reads can be a stale `0x0` envelope that hides the correct
 * value reported by other operators (observed 2026-05-15:
 * 192.0.2.1 returned `0x0` for a freshly funded address while
 * other operators returned the correct `0x16345785d8a0000`).
 *
 * Max() is safe specifically for balance because balance grows
 * monotonically until a tx spends from the address — a lagging
 * operator can only under-report, never over-report. Do NOT
 * generalize this to `eth_call`, nonce, fee, or indexer methods,
 * where max() is not meaningful; those keep `sprintnetJsonRpc`
 * first-responder semantics.
 */
export async function sprintnetMaxBalanceConsensus(
  address: string,
): Promise<BalanceConsensusResult> {
  const operators = getActiveOperators();
  if (operators.length === 0) {
    throw new Error("no Sprintnet operators configured");
  }

  const probes = operators.map(async (op) => {
    // Phase 11.6 — genesis-hash filter disabled (see sprintnetJsonRpc).
    // All operators are probed regardless of block-0 hash. Re-enable for
    // mainnet by restoring the early-return below:
    // if (!(await verifyOperatorGenesis(op.rpc))) {
    //   return { name: op.name, balanceHex: null, reason: "untrusted genesis" };
    // }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BALANCE_CONSENSUS_TIMEOUT_MS);
    try {
      const res = await fetch(op.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { name: op.name, balanceHex: null, reason: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (body.error) {
        return {
          name: op.name,
          balanceHex: null,
          reason: body.error.message ?? "rpc error",
        };
      }
      const parsed = parseBalanceFromRpcResult(body.result);
      if (parsed === null) {
        return { name: op.name, balanceHex: null, reason: "malformed shape" };
      }
      return { name: op.name, balanceHex: parsed, reason: null };
    } catch (e) {
      const err = e as Error;
      return {
        name: op.name,
        balanceHex: null,
        reason: err.name === "AbortError" ? "timeout" : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  const responses = await Promise.all(probes);
  const contributing: Array<{ name: string; balanceHex: string; value: bigint }> = [];
  const failing: Array<{ name: string; reason: string }> = [];
  for (const r of responses) {
    if (r.balanceHex === null) {
      failing.push({ name: r.name, reason: r.reason ?? "unknown" });
      continue;
    }
    try {
      contributing.push({
        name: r.name,
        balanceHex: r.balanceHex,
        value: BigInt(r.balanceHex),
      });
    } catch {
      failing.push({ name: r.name, reason: "invalid bigint hex" });
    }
  }

  if (contributing.length === 0) {
    const summary = failing.map((f) => `${f.name}: ${f.reason}`).join("; ");
    throw new Error(
      `all ${operators.length} Sprintnet operators failed eth_getBalance: ${summary}`,
    );
  }

  let max = contributing[0]!;
  for (let i = 1; i < contributing.length; i++) {
    if (contributing[i]!.value > max.value) max = contributing[i]!;
  }

  return {
    balanceHex: max.balanceHex,
    contributing: contributing.map((c) => ({ name: c.name, balanceHex: c.balanceHex })),
    failing,
  };
}

/** Fetch the cluster's current ML-KEM-768 encapsulation key. */
export async function fetchSprintnetEncryptionKey(): Promise<SprintnetEncryptionKey> {
  const { result } = await sprintnetJsonRpc<SprintnetEncryptionKeyJson>(
    "lyth_getEncryptionKey",
    [],
  );
  if (typeof result?.encapsulationKey !== "string") {
    throw new Error("lyth_getEncryptionKey: missing encapsulationKey");
  }
  const epoch =
    typeof result.epoch === "string"
      ? BigInt(result.epoch.startsWith("0x") ? result.epoch : result.epoch)
      : BigInt(result.epoch);
  return {
    algo: typeof result.algo === "string" ? result.algo : "ml-kem-768",
    epoch,
    encapsulationKey: hexToBytes(result.encapsulationKey),
  };
}

function normalizeFields(req: EthSendTxFields): NativeEvmTxFields {
  const maxFeePerGas = req.maxFeePerGas ?? req.gasPrice;
  if (maxFeePerGas === undefined) throw new Error("maxFeePerGas/gasPrice missing");
  return {
    chainId: req.chainIdHex,
    nonce: req.nonce,
    gasLimit: req.gas,
    maxFeePerGas,
    maxPriorityFeePerGas: req.maxPriorityFeePerGas ?? maxFeePerGas,
    to: req.to ?? null,
    value: req.value ?? "0x0",
    input: req.data ?? "0x",
  };
}

/**
 * Sign + wrap an `eth_sendTransaction` into an encrypted envelope ready
 * for `lyth_submitEncrypted`.
 */
export async function buildEncryptedSubmission(args: {
  txReq: EthSendTxFields;
  encryptionKey: SprintnetEncryptionKey;
}): Promise<{
  envelopeWireHex: string;
  innerSighashHex: string;
  innerWireBytes: number;
}> {
  const backend = getUnlockedBackendV4();
  if (backend === null) {
    throw new Error("v3 wallet is locked");
  }
  return sdkBuildEncryptedSubmission({
    backend,
    tx: normalizeFields(args.txReq),
    encryptionKey: args.encryptionKey,
  });
}

/** Submit an encrypted-envelope hex blob via `lyth_submitEncrypted`. */
export async function broadcastEncryptedEnvelope(envelopeWireHex: string): Promise<{
  txHash: string;
  via: string;
}> {
  const { result, via } = await sprintnetJsonRpc<string>(
    "lyth_submitEncrypted",
    [envelopeWireHex],
  );
  return { txHash: result, via };
}

/** One-shot helper used by the service worker. */
export async function submitEncryptedMlDsaTx(req: EthSendTxFields): Promise<{
  txHash: string;
  via: string;
  innerSighashHex: string;
}> {
  const encryptionKey = await fetchSprintnetEncryptionKey();
  const wrapped = await buildEncryptedSubmission({ txReq: req, encryptionKey });
  const { txHash, via } = await broadcastEncryptedEnvelope(wrapped.envelopeWireHex);
  return { txHash, via, innerSighashHex: wrapped.innerSighashHex };
}
