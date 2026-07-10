// Monolythium Wallet — ML-DSA-65 transaction submission bridge.
//
// Protocol-critical signing + native tx encoding live in
// `@monolythium/core-sdk/crypto`. This module keeps browser-wallet
// responsibilities local: translate EIP-1193 fields, iterate testnet
// operator RPCs, and surface wallet-friendly errors.

import {
  buildPlaintextSubmission as sdkBuildPlaintextSubmission,
  type NativeEvmTxFields,
  type NativeTxExtensionLike,
} from "@monolythium/core-sdk/crypto";
import {
  getActiveVaultIdV4,
  getUnlockedBackendV4,
} from "./keystore-mldsa.js";
import {
  allActiveOperatorsDefinitivelyUntrusted,
  classifyNoOperatorReason,
  getActiveOperators,
  verifyOperatorGenesis,
} from "./networks.js";
import { isWithinSaneBound } from "../shared/operator-bounds.js";
import { bech32mToAddress } from "../shared/bech32m.js";
import { extractMempoolInner } from "../shared/send-error.js";

/** Sentinel thrown by the fail-closed vault-binding assert when the active
 *  vault changed between approval and the synchronous pre-sign read (NN-01
 *  TOCTOU). Fail-closed: nothing was signed or broadcast. send-error.ts keys
 *  on the stable "active account changed" substring to classify it as the
 *  warn-level "active-vault-changed" kind. Mechanism-agnostic — catches any
 *  active-vault change (selectActiveVaultV4 AND vault-add), since it compares
 *  the live getActiveVaultIdV4() to the bound id rather than a mechanism. */
export const VAULT_BINDING_CHANGED_MESSAGE =
  "active account changed during signing — transaction cancelled for safety";

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

/** Message for the all-operators-untrusted aggregate. Kept byte-identical to
 *  the prior plain-Error string so message-keyed callers (send-error
 *  classification, the chain-status banner) are unchanged; new callers can
 *  `instanceof ChainGenesisMismatchError` instead of substring-matching. */
function genesisMismatchMessage(operatorCount: number): string {
  return `Chain genesis mismatch — all ${operatorCount} operators reported untrusted genesis. The chain may have undergone a regenesis since the wallet's pin was last updated, or operator binaries are stale. See Operators.`;
}

/** Thrown when EVERY active operator fails the genesis gate — by the pre-loop
 *  short-circuit (all operators already cached definitively-untrusted) OR the
 *  post-loop aggregate. `kind` lets callers distinguish a chain-identity
 *  rejection from a transport failure without string-matching. Subclass of
 *  Error with the UNCHANGED message, so existing message-keyed handling holds. */
export class ChainGenesisMismatchError extends Error {
  readonly kind = "untrusted-chain" as const;
  constructor(operatorCount: number) {
    super(genesisMismatchMessage(operatorCount));
    this.name = "ChainGenesisMismatchError";
  }
}

/** Message for the all-operators-QUARANTINED aggregate — same chain, but every
 *  active operator self-quarantined on a checkpoint state-root mismatch and is
 *  refusing RPC. Distinct from a genesis mismatch: the remedy is "wait for an
 *  operator to recover / switch operators", NOT "bump the pin". The
 *  "operators quarantined" phrasing is what send-error classification keys on. */
function quarantinedAggregateMessage(operatorCount: number): string {
  return `Operators quarantined — all ${operatorCount} active operator${operatorCount === 1 ? "" : "s"} reported a checkpoint state-root mismatch and are refusing requests. They're on your chain but temporarily can't be trusted; the wallet reconnects automatically once one recovers. See Operators.`;
}

/** Thrown when EVERY active operator fails the genesis gate AND all of them are
 *  quarantined (not a genuine genesis mismatch). Lets the Send/Stake screens
 *  show quarantine copy instead of the misleading re-genesis copy. */
export class ChainQuarantinedError extends Error {
  readonly kind = "all-quarantined" as const;
  constructor(operatorCount: number) {
    super(quarantinedAggregateMessage(operatorCount));
    this.name = "ChainQuarantinedError";
  }
}

