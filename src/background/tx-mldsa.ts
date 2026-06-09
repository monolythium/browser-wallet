// Monolythium Wallet — ML-DSA-65 transaction submission bridge.
//
// Protocol-critical signing + native tx encoding live in
// `@monolythium/core-sdk/crypto`. This module keeps browser-wallet
// responsibilities local: translate EIP-1193 fields, iterate testnet
// operator RPCs, and surface wallet-friendly errors.

import {
  buildEncryptedSubmission as sdkBuildEncryptedSubmission,
  buildPlaintextSubmission as sdkBuildPlaintextSubmission,
  parseClusterSealKeys,
  type ClusterSealKeys,
  type ClusterSealKeysSource,
  type NativeEvmTxFields,
  type NativeTxExtensionLike,
} from "@monolythium/core-sdk/crypto";
import { getUnlockedBackendV4 } from "./keystore-mldsa.js";
import { getActiveOperators, verifyOperatorGenesis } from "./networks.js";
import { isWithinSaneBound } from "../shared/operator-bounds.js";

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
  /** Optional native typed transaction extensions, used by MRV v1 deploy/call. */
  extensions?: readonly NativeTxExtensionLike[];
  /** Hex chain id of the target chain (e.g. `0x10F2C` for the testnet). */
  chainIdHex: string;
}

/**
 * Iterate the published testnet operators in order, returning the
 * first one that produces a non-error JSON-RPC response. Transport-level
 * failures trigger fallback to the next operator; RPC-level rejections
 * propagate immediately because they are state-level consensus answers.
 */
export async function testnetJsonRpc<T>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number },
): Promise<{ result: T; via: string }> {
  let lastTransportErr: Error | null = null;
  // Track genesis-pin failures separately so the
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
    // GAP #11: genesis-hash pin. Operators whose chain identity doesn't
    // match TESTNET_GENESIS_HASH are skipped — they're either on a fork
    // or a different chain entirely, and routing any request to them
    // leaks reads / writes onto an untrusted ledger.
    if (!(await verifyOperatorGenesis(v.rpc))) {
      untrustedCount++;
      lastTransportErr = new Error(`${v.name}: untrusted genesis`);
      continue;
    }
    let res: Response;
    // Optional per-call timeout (mirrors the balance-probe
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
  // If EVERY operator failed the genesis pin check,
  // surface a clearer aggregate error instead of the last-operator's
  // raw "name: untrusted genesis" message. See Operators for
  // per-operator status the user can act on.
  if (untrustedCount > 0 && untrustedCount === totalOperators) {
    throw new Error(
      `Chain genesis mismatch — all ${totalOperators} operators reported untrusted genesis. The chain may have undergone a regenesis since the wallet's pin was last updated, or operator binaries are stale. See Operators.`,
    );
  }
  throw lastTransportErr ?? new Error("no Monolythium Testnet operator reachable");
}

/**
 * Result of `testnetMaxBalanceConsensus`. `contributing` and `failing`
 * sum to the active-operator-list length; the consensus value is the
 * MAX across `contributing`.
 */
export interface BalanceConsensusResult {
  /** Max balance across responding operators, hex-quantity. Used for the
   *  DISPLAY balance (a lagging operator can only under-report, never over). */
  balanceHex: string;
  /** LOWEST balance across responding operators, hex-quantity (T4-03, Item C).
   *  Spend gates (Send Max / insufficient-funds) use this so a single
   *  inflating operator cannot enable an unaffordable Max. Equals `balanceHex`
   *  when only one operator contributed (the default single-operator config). */
  spendGuardHex: string;
  /** Operators that returned a valid balance envelope. */
  contributing: ReadonlyArray<{ name: string; balanceHex: string }>;
  /** Operators that didn't contribute, with one-line reason each. */
  failing: ReadonlyArray<{ name: string; reason: string }>;
}

/** Per-operator timeout for the parallel balance probe. */
const BALANCE_CONSENSUS_TIMEOUT_MS = 5_000;

/**
 * T4-03 (Item C) — absolute sane upper bound on a single-account balance, in
 * lythoshi. The chain's genesis supply is 100,000,000 LYTH = 10^26 lythoshi
 * (whitepaper §16.1), and the 8%/yr inflation cap means supply grows only
 * slowly (burn trends it deflationary), so no single address can ever hold
 * more than total supply. A generous 2x-supply ceiling is the "physically
 * impossible" line: a reported balance above it can only come from a lying or
 * buggy operator, so its entry is DROPPED rather than allowed to win the MAX
 * reduce. A de-trust rail, NOT an economic claim. Shared sane-bound primitive
 * with the fee ceiling (Item D) via `operator-bounds`.
 *
 * UNIT NOTE: this value is in 18-decimal lythoshi (1 LYTH = 10^18 lythoshi) and
 * MUST track the native decimal domain. The original 8-decimal-era value
 * (2 x 10^16 = 0.02 LYTH) survived the 18-decimal migration unchanged, so it
 * silently DROPPED every real balance (anything above 0.02 LYTH) as "exceeds
 * total supply" — leaving `contributing` empty, throwing the consensus, and
 * stranding the entire balance UI (Home/Send/Stake) on "loading" indefinitely.
 * See balance-consensus.test.ts for the realistic-balance regression guard.
 */
