// Monolythium Wallet — ML-DSA-65 encrypted-submit bridge.
//
// Protocol-critical signing, native tx encoding, and encrypted-envelope
// construction live in `@monolythium/core-sdk/crypto`. This module keeps
// browser-wallet responsibilities local: translate EIP-1193 fields,
// iterate Sprintnet operator RPCs, and surface wallet-friendly errors.

import {
  buildEncryptedSubmission as sdkBuildEncryptedSubmission,
  buildPlaintextSubmission as sdkBuildPlaintextSubmission,
  type EncryptionKey,
  type MempoolClass,
  type NativeEvmTxFields,
  type NativeTxExtensionLike,
} from "@monolythium/core-sdk/crypto";
import { getUnlockedBackendV4 } from "./keystore-mldsa.js";
import { getActiveOperators, verifyOperatorGenesis } from "./networks.js";

/** EIP-1193 `eth_sendTransaction` hex-quantity inputs this bridge accepts. */
export interface EthSendTxFields {
  to?: string;
  value?: string;
  data?: string;
  /** Execution-unit limit (EIP-1193 calls this `gas`). */
  gas: string;
  nonce: string;
  /** Legacy single-fee field; mapped onto `maxFeePerGas` when 1559 fields are absent. */
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  /** Optional encrypted-mempool class override for protocol-owned action plans. */
  mempoolClass?: MempoolClass;
  /** Alias accepted from SDK transaction plans that mirror the encrypted envelope field. */
  class?: MempoolClass;
  /** Optional native typed transaction extensions, used by MRV v1 deploy/call. */
  extensions?: readonly NativeTxExtensionLike[];
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
  opts?: { timeoutMs?: number },
): Promise<{ result: T; via: string }> {
  let lastTransportErr: Error | null = null;
  // Round 13 TASK 3 — track genesis-pin failures separately so the
  // aggregate error message is informative when ALL operators are
  // rejected for untrusted genesis. Previously the user saw the
  // last-tried operator's error ("operator-1: untrusted genesis"),
  // which read as a single-operator transient failure even though
  // every operator in the list was being skipped. The clearer
  // aggregate "chain genesis mismatch (all N operators)" tells the
  // user this is a chain-side issue (operator binaries stale, or
  // a regenesis the wallet pin hasn't been bumped for) rather than
  // a wallet bug.
  let untrustedCount = 0;
  let totalOperators = 0;
  for (const v of getActiveOperators()) {
    totalOperators++;
    // GAP #11: genesis-hash pin. Operators whose block 0 doesn't match
    // SPRINTNET_GENESIS_HASH are skipped — they're either on a fork or
    // a different chain entirely, and routing any request to them
    // leaks reads / writes onto an untrusted ledger.
    if (!(await verifyOperatorGenesis(v.rpc))) {
      untrustedCount++;
      lastTransportErr = new Error(`${v.name}: untrusted genesis`);
      continue;
    }
    let res: Response;
    // GAP-N1 — optional per-call timeout (mirrors the balance-probe
    // AbortController pattern below). Default (no timeoutMs) is unchanged:
    // no AbortController, no signal — every existing caller is byte-identical.
    const ctrl = opts?.timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts!.timeoutMs) : null;
    try {
      res = await fetch(v.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (e) {
      // A timeout surfaces here as an AbortError → treated like any transport
      // failure: record it and fall through to the next operator.
      lastTransportErr = e as Error;
      continue;
    } finally {
      if (timer !== null) clearTimeout(timer);
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
  // Round 13 TASK 3 — if EVERY operator failed the genesis pin check,
  // surface a clearer aggregate error instead of the last-operator's
  // raw "name: untrusted genesis" message. See About → Operators for
  // per-operator status the user can act on.
  if (untrustedCount > 0 && untrustedCount === totalOperators) {
    throw new Error(
      `Chain genesis mismatch — all ${totalOperators} operators reported untrusted block 0. The chain may have undergone a regenesis since the wallet's pin was last updated, or operator binaries are stale. See About → Operators.`,
    );
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
    // GAP #11: skip operators whose block 0 doesn't match our pin.
    // Treated as a "failing" entry so the consensus result still
    // reports the skipped operator's name and reason — distinct from
    // a network error, and visible in the SW console balance log.
    if (!(await verifyOperatorGenesis(op.rpc))) {
      return { name: op.name, balanceHex: null, reason: "untrusted genesis" };
    }
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
    ...(req.extensions !== undefined ? { extensions: req.extensions } : {}),
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
  innerTxHashHex: string;
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
    ...(args.txReq.mempoolClass !== undefined || args.txReq.class !== undefined
      ? { class: args.txReq.mempoolClass ?? args.txReq.class }
      : {}),
  });
}

/** Submit an encrypted-envelope hex blob via `lyth_submitEncrypted`. The RPC
 *  returns the pre-decryption ENVELOPE/submission hash, NOT the canonical
 *  inner-tx hash the chain indexes after Ferveo decryption — so it is named
 *  `submissionHash` and must never be surfaced as the displayed tx hash. */
export async function broadcastEncryptedEnvelope(envelopeWireHex: string): Promise<{
  submissionHash: string;
  via: string;
}> {
  const { result, via } = await sprintnetJsonRpc<string>(
    "lyth_submitEncrypted",
    [envelopeWireHex],
  );
  return { submissionHash: result, via };
}

/** One-shot helper used by the service worker. `txHash` is the CANONICAL
 *  inner-tx hash (`signed.txHash`, surfaced by the SDK as `innerTxHashHex`) —
 *  the value the chain indexes and `eth_getTransactionByHash` / `lyth_txStatus`
 *  resolve. `submissionHash` is the pre-decryption envelope hash from
 *  `lyth_submitEncrypted`, retained for debugging/logging only. */
export async function submitEncryptedMlDsaTx(req: EthSendTxFields): Promise<{
  txHash: string;
  submissionHash: string;
  via: string;
  innerSighashHex: string;
}> {
  const encryptionKey = await fetchSprintnetEncryptionKey();
  const wrapped = await buildEncryptedSubmission({ txReq: req, encryptionKey });
  const { submissionHash, via } = await broadcastEncryptedEnvelope(wrapped.envelopeWireHex);
  return {
    txHash: wrapped.innerTxHashHex,
    submissionHash,
    via,
    innerSighashHex: wrapped.innerSighashHex,
  };
}

// ----- Plaintext (default) submission path -----
//
// The live optional-encryption testnet runs with `encrypted_mempool_required
// = false`, so the FUNCTIONAL inclusion path is the PLAINTEXT one: the wallet
// signs the chain-side `SignedTransaction` (no Ferveo threshold-decrypt step)
// and forwards the bincode bytes through `mesh_submitTx`. The encrypted
// `lyth_submitEncrypted` path above engages the threshold-encrypted inclusion
// pipeline, which is NOT live yet — so it stays behind a default-off PREVIEW
// toggle, and plaintext is what every wallet flow submits by default.
//
// We do NOT route through the SDK's `submitTransactionWithPrivacy` /
// `submitPlaintextTransaction` RpcClient helpers here: the wallet's
// operator-iteration in `sprintnetJsonRpc` carries the GAP #11 genesis-hash
// pin + multi-operator failover that protect every wallet RPC. Reusing it for
// `mesh_submitTx` keeps the plaintext path under the same protections as the
// encrypted path, while still using the SDK's `buildPlaintextSubmission` for
// the protocol-critical sign + bincode serialization (the bytes are byte-for-
// byte what `submitPlaintextTransaction` would send). We mirror the SDK's
// node-echo validation: the node returns the canonical 32-byte native tx hash
// on admission, and any mismatch is rejected loud so the wallet never trusts a
// hash it did not derive itself.

/** Build a PLAINTEXT submission — the opt-OUT-of-privacy counterpart to
 *  `buildEncryptedSubmission`. Signs over the canonical chain-side sighash with
 *  the unlocked ML-DSA-65 backend and bincode-serializes the result; never
 *  engages the Ferveo threshold-decrypt pipeline. */
export async function buildPlaintextSubmission(args: {
  txReq: EthSendTxFields;
}): Promise<{
  signedTxWireHex: string;
  innerSighashHex: string;
  innerTxHashHex: string;
  innerWireBytes: number;
}> {
  const backend = getUnlockedBackendV4();
  if (backend === null) {
    throw new Error("v3 wallet is locked");
  }
  return sdkBuildPlaintextSubmission({
    backend,
    tx: normalizeFields(args.txReq),
  });
}

/** Submit a bincode-encoded chain-side `SignedTransaction` (`0x`-hex) through
 *  the plaintext `mesh_submitTx` path and validate the node's echoed canonical
 *  tx hash against the locally computed one. Mirrors the validation in the
 *  SDK's `submitPlaintextTransaction`: the node echoes the 32-byte canonical
 *  native tx hash on admission; any mismatch (or non-32-byte response) is
 *  rejected so a wallet never trusts a hash it did not derive itself. */
export async function broadcastPlaintextTransaction(
  signedTxWireHex: string,
  expectedTxHashHex: string,
): Promise<{ txHash: string; via: string }> {
  const { result, via } = await sprintnetJsonRpc<string>("mesh_submitTx", [
    signedTxWireHex,
  ]);
  const echoed = typeof result === "string" ? result.toLowerCase() : "";
  const expected = expectedTxHashHex.toLowerCase();
  // A canonical tx hash is 32 bytes -> "0x" + 64 hex chars.
  if (!/^0x[0-9a-f]{64}$/.test(echoed)) {
    throw new Error(
      `mesh_submitTx returned a non-canonical tx hash (${result}); refusing to trust it`,
    );
  }
  if (echoed !== expected) {
    throw new Error(
      `mesh_submitTx echoed tx hash ${echoed} does not match locally computed ${expected}`,
    );
  }
  return { txHash: expectedTxHashHex, via };
}

/** One-shot PLAINTEXT helper used by the service worker — the default tx path
 *  on the live optional-encryption chain. `txHash` is the CANONICAL inner-tx
 *  hash the chain indexes (`eth_getTransactionByHash` / `lyth_txStatus`
 *  resolve it), validated against the node echo before it is surfaced. */
export async function submitPlaintextMlDsaTx(req: EthSendTxFields): Promise<{
  txHash: string;
  via: string;
  innerSighashHex: string;
}> {
  const built = await buildPlaintextSubmission({ txReq: req });
  const { txHash, via } = await broadcastPlaintextTransaction(
    built.signedTxWireHex,
    built.innerTxHashHex,
  );
  return { txHash, via, innerSighashHex: built.innerSighashHex };
}