// C2: collapse concurrent IDENTICAL reads onto one in-flight walk. Default-DENY
// allow-list — only known idempotent reads coalesce; submits and any UNLISTED
// method bypass to the uncoalesced path, so two sends NEVER share a promise (R4)
// and an unknown method keeps today's behavior. Keyed on method+params; cleared
// on SETTLE (not a TTL) so only truly-concurrent reads merge — a later identical
// read launches a fresh walk and never serves a stale result.
const inflightReads = new Map<
  string,
  Promise<{ result: unknown; via: string }>
>();
const COALESCED_READ_METHODS = new Set<string>([
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_call",
  "eth_gasPrice",
  "lyth_chainStats",
  "lyth_executionUnitPrice",
  "lyth_decodeTx",
  "lyth_nativeReceipt",
  "lyth_getTokenBalances",
  "lyth_getAddressActivity",
  "lyth_bridgeRoutes",
  "lyth_mrcAccount",
  "lyth_nativeAgentState",
  "lyth_getAddressLabel",
  "lyth_getDelegationHistory",
  "lyth_signingActivity",
  "lyth_operatorRisk",
  "lyth_upcomingDuties",
  "lyth_getDelegations",
]);

/**
 * Public entry: coalesces concurrent identical READ calls onto one in-flight
 * operator walk (see above). Submits / unlisted methods go straight to the
 * uncoalesced walk. See `_testnetJsonRpcUncoalesced` for the walk itself.
 */
export async function testnetJsonRpc<T>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number },
): Promise<{ result: T; via: string }> {
  if (!COALESCED_READ_METHODS.has(method)) {
    return _testnetJsonRpcUncoalesced<T>(method, params, opts);
  }
  const key = `${method}|${JSON.stringify(params)}`;
  const existing = inflightReads.get(key);
  if (existing !== undefined) {
    return existing as Promise<{ result: T; via: string }>;
  }
  const p = _testnetJsonRpcUncoalesced<T>(method, params, opts).finally(() => {
    inflightReads.delete(key);
  });
  inflightReads.set(key, p as Promise<{ result: unknown; via: string }>);
  return p;
}

/** The one write RPC (the chain's inclusion path). Its failover/fan-out is
 *  Part B — Part A leaves the submit path byte-identical: throw on the first
 *  error body, no cross-operator failover here. */
const SUBMIT_METHOD = "mesh_submitTx";
/** `-32047` UPSTREAM_UNAVAILABLE. Bare = the operator's upstream is down (fail
 *  over); mempool-WRAPPED (`upstream unavailable: mempool: <admission>`) = an
 *  admission decision about a tx (propagate — every operator answers the same). */
const UPSTREAM_UNAVAILABLE_CODE = -32047;
/** D1: cap read-failover attempts so one bad call doesn't walk the whole fleet
 *  (the v0.4.0 four-cluster DVT set; its exact size comes from the SDK registry
 *  and can change) — after this many failover-band errors, surface the last one. */
const READ_FAILOVER_ATTEMPT_CAP = 4;
/** D2: how long a read-failover-band error deprioritizes an operator (soft, in
 *  memory) so subsequent reads try healthier operators first. Never a hard
 *  removal; the operator is still tried once the rest are exhausted, and the
 *  entry clears early on its next success. */
const DEGRADED_OPERATOR_TTL_MS = 30_000;
/** Deterministic JSON-RPC error codes (mono-core `crates/core/rpc/src/error.rs`):
 *  the same answer on every operator, so a read gains nothing by failing over —
 *  throw immediately. Everything else with a numeric code is operator-scoped /
 *  transient → fail over across the genesis-trusted fleet. (`-32047` is special,
 *  see `readErrorShouldPropagate`.) */
const PROPAGATE_ERROR_CODES: ReadonlySet<number> = new Set([
  -32700, // PARSE_ERROR — our request is malformed
  -32600, // INVALID_REQUEST
  -32602, // INVALID_PARAMS
  -32043, // REQUEST_TOO_LARGE
  -32052, // FILTER_TOO_BROAD
  -32054, // DEBUG_TRACE_TOO_LARGE
  -32055, // UNSUPPORTED_ENCODING
  -32056, // INVALID_SUBSCRIPTION_TOPIC
  -32059, // INVALID_JSONRPC_VERSION
]);