export const MAX_PLAUSIBLE_BALANCE_LYTHOSHI = 200_000_000_000_000_000_000_000_000n; // 2 x 10^26 (2x genesis supply @ 18 dec)

/** Accept both the proof-envelope shape `{ value, blockNumber, proof,
 *  stateRoot }` and the plain hex-string shape; reject everything else.
 *
 *  SDK contract: AccountProofResponse (binding, not top-level exported)
 *    @ mono-core-sdk 0fd8a79.
 *  Strict shape: `{ value, state_root, block_number, proof? }`.
 *
 *  Wire-vs-binding case mismatch (intentional, observed against live operators): the
 *  chain serializer emits camelCase (`stateRoot`, `blockNumber`) even
 *  though the ts-rs binding annotates snake_case. The wallet's parser
 *  only reads `.value`, so the case mismatch doesn't affect balance
 *  reads — but downstream callers that need the proof envelope's other
 *  fields should consult the live wire form, not the binding annotations.
 *
 *  Resilience posture: keep the dual-shape accept —
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
 * Query every active testnet operator in parallel for `eth_getBalance`
 * and return the MAX value across responses.
 *
 * Operators may briefly lag behind each other after a regenesis or
 * binary rollout. The single-operator-with-failover pattern in
 * `testnetJsonRpc` latches onto the first responder, which for
 * balance reads can be a stale `0x0` envelope that hides the correct
 * value reported by other operators (observed in the field:
 * 192.0.2.1 returned `0x0` for a freshly funded address while
 * other operators returned the correct `0x16345785d8a0000`).
 *
 * Max() is safe specifically for balance because balance grows
 * monotonically until a tx spends from the address — a lagging
 * operator can only under-report, never over-report. Do NOT
 * generalize this to `eth_call`, nonce, fee, or indexer methods,
 * where max() is not meaningful; those keep `testnetJsonRpc`
 * first-responder semantics.
 */