/** opName -> expiry ms. A soft, in-memory deprioritize hint set on a
 *  read-failover-band error and honored by `orderReadOperators`. Cleared on a
 *  later success from that operator; never bypasses the genesis-trust gate. */
const degradedOperators = new Map<string, number>();

/** Test-only: clear the D2 degraded-operator hints so a suite starts from a
 *  known state. Not used by production code. */
export function __resetReadFailoverStateForTest(): void {
  degradedOperators.clear();
}

type OperatorRpc = ReturnType<typeof getActiveOperators>[number];

/** True when an HTTP-200 `{error}` body from a READ should PROPAGATE (throw now)
 *  rather than fail over: deterministic codes, or a mempool-wrapped `-32047`
 *  admission reject. `undefined` code preserves today's throw-on-error behavior.
 *  Bare `-32047` and every other operator-scoped code return false → fail over. */
function readErrorShouldPropagate(
  code: number | undefined,
  message: string | undefined,
): boolean {
  if (typeof code !== "number") return true;
  if (code === UPSTREAM_UNAVAILABLE_CODE) {
    return message != null && extractMempoolInner(message) !== null;
  }
  return PROPAGATE_ERROR_CODES.has(code);
}

/** Stable soft-deprioritize: operators flagged degraded within the TTL window go
 *  LAST (still tried, never dropped), otherwise the override/hardened-dial order
 *  is preserved verbatim. Reads iterate this; the submit path uses the raw order. */
function orderReadOperators(
  ops: ReadonlyArray<OperatorRpc>,
  nowMs: number,
): OperatorRpc[] {
  const fresh: OperatorRpc[] = [];
  const degraded: OperatorRpc[] = [];
  for (const op of ops) {
    const until = degradedOperators.get(op.name);
    if (until !== undefined && until > nowMs) degraded.push(op);
    else fresh.push(op);
  }
  return degraded.length === 0 ? fresh : [...fresh, ...degraded];
}

/**
 * Iterate the genesis-trusted testnet operators, returning the first that
 * produces a non-error JSON-RPC response. Transport faults AND operator-scoped /
 * transient RPC errors (the FAILOVER band — `-32045/-32046/-32048/-32058/-32601/
 * -32701/-32090`, bare `-32047`, etc.) advance to the next operator; only
 * DETERMINISTIC errors (`-32602`, request-shape faults) and the `mesh_submitTx`
 * mempool-wrapped `-32047` admission reject propagate immediately (they are the
 * same on every operator). Reads deprioritize a recently-degraded operator (D2)
 * and cap failover at `READ_FAILOVER_ATTEMPT_CAP` (D1). The submit path
 * (`mesh_submitTx`) is unchanged — throw on the first error body (Part B owns
 * write fan-out). The genesis-trust gate and operator set/order (override /
 * hardened-dial) are unchanged.
 */