export async function testnetMaxBalanceConsensus(
  address: string,
): Promise<BalanceConsensusResult> {
  const operators = getActiveOperators();
  if (operators.length === 0) {
    throw new Error("no Monolythium Testnet operators configured");
  }

  const probes = operators.map(async (op) => {
    // GAP #11: skip operators whose chain identity doesn't match our pin.
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
      const value = BigInt(r.balanceHex);
      // T4-03 (Item C): drop a physically-impossible balance (above total
      // supply) so a lying/inflating operator cannot win the MAX reduce.
      if (!isWithinSaneBound(value, MAX_PLAUSIBLE_BALANCE_LYTHOSHI)) {
        failing.push({ name: r.name, reason: "balance exceeds total supply" });
        continue;
      }
      contributing.push({ name: r.name, balanceHex: r.balanceHex, value });
    } catch {
      failing.push({ name: r.name, reason: "invalid bigint hex" });
    }
  }

  if (contributing.length === 0) {
    const summary = failing.map((f) => `${f.name}: ${f.reason}`).join("; ");
    throw new Error(
      `all ${operators.length} Monolythium Testnet operators failed eth_getBalance: ${summary}`,
    );
  }

  let max = contributing[0]!;
  let min = contributing[0]!;
  for (let i = 1; i < contributing.length; i++) {
    if (contributing[i]!.value > max.value) max = contributing[i]!;
    if (contributing[i]!.value < min.value) min = contributing[i]!;
  }

  return {
    balanceHex: max.balanceHex,
    // T4-03 (Item C): the spend gate uses the LOWEST contributing balance so a
    // single over-reporting operator cannot enable an unaffordable Max. Equals
    // balanceHex under the default single operator.
    spendGuardHex: min.balanceHex,
    contributing: contributing.map((c) => ({ name: c.name, balanceHex: c.balanceHex })),
    failing,
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

// ----- Plaintext submission path -----
//
// The wallet signs the chain-side `SignedTransaction` and forwards the bincode
// bytes through `mesh_submitTx` — the functional inclusion path on the live
// chain.
//
// We do NOT route through the SDK's `submitPlaintextTransaction` RpcClient
// helper here: the wallet's operator-iteration in `testnetJsonRpc` carries
// the genesis-hash pin + multi-operator failover that protect every wallet
// RPC. We still use the SDK's `buildPlaintextSubmission` for the
// protocol-critical sign + bincode serialization (the bytes are byte-for-byte
// what `submitPlaintextTransaction` would send), and mirror the SDK's node-echo
// validation: the node returns the canonical 32-byte native tx hash on
// admission, and any mismatch is rejected loud so the wallet never trusts a
// hash it did not derive itself.

/** Build a PLAINTEXT submission for the ML-DSA-65 mesh_submitTx path. Signs
 *  over the canonical chain-side sighash with the unlocked ML-DSA-65 backend
 *  and bincode-serializes the result. (The encrypted-mempool / Ferveo
 *  threshold-decrypt path was removed; a LythiumSeal encrypted path may
 *  return later.) */
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
  const { result, via } = await testnetJsonRpc<string>("mesh_submitTx", [
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

// ----- LythiumSeal encrypted (scheme-3) submission path -----
//
// On a chain running with the encrypted-mempool milestone ON (v0.1.44+),
// `mesh_submitTx` is rejected ("-32047 plaintext mempool entry not allowed:
// encrypted envelope required"). The wallet then seals the *already-signed*
// inner tx to the operator cluster's ML-KEM-768 roster and submits the envelope
// via `lyth_submitEncrypted`. The seal is confidentiality only — the inner
// ML-DSA-65 signature + the canonical inner-tx hash are unchanged, so the
// receipt is still keyed on the same hash the plaintext path produces.
//
// Roster trust: `fetchClusterSealKeys` reads `lyth_getClusterSealKeys` via
// `testnetJsonRpc`, which skips any operator whose chain identity != the genesis
// pin (`verifyOperatorGenesis`), so the roster only ever comes from a
// genesis-trusted operator. The SDK's `parseClusterSealKeys` then recomputes the
// roster hash from the served ek set and, when the source carries one, requires
// the supplied hash to match — so the wallet can never seal under a roster hash
// that does not commit to the exact recipient set it seals to.

/** Soft TTL for the cluster seal roster cache. The roster rotates on cluster
 *  membership / epoch changes (infrequent); a short TTL bounds staleness while
 *  avoiding an extra RPC on every send. A stale roster the chain rejects
 *  surfaces honestly and the next attempt re-fetches a fresh, re-validated one.
 *  (Tune once the live rotation cadence is observed — see the FIX report.) */
const SEAL_ROSTER_TTL_MS = 30_000;

interface CachedClusterSealKeys {
  clusterId: number;
  epoch: bigint;
  keys: ClusterSealKeys;
  fetchedAtMs: number;
}
let cachedClusterSealKeys: CachedClusterSealKeys | null = null;

/** Force-fetch + validate the cluster seal roster for `clusterId` from a
 *  genesis-trusted operator, and refresh the cache. `parseClusterSealKeys`
 *  validates the shape (ek lengths, contiguous `1..=n` indices, `2<=t<=n`) and
 *  the roster hash; a malformed/forged roster throws here rather than being
 *  sealed to. Prefer {@link getClusterSealKeys} in the hot path. */
export async function fetchClusterSealKeys(
  clusterId = 0,
): Promise<ClusterSealKeys> {
  const { result } = await testnetJsonRpc<
    ClusterSealKeysSource & { clusterId?: number }
  >("lyth_getClusterSealKeys", [clusterId]);
  const keys = parseClusterSealKeys({
    ...result,
    clusterId: result.clusterId ?? clusterId,
  });
  cachedClusterSealKeys = {
    clusterId: keys.clusterId,
    epoch: keys.epoch,
    keys,
    fetchedAtMs: Date.now(),
  };
  return keys;
}

/** Cached cluster seal roster accessor (TTL `SEAL_ROSTER_TTL_MS`). Returns the
 *  cached, already-validated roster within the TTL; otherwise force-fetches +
 *  re-validates, which also picks up an epoch rotation. */
export async function getClusterSealKeys(
  clusterId = 0,
): Promise<ClusterSealKeys> {
  const cached = cachedClusterSealKeys;
  if (
    cached !== null &&
    cached.clusterId === clusterId &&
    Date.now() - cached.fetchedAtMs < SEAL_ROSTER_TTL_MS
  ) {
    return cached.keys;
  }
  return fetchClusterSealKeys(clusterId);
}

/** Build a SEALED (LythiumSeal scheme-3) submission for the `lyth_submitEncrypted`
 *  path — the encrypted counterpart of {@link buildPlaintextSubmission}. Signs
 *  the inner ML-DSA-65 tx with the UNCHANGED signing path (the same `signEvmTx`
 *  the plaintext path uses), then seals the signed bytes to the cluster roster
 *  via the SDK. The seal is confidentiality only: `innerTxHashHex` /
 *  `innerSighashHex` are derived from the inner signed tx exactly as the
 *  plaintext path derives them, so the canonical inner-tx hash the chain indexes
 *  is identical — the receipt is keyed on the same hash (invariant 3 + the
 *  canonical-hash invariant; the seal wraps, it does not re-key). */
export async function buildSealedSubmission(args: {
  txReq: EthSendTxFields;
  clusterSealKeys: ClusterSealKeys;
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
    clusterSealKeys: args.clusterSealKeys,
  });
}