async function _testnetJsonRpcUncoalesced<T>(
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
  // Fast-fail: when EVERY active operator already carries a sticky definitive
  // untrusted verdict (re-genesis / wrong chain), don't re-walk the whole fleet
  // on every read — that exhaustive re-loop-per-read is what turned a re-genesis
  // into a multi-second UI hang. Pure cache read (~0 ms, no probe); throws the
  // SAME typed error the post-loop aggregate would, with a byte-identical
  // message, so message-keyed callers are unchanged. Falls through to the real
  // gated walk below for any unprobed / 60 s-TTL / trusted operator, so a
  // recovering fleet is still tried. The gate is unchanged — this only
  // fast-paths the outcome the gate would reach anyway, and serves zero data.
  if (allActiveOperatorsDefinitivelyUntrusted()) {
    throw new ChainGenesisMismatchError(getActiveOperators().length);
  }

  const isSubmit = method === SUBMIT_METHOD;
  // Reads deprioritize a recently-degraded operator (D2); the submit path keeps
  // the raw override / hardened-dial order (Part B owns write fan-out).
  const walkOps = isSubmit
    ? getActiveOperators()
    : orderReadOperators(getActiveOperators(), Date.now());
  let untrustedCount = 0;
  let totalOperators = 0;
  // Last FAILOVER-band read error — surfaced (with its real code) when the walk
  // or the attempt cap is exhausted, so the caller still classifies on a code.
  let readFailoverErr:
    | (Error & { code?: number; via?: string; method?: string })
    | null = null;
  let readFailoverAttempts = 0;
  for (const v of walkOps) {
    totalOperators++;
    // GAP #11: genesis-hash pin. Operators whose chain identity doesn't
    // match TESTNET_GENESIS_HASH are skipped — they're either on a fork
    // or a different chain entirely, and routing any request to them
    // leaks reads / writes onto an untrusted ledger.
    // C3: bound the genesis probe so a hung / slow operator fails fast. The read
    // path left this unbounded, so a dead operator stalled a reopen for the full
    // 3 s probe default. A caller's own timeoutMs takes precedence; default 2 s.
    if (!(await verifyOperatorGenesis(v.rpc, opts?.timeoutMs ?? 2_000))) {
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
      // Submit path (mesh_submitTx) is Part B — unchanged: throw on the first
      // error body. Reads propagate deterministic errors + the mempool-wrapped
      // -32047 admission reject immediately; the operator-scoped / transient
      // band fails over to the next genesis-trusted operator.
      if (isSubmit || readErrorShouldPropagate(body.error.code, body.error.message)) {
        throw err;
      }
      degradedOperators.set(v.name, Date.now() + DEGRADED_OPERATOR_TTL_MS); // D2
      readFailoverErr = err;
      readFailoverAttempts++;
      if (readFailoverAttempts >= READ_FAILOVER_ATTEMPT_CAP) throw err; // D1 cap
      continue;
    }
    if (body.result === undefined) {
      lastTransportErr = new Error(`empty result body from ${v.name}`);
      continue;
    }
    // This operator answered cleanly — clear any stale degraded flag so it
    // recovers immediately (before the D2 TTL would).
    degradedOperators.delete(v.name);
    return { result: body.result, via: v.name };
  }
  // If EVERY operator failed the genesis pin check,
  // surface a clearer aggregate error instead of the last-operator's
  // raw "name: untrusted genesis" message. See Operators for
  // per-operator status the user can act on.
  if (untrustedCount > 0 && untrustedCount === totalOperators) {
    // `untrustedCount` counts EVERY operator that failed verifyOperatorGenesis —
    // which is false for BOTH a definitive genesis mismatch (observed!==null)
    // AND a transient "couldn't read" verdict (observed:null, i.e. the operator
    // was simply unreachable). Treating all of them as a genesis mismatch made
    // an OFFLINE fleet surface "Chain genesis mismatch" on Send/Stake while the
    // banner (which reads classifyNoOperatorReason) correctly showed OFFLINE.
    // Defer to the SAME classifier the banner uses so the two never disagree:
    // only a definitive re-genesis / wrong-chain fleet throws the genesis error;
    // an all-quarantined fleet throws the quarantine error; an unreachable fleet
    // falls through to the honest offline message below.
    const reason = classifyNoOperatorReason();
    if (reason === "quarantined") {
      throw new ChainQuarantinedError(totalOperators);
    }
    if (reason === "regenesis" || reason === "untrusted") {
      throw new ChainGenesisMismatchError(totalOperators);
    }
    // reason === "unreachable": throw a CLEAN offline error, NOT lastTransportErr
    // (which carries the misleading "<name>: untrusted genesis" text that
    // classifySendError would mis-key as genesis-mismatch).
    throw new Error("no Monolythium Testnet operator reachable");
  }
  // Prefer the last real FAILOVER-band RPC error (it carries a code the caller
  // can classify) over a bare transport error.
  throw (
    readFailoverErr ??
    lastTransportErr ??
    new Error("no Monolythium Testnet operator reachable")
  );
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

/** Per-operator timeout for the parallel balance probe. Kept tight: a healthy
 *  operator answers eth_getBalance in well under a second, so 5 s only ever
 *  served to make an unreachable/fake operator drag the whole Promise.all
 *  consensus out for that long (the balance card then lingered on a stale
 *  "couldn't reach" while the banner — on its own 1.5 s liveness path — already
 *  read LIVE). 2.5 s is generous for a real op and fails a dead one fast. */
const BALANCE_CONSENSUS_TIMEOUT_MS = 2_500;

/** Bound the per-operator genesis check inside the balance consensus so an
 *  unreachable/fake operator's probe can't block Promise.all. Matches the
 *  dispatch path's 2 s bound; with the block-0-fallback fast-fail in
 *  probeOperatorGenesis a dead op now resolves its genesis verdict in ~one
 *  timeout instead of two. */
const BALANCE_GENESIS_PROBE_TIMEOUT_MS = 2_000;

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
    if (!(await verifyOperatorGenesis(op.rpc, BALANCE_GENESIS_PROBE_TIMEOUT_MS))) {
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

/**
 * Cross-operator QUORUM for §22.8 forward name resolution (P5-002 close).
 * Mirrors the `testnetMaxBalanceConsensus` fan-out — the SAME operator set
 * (`getActiveOperators`), the same genesis-pin gate, the same parallel-probe-
 * with-timeout — but with an EXACT-MATCH agreement reduce instead of MAX (an
 * address is not orderable, so MAX is meaningless; the balance helper itself
 * warns against generalizing its reduce to non-monotonic reads).
 *
 * Because the resolved address feeds a SIGNED recipient, this is FAIL-CLOSED:
 *  - `confirmed-hit`  — ≥ NAME_RESOLVE_QUORUM_MIN genesis-trusted operators
 *    answered AND all agree on the SAME owner address.
 *  - `confirmed-miss` — ≥ the quorum answered AND all agree the name is
 *    unregistered (null) — a legitimate "not registered".
 *  - `disagreement`   — any two answers differ (a rogue returning a different
 *    address, or a hit-vs-miss split). NEVER signed.
 *  - `insufficient`   — fewer than the quorum answered, so no single operator
 *    is the sole authority for a signed address.
 * Only `confirmed-hit` yields an address; everything else → the user pastes it.
 * This closes the SINGLE-ROGUE model; a full on-path RPC-MITM (one forged
 * response on every connection) still needs operator TLS (O1 / P6-002).
 */
export interface NameResolveConsensusResult {
  status: "confirmed-hit" | "confirmed-miss" | "disagreement" | "insufficient";
  /** The agreed lowercased 0x owner address — `confirmed-hit` only, else null. */
  addr0x: string | null;
  /** Operators that returned a definitive answer (a hit OR a miss). */
  agreeing: number;
  /** Per-operator outcome, for the SW console (diagnostics only). */
  detail: string;
}

/** Minimum genesis-trusted operators that must agree before a name resolution
 *  is trusted for a SIGNED recipient. ≥2 so no single operator is the sole
 *  authority: a lone roge is outvoted (→ disagreement → fail-closed), and a
 *  rogue that is the ONLY responder fails the quorum (→ insufficient). */
const NAME_RESOLVE_QUORUM_MIN = 2;

export async function testnetResolveNameConsensus(
  name: string,
): Promise<NameResolveConsensusResult> {
  const operators = getActiveOperators();
  if (operators.length === 0) {
    throw new Error("no Monolythium Testnet operators configured");
  }

  const probes = operators.map(async (op) => {
    // GAP #11: skip operators whose chain identity doesn't match our pin.
    if (!(await verifyOperatorGenesis(op.rpc, BALANCE_GENESIS_PROBE_TIMEOUT_MS))) {
      return { name: op.name, addr0x: null, answered: false, reason: "untrusted genesis" };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BALANCE_CONSENSUS_TIMEOUT_MS);
    try {
      const res = await fetch(op.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "lyth_resolveName", params: [name] }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { name: op.name, addr0x: null, answered: false, reason: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        result?: { address?: unknown } | null;
        error?: { message?: string };
      };
      if (body.error) {
        return { name: op.name, addr0x: null, answered: false, reason: body.error.message ?? "rpc error" };
      }
      const address =
        body.result !== null && typeof body.result === "object"
          ? (body.result as { address?: unknown }).address
          : null;
      // Unregistered → a DEFINITIVE miss answer (null), still a quorum vote.
      if (address === null || address === undefined) {
        return { name: op.name, addr0x: null, answered: true, reason: null };
      }
      if (typeof address !== "string" || address.length === 0) {
        return { name: op.name, addr0x: null, answered: false, reason: "malformed shape" };
      }
      try {
        const addr0x = bech32mToAddress(address, null).toLowerCase();
        return { name: op.name, addr0x, answered: true, reason: null };
      } catch {
        return { name: op.name, addr0x: null, answered: false, reason: "malformed address" };
      }
    } catch (e) {
      const err = e as Error;
      return {
        name: op.name,
        addr0x: null,
        answered: false,
        reason: err.name === "AbortError" ? "timeout" : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  const responses = await Promise.all(probes);
  const answered = responses.filter((r) => r.answered);

  if (answered.length < NAME_RESOLVE_QUORUM_MIN) {
    return {
      status: "insufficient",
      addr0x: null,
      agreeing: answered.length,
      detail: responses.map((r) => `${r.name}:${r.reason ?? "ok"}`).join("; "),
    };
  }

  // EXACT-MATCH agreement: every definitive answer must be identical — all the
  // SAME owner address, or all miss. A single divergent answer (a rogue's
  // different address, or a hit-vs-miss split) → disagreement → fail-closed.
  const distinct = new Set(answered.map((r) => (r.addr0x === null ? "MISS" : r.addr0x)));
  if (distinct.size !== 1) {
    return {
      status: "disagreement",
      addr0x: null,
      agreeing: answered.length,
      detail: answered.map((r) => `${r.name}:${r.addr0x ?? "MISS"}`).join("; "),
    };
  }

  const agreed = answered[0]!.addr0x;
  return agreed === null
    ? { status: "confirmed-miss", addr0x: null, agreeing: answered.length, detail: "" }
    : { status: "confirmed-hit", addr0x: agreed, agreeing: answered.length, detail: "" };
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
 *  and bincode-serializes the result. Plaintext `mesh_submitTx` is the wallet's
 *  only inclusion path — the chain has no encrypted mempool. */
export async function buildPlaintextSubmission(args: {
  txReq: EthSendTxFields;
  boundVaultId: string;
}): Promise<{
  signedTxWireHex: string;
  innerSighashHex: string;
  innerTxHashHex: string;
  innerWireBytes: number;
}> {
  // NN-01 fail-closed: assert the active vault still equals the approved/
  // displayed vault IMMEDIATELY before the live backend read. This statement
  // and the getUnlockedBackendV4() read below are consecutive SYNCHRONOUS reads
  // of the same module-global (unlocked/activeContainerVaultId) — there is NO
  // await between them, and sdkBuildPlaintextSubmission signs synchronously once
  // `backend` is captured as a local — so a concurrent selectActiveVaultV4 /
  // vault-add cannot interleave between the check and the sign.
  if (getActiveVaultIdV4() !== args.boundVaultId) {
    throw new Error(VAULT_BINDING_CHANGED_MESSAGE);
  }
  const backend = getUnlockedBackendV4();
  if (backend === null) {
    throw new Error("v3 wallet is locked");
  }
  return sdkBuildPlaintextSubmission({
    backend,
    tx: normalizeFields(args.txReq),
  });
}

/** D3: fan out a broadcast to this many genesis-trusted operators (or all, if the
 *  trusted set is smaller). One accepting/gossiping operator is enough for
 *  inclusion — the X1 stuck-tx mode was a single accepting-but-non-gossiping
 *  operator sinking the send. Re-broadcasting the SAME signed bytes is
 *  idempotent by tx hash (the chain dedupes → DuplicateKnown, never a second
 *  inclusion), so this cannot double-spend (verified vs mono-core v0.4.0). */
const FANOUT_BREADTH = 3;

/** Per-operator outcome of one mesh_submitTx in the fan-out. */
type FanoutOutcome =
  | { kind: "accepted"; via: string } // echoed our canonical hash
  | { kind: "already-known"; via: string } // our exact tx already pooled/mined here
  | { kind: "mailbox-full"; via: string } // actor backpressure — this op didn't take it
  | { kind: "reject"; via: string; err: Error } // deterministic admission reject of THIS tx
  | { kind: "transient"; via: string; err?: Error }; // transport / bare band — op unavailable

function stampSubmitError(
  message: string,
  code: number | undefined,
  via: string,
): Error & { code?: number; via?: string; method?: string } {
  const err = new Error(message) as Error & {
    code?: number;
    via?: string;
    method?: string;
  };
  if (typeof code === "number") err.code = code;
  err.via = via;
  err.method = SUBMIT_METHOD;
  return err;
}

/** Submit the SAME signed bytes to ONE operator and classify the response. Never
 *  throws (all faults become an outcome) so the parallel fan-out can aggregate.
 *  The echoed canonical hash is validated per operator — a wallet never trusts a
 *  hash it did not derive itself. Genesis is gated by the caller (pickFanoutTargets). */
async function submitToOneOperator(
  op: OperatorRpc,
  signedTxWireHex: string,
  expectedTxHashHex: string,
): Promise<FanoutOutcome> {
  let res: Response;
  try {
    res = await fetch(op.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: SUBMIT_METHOD,
        params: [signedTxWireHex],
      }),
    });
  } catch {
    return { kind: "transient", via: op.name };
  }
  if (!res.ok) return { kind: "transient", via: op.name };
  let body: { result?: unknown; error?: { code?: number; message?: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { kind: "transient", via: op.name };
  }
  if (body.error) {
    const msg = body.error.message ?? "";
    const inner = extractMempoolInner(msg);
    // A mempool-wrapped error is an admission DECISION about this tx; a bare error
    // is the operator's upstream being down (transient — other operators may take it).
    if (inner !== null) {
      const low = inner.toLowerCase();
      // Our own hash already pooled here, or the nonce already mined — both mean the
      // tx is safely known to the chain (idempotent same-hash resubmit).
      if (low.includes("duplicate tx already known") || low.includes("already known")) {
        return { kind: "already-known", via: op.name };
      }
      if (low.includes("nonce already consumed") || low.includes("already consumed")) {
        return { kind: "already-known", via: op.name };
      }
      // The one genuine transient admission fault (actor backpressure).
      if (low.includes("mailbox full")) {
        return { kind: "mailbox-full", via: op.name };
      }
      // Any other admission reject (bad nonce/fee/balance/sig, replace-underpriced …)
      // is deterministic — every honest operator rejects it the same way.
      return { kind: "reject", via: op.name, err: stampSubmitError(msg, body.error.code, op.name) };
    }
    return { kind: "transient", via: op.name, err: stampSubmitError(msg, body.error.code, op.name) };
  }
  const echoed = typeof body.result === "string" ? body.result.toLowerCase() : "";
  const expected = expectedTxHashHex.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(echoed)) {
    return {
      kind: "reject",
      via: op.name,
      err: new Error(
        `mesh_submitTx returned a non-canonical tx hash (${String(body.result)}); refusing to trust it`,
      ),
    };
  }
  if (echoed !== expected) {
    return {
      kind: "reject",
      via: op.name,
      err: new Error(
        `mesh_submitTx echoed tx hash ${echoed} does not match locally computed ${expected}`,
      ),
    };
  }
  return { kind: "accepted", via: op.name };
}

/** The genesis-trusted operators to fan a broadcast to: the first FANOUT_BREADTH
 *  of the override/hardened-dial set (in its order) that pass the genesis-pin
 *  gate. Never routes a signed tx to an untrusted operator; falls to fewer than
 *  FANOUT_BREADTH when the trusted set is smaller. */
async function pickFanoutTargets(): Promise<OperatorRpc[]> {
  const targets: OperatorRpc[] = [];
  for (const op of getActiveOperators()) {
    if (targets.length >= FANOUT_BREADTH) break;
    if (await verifyOperatorGenesis(op.rpc, 2_000)) targets.push(op);
  }
  return targets;
}

/** Broadcast a bincode-encoded chain-side `SignedTransaction` (`0x`-hex) through
 *  the plaintext `mesh_submitTx` path, FANNING OUT the SAME signed bytes to up to
 *  FANOUT_BREADTH genesis-trusted operators in parallel (D3/D4) so a single
 *  accepting-but-non-gossiping operator can't silently sink the send (the X1
 *  stuck-tx mode). Re-broadcasting identical bytes is idempotent by tx hash, so
 *  this cannot double-spend. Success = at least ONE operator accepts or reports
 *  our own hash already-known (D5). The echoed canonical hash is validated per
 *  accepting operator. NO re-sign, NO new sighash — the same signed bytes go to
 *  every operator. `via` is the first accepting operator. */
export async function broadcastPlaintextTransaction(
  signedTxWireHex: string,
  expectedTxHashHex: string,
): Promise<{ txHash: string; via: string }> {
  const targets = await pickFanoutTargets();
  if (targets.length === 0) {
    // No genesis-trusted operator to broadcast through — mirror the read path's
    // aggregate reason so the user sees the same actionable chain-status error.
    const n = getActiveOperators().length;
    const reason = classifyNoOperatorReason();
    if (reason === "quarantined") throw new ChainQuarantinedError(n);
    if (reason === "regenesis" || reason === "untrusted") {
      throw new ChainGenesisMismatchError(n);
    }
    throw new Error("no Monolythium Testnet operator reachable");
  }
  const results = await Promise.allSettled(
    targets.map((op) => submitToOneOperator(op, signedTxWireHex, expectedTxHashHex)),
  );
  const settled: FanoutOutcome[] = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { kind: "transient", via: targets[i]!.name },
  );
  // D5: succeed if ANY operator accepted or already-knows our hash.
  const accepted = settled.filter(
    (o) => o.kind === "accepted" || o.kind === "already-known",
  );
  if (accepted.length > 0) {
    return { txHash: expectedTxHashHex, via: accepted[0]!.via };
  }
  // No acceptance. Surface a real (bad-tx) failure ONLY when EVERY target
  // returned a deterministic admission reject — otherwise some operators were
  // transient/backpressured and the broadcast is retryable, not doomed.
  const rejects = settled.filter(
    (o): o is Extract<FanoutOutcome, { kind: "reject" }> => o.kind === "reject",
  );
  if (rejects.length === targets.length) {
    throw rejects[0]!.err;
  }
  throw new Error("no Monolythium Testnet operator accepted the broadcast");
}

/** One-shot PLAINTEXT helper used by the service worker — the tx path on the
 *  live chain. `txHash` is the CANONICAL inner-tx
 *  hash the chain indexes (`eth_getTransactionByHash` / `lyth_txStatus`
 *  resolve it), validated against the node echo before it is surfaced. */
export async function submitPlaintextMlDsaTx(
  req: EthSendTxFields,
  boundVaultId: string,
): Promise<{
  txHash: string;
  via: string;
  innerSighashHex: string;
}> {
  const built = await buildPlaintextSubmission({ txReq: req, boundVaultId });
  const { txHash, via } = await broadcastPlaintextTransaction(
    built.signedTxWireHex,
    built.innerTxHashHex,
  );
  return { txHash, via, innerSighashHex: built.innerSighashHex };
}

/** Submit dispatcher — the SINGLE chokepoint every wallet tx type funnels
 *  through (send / stake / delegate / redelegate / claim / complete-redemption /
 *  spending-policy / multisig / MRV plan+call / emergency). Every tx goes
 *  plaintext through `mesh_submitTx`, the chain's only inclusion path. */
export async function submitMlDsaTx(
  req: EthSendTxFields,
  boundVaultId: string,
): Promise<{
  txHash: string;
  via: string;
  innerSighashHex: string;
}> {
  return submitPlaintextMlDsaTx(req, boundVaultId);
}
