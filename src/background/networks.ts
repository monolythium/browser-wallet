// Monolythium Wallet — network constants and chain capabilities.
//
// Chain markers indicating which signing path the wallet should use.
// ML-DSA-65 is mandatory on Monolythium Testnet (chain_id 69420);
// other Ethereum-compatible chains keep the legacy secp256k1 path.

import { MONOLYTHIUM_TESTNET_CHAIN_ID, getRpcEndpoints } from "@monolythium/core-sdk";
import {
  STORAGE_KEY_OPERATOR_OVERRIDE,
  validateOperatorList,
  mergeOperatorOverride,
  type OperatorEntry,
} from "../shared/operators.js";
import {
  TESTNET_BLOCK0_HASH,
  TESTNET_GENESIS_HASH,
} from "../shared/build-info.js";

/** Monolythium Testnet (L1 testnet) chain id, exposed as 0x-quantity hex. */
export const TESTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // "0x10F2C"

/** Numeric form for tx-build callsites that prefer u64. */
export const TESTNET_CHAIN_ID = Number(MONOLYTHIUM_TESTNET_CHAIN_ID); // 69420

/**
 * Minimum execution-unit limit for a plain LYTH transfer on Monolythium Testnet.
 * Empirically verified via admission rejection on a foundation operator: the chain
 * enforces a floor of 24309 (presumably ML-DSA-65 verify + envelope
 * decrypt + state proof overhead). 30000 = 0x7530 leaves headroom.
 * If the floor moves above this, the wallet needs a bump.
 *
 * Note: `eth_estimateGas` is NOT trustworthy for Monolythium Testnet — it returns
 * the compatibility execution estimate only (~21000) and ignores the
 * mempool intrinsic floor. The Monolythium Testnet code paths must hardcode this
 * constant instead of estimating.
 */
export const TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX = "0x7530"; // 30000

/**
 * T4-04 (Item D) — absolute sane upper bound on an operator-reported (or
 * popup-supplied) per-execution-unit PRICE. A de-trust BACKSTOP, not an
 * economic claim: the wallet signs the fee the user saw (T4-04 b1), but a
 * malicious/MITM operator (or a tampered popup) could still supply an absurd
 * `maxFeePerGas`; `clampToSaneBound` caps it here so a single unit can never be
 * priced above this line. Paired with the balance ceiling (Item C) via the
 * shared `operator-bounds` helper.
 *
 * UNIT NOTE: lythoshi-per-execution-unit, 18-decimal domain (1 LYTH = 10^18
 * lythoshi = LYTHOSHI_PER_LYTH). The realistic price is ~1e9–1e10 lythoshi/unit
 * (idle testnet; the Send page shows ~1e9), so 1e15 sits ~1e5–1e6× above real.
 * It therefore NEVER clamps a legitimate price — the dangerous direction would
 * be a too-LOW ceiling that clamps a real high price down and underprices/stalls
 * the tx — while bounding the worst-case malicious-induced fee to
 * 1e15 × 30000 units = 3e19 lythoshi = 30 LYTH per transfer (and that fee is
 * shown to the user via display==signed). The value MUST track the 18-decimal
 * domain: at the prior 8-decimal scale 1e15 read as ~10,000,000 LYTH/unit; at 18
 * decimals it means 0.001 LYTH/unit — still a safe loose ceiling, but the
 * magnitude intent changed, so the stale comment was corrected.
 *
 * VALUE-DECISION (needs-decision — deliberately NOT changed here): 1e15 is
 * loose-but-safe. Tightening toward realistic-peak-price × margin (e.g. 1e12–
 * 1e13 → ~0.03–0.3 LYTH max fee) would shrink the malicious-overpay window, but
 * is only safe if it stays comfortably above the network's realistic PEAK price
 * under congestion — which the wallet cannot observe (a fee-policy call). Kept
 * loose-but-safe pending that decision; never lower it below a wide margin over
 * the real ~1e9–1e10 price.
 */
export const MAX_EXECUTION_UNIT_PRICE_LYTHOSHI = 1_000_000_000_000_000n; // 1e15 lythoshi/unit (18-dec; loose-but-safe — see VALUE-DECISION)

/**
 * F-3.11 (#28) — absolute sane upper bound on the resolved execution-unit
 * LIMIT signed into a tx, in execution units. Companion to
 * MAX_EXECUTION_UNIT_PRICE_LYTHOSHI: the per-unit price was already clamped,
 * but the limit (from a popup `signedFee` bound or a caller hint) was not, so
 * a future non-UI caller could sign an absurd limit. A de-trust BACKSTOP, not
 * an economic claim: 30,000,000 is ~Ethereum-block-gas-limit order of
 * magnitude and ≥60× the largest legitimate wallet budget (the spending-policy
 * claim precompile, 500000 = 0x7A120), so it never alters a real native
 * transfer (30000), precompile call, or large MRV submission while capping a
 * physically-absurd value.
 */
export const MAX_EXECUTION_UNIT_LIMIT = 30_000_000n; // 0x1C9C380

/**
 * Monolythium Testnet operator RPC endpoints — sourced from the SDK-bundled chain
 * registry (`@monolythium/core-sdk` `getRpcEndpoints("testnet-69420")`).
 * Broadcast paths iterate this list and use the first responder. Registry
 * order is intentional and refreshed by bumping the SDK package.
 *
 * This is the *defaults* list. Power users can
 * override via chrome.storage.local["mono.operators.override"]. RPC
 * dispatch uses `getActiveOperators()` which merges the override with
 * these defaults at lookup time.
 *
 * Naming: the registry-sourced endpoints are labelled `operator-N` (1-
 * indexed, matching the SDK snapshot's ordering). The SDK registry owns
 * membership; the wallet mirrors it and no longer hardcodes exclusions.
 */
export const TESTNET_OPERATOR_RPCS_DEFAULTS: ReadonlyArray<OperatorEntry> =
  getRpcEndpoints("testnet-69420").map((endpoint, i) => ({
    name: `operator-${i + 1}`,
    region: endpoint.region ?? "unknown",
    rpc: endpoint.url,
    // Pull SDK's ws_url through when present so the
    // WS client can subscribe without per-operator auto-discovery. When
    // absent, deriveWsUrl in ws-client.ts falls back to the :8546 Geth
    // convention.
    ...(endpoint.ws_url !== undefined ? { wsRpc: endpoint.ws_url } : {}),
  }));

/** In-memory active operator list. Hydrated from storage at SW boot via
 *  `loadOperatorOverride()` and updated by `setOperatorOverride()` and
 *  the chrome.storage.onChanged listener in service-worker.ts. */
let activeOperators: OperatorEntry[] = TESTNET_OPERATOR_RPCS_DEFAULTS.map(
  (d) => ({ ...d }),
);

/** Snapshot of the current effective operator list (defaults or override).
 *  RPC dispatch (`testnetJsonRpc`, `probeFirstAliveOperator`) calls
 *  this on every iteration so a hot-swapped override takes effect on
 *  the next RPC without a SW restart. */
export function getActiveOperators(): ReadonlyArray<OperatorEntry> {
  return activeOperators;
}

/** Read the persisted override (if any) and update the in-memory list.
 *  Call at SW boot and from the chrome.storage.onChanged listener. */
export async function loadOperatorOverride(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_OPERATOR_OVERRIDE], (res) => {
      const raw = res?.[STORAGE_KEY_OPERATOR_OVERRIDE];
      const validated = validateOperatorList(raw);
      activeOperators = mergeOperatorOverride(TESTNET_OPERATOR_RPCS_DEFAULTS, validated);
      resolve();
    });
  });
}

/** Persist a new override (or null to clear and revert to defaults).
 *  Mutates in-memory state synchronously, then writes storage; the
 *  chrome.storage.onChanged listener also re-applies on the storage
 *  echo so an override set from outside the SW (e.g. DevTools) hot-
 *  reloads correctly. */
export async function setOperatorOverride(
  override: OperatorEntry[] | null,
): Promise<void> {
  activeOperators = mergeOperatorOverride(TESTNET_OPERATOR_RPCS_DEFAULTS, override);
  return new Promise((resolve) => {
    if (override === null) {
      chrome.storage.local.remove(STORAGE_KEY_OPERATOR_OVERRIDE, () => resolve());
    } else {
      chrome.storage.local.set({ [STORAGE_KEY_OPERATOR_OVERRIDE]: override }, () => resolve());
    }
  });
}

/** Defaults snapshot for popup-side display. */
export function getDefaultOperators(): ReadonlyArray<OperatorEntry> {
  return TESTNET_OPERATOR_RPCS_DEFAULTS;
}

/** Read the persisted override directly (without merging). Returns null
 *  when no override is set. Used by the popup `testnet-operators-get`
 *  IPC to render the "custom override active" banner. */
export async function readOperatorOverride(): Promise<OperatorEntry[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_OPERATOR_OVERRIDE], (res) => {
      const raw = res?.[STORAGE_KEY_OPERATOR_OVERRIDE];
      resolve(validateOperatorList(raw));
    });
  });
}

/**
 * Built-in chain registry entry. The chain-list IPC merges these with
 * user-added chains from chrome.storage; the popup's Networks screen
 * splits them into "Official" and "Custom" sections per `official`.
 *
 * Shape is a superset of what `service-worker.ts:NetInfo` carries — the
 * extra `official` field surfaces on the chain-list IPC reply so the
 * popup can render the badge without a second lookup.
 */
export interface BuiltinChain {
  chainId: string;
  chainIdNum: number;
  name: string;
  /** Single RPC URL for `RpcClient` consumers (user-added chains via
   * wallet_addEthereumChain). Monolythium Testnet reads/writes funnel through
   * `testnetJsonRpc` (operator iteration), not through this URL — it's
   * here only to satisfy callers that still ask for one. */
  rpc: string;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  /** True for Foundation-attested official chains (Monolythium Testnet today). */
  official: boolean;
}

/**
 * Built-in chains shipped with the wallet. The wallet ships exactly one —
 * Monolythium Testnet (chain_id 69420). All other chains are user-added at
 * runtime via `wallet_addEthereumChain`.
 *
 * Note: the legacy "Local devnet" (0x7A69) and old DNS alias have been
 * removed. Monolythium Testnet IS the testnet, and the canonical RPC list comes from
 * the SDK-bundled chain registry (`TESTNET_OPERATOR_RPCS`) — the `rpc`
 * field below is the first operator, kept for `RpcClient` consumers
 * (user-added chains); the read/write hot path goes through
 * `testnetJsonRpc`.
 */
export const BUILTIN_CHAINS: ReadonlyArray<BuiltinChain> = [
  {
    chainId: TESTNET_CHAIN_ID_HEX,
    chainIdNum: TESTNET_CHAIN_ID,
    name: "Monolythium Testnet",
    rpc: TESTNET_OPERATOR_RPCS_DEFAULTS[0]!.rpc,
    nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
    official: true,
  },
];

/**
 * Returns true when the chain id requires the ML-DSA-65 native envelope.
 * Monolythium Testnet refuses RLP+secp256k1 raw txs at the decoder layer per Law §2.1.
 *
 * Today this is "is it Monolythium Testnet"; once mainnet is live this expands to
 * "any Monolythium-protocol chain id" — keep this predicate single-source
 * so the routing in service-worker.ts touches one constant.
 */
export function chainRequiresMlDsa(chainIdHex: string): boolean {
  return chainIdHex.toUpperCase() === TESTNET_CHAIN_ID_HEX.toUpperCase();
}

/**
 * Probe the operator list and return the first endpoint that answers
 * `net_version` matching the expected chain id. Used at boot to pin a
 * working RPC since the canonical alias is offline.
 *
 * Returns null when every operator is unreachable or returns the wrong
 * chain id (regenesis-with-different-id case — operator should be told
 * to reconfigure).
 *
 * Operators with a mismatched genesis hash (orphan-
 * fork attack surface) are also skipped. A DEFINITIVE genesis verdict is
 * cached in-memory per RPC URL — genesis is immutable per chain — while a
 * "couldn't read" verdict (unreachable/timeout) expires on a short TTL so a
 * transient outage self-heals (see verifyOperatorGenesis).
 */
/**
 * Probe ONE operator: reachable + right chain id + genesis match. Resolves to
 * `{name, rpc}` on a full pass; THROWS on any failure (unreachable, timeout,
 * wrong chain id, or genesis mismatch) so `Promise.any` in
 * `probeFirstAliveOperator` selects the first operator that fully passes and
 * treats every failure as a rejection. Records the wrong-chain-id set as a
 * side effect so `classifyNoOperatorReason` can distinguish UNTRUSTED from
 * OFFLINE.
 */
async function probeOneOperator(
  v: { name: string; rpc: string },
  expectedChainIdDec: number,
  timeoutMs: number,
): Promise<{ name: string; rpc: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(v.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "net_version",
        params: [],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`net_version http ${res.status}`);
  const body = (await res.json()) as { result?: string };
  const reportedChainId = Number(body?.result ?? 0);
  if (reportedChainId !== expectedChainIdDec) {
    // Reachable, but serving a different chain id. Remember it so the banner
    // can say UNTRUSTED OPERATOR ("online but wrong chain") rather than
    // OFFLINE — the operator answered, it's just not our chain.
    operatorWrongChainId.add(v.rpc);
    throw new Error(`wrong chain id ${reportedChainId}`);
  }
  operatorWrongChainId.delete(v.rpc);
  // Genesis check (orphan-fork defense). On mismatch the operator is excluded
  // from RPC dispatch (cached per the verifyOperatorGenesis policy).
  const genesisOk = await verifyOperatorGenesis(v.rpc, timeoutMs);
  if (!genesisOk) throw new Error("genesis mismatch");
  return { name: v.name, rpc: v.rpc };
}

export async function probeFirstAliveOperator(
  expectedChainIdDec: number = TESTNET_CHAIN_ID,
  timeoutMs: number = 3_000,
): Promise<{ name: string; rpc: string } | null> {
  const operators = getActiveOperators();
  if (operators.length === 0) return null;
  // Probe all operators CONCURRENTLY (was a serial for-loop). A dead or slow
  // operator can no longer add head-of-line latency: worst-case wall-clock is
  // ONE timeout (~timeoutMs), not the sum across the whole fleet — this is the
  // fix for the multi-second "freeze" the user hit when the testnet was
  // unreachable. Promise.any resolves with the FIRST operator that fully passes
  // (reachable + right chain id + genesis); if EVERY operator rejects (all
  // dead / untrusted) it throws AggregateError and we return null, so the
  // banner shows a fast OFFLINE/UNTRUSTED instead of hanging on CONNECTING.
  // The losing probes run to their own timeout in the background, warming the
  // genesis cache + wrong-chain set (used by classifyNoOperatorReason) — the
  // same entries the old serial loop populated, just without blocking.
  try {
    return await Promise.any(
      operators.map((v) => probeOneOperator(v, expectedChainIdDec, timeoutMs)),
    );
  } catch {
    return null;
  }
}

/**
 * Per-operator genesis-hash cache. Key is the RPC URL; value is the
 * verification result. A DEFINITIVE entry (observed !== null) never expires;
 * genesis is immutable per chain, so a cached `false` survives across
 * reconnects until the user clears the operator override or the SW
 * restarts.
 */
interface GenesisCacheEntry {
  /** `true` when the operator's chain identity matches the wallet pin. */
  ok: boolean;
  /** Observed genesis identity or fallback block-0 hash. `null` when the
   *  operator does not expose either probe shape. */
  observed: string | null;
  checkedAt: number;
}

const operatorGenesisCache = new Map<string, GenesisCacheEntry>();

/**
 * Operators that answered `net_version` but reported a DIFFERENT chain id than
 * the wallet expects — reachable, but serving the wrong chain (a regenesis
 * that bumped the id, or an operator pointed at another network). Tracked
 * separately from the genesis cache (chain-id reachability is not immutable
 * the way a genesis hash is) so classifyNoOperatorReason can report UNTRUSTED
 * OPERATOR ("online but wrong chain") instead of a misleading OFFLINE. A
 * successful chain-id match deletes the entry; clearGenesisCache resets it.
 */
const operatorWrongChainId = new Set<string>();

// Persist the genesis cache across SW hibernation. The in-memory map above is
// wiped every ~30 s idle, so before this every wallet reopen re-paid the extra
// genesis round-trips the audit's orphan-fork pinning (be73670) added on top of
// the old net_version-only probe. Only DEFINITIVE verdicts (observed !== null)
// are persisted: a real genesis/block-0 hash is immutable per chain, so it may
// safely survive a wake. NON-definitive "couldn't read" verdicts (observed ===
// null) and the wrong-chain-id set are deliberately NOT persisted — they carry
// a short TTL / are reachability-derived and must re-probe so a transient blip
// self-heals. chrome.storage.session is SW-scope and clears on browser restart
// / extension reload — the right tier for a chain-identity fact (never on disk).
const SESSION_KEY_GENESIS_CACHE = "mono.session.genesis-cache.v1";

/** Best-effort persist the DEFINITIVE subset of the genesis cache. Overwrites
 *  the whole blob (a handful of operators) so an eviction in clearGenesisCache
 *  is mirrored too. Synchronous guard covers a missing chrome.storage in tests. */
function persistGenesisCache(): void {
  try {
    const defs: Record<string, GenesisCacheEntry> = {};
    for (const [rpc, e] of operatorGenesisCache) {
      if (e.observed !== null) defs[rpc] = e;
    }
    void chrome.storage.session
      .set({ [SESSION_KEY_GENESIS_CACHE]: defs })
      .catch(() => {});
  } catch {
    // best-effort — no persistence just means the next wake re-probes as before
  }
}

/** Seed the in-memory genesis cache from the verdicts a prior SW lifetime
 *  persisted, so the first probe after a cold wake skips the genesis round-trips
 *  instead of re-probing from empty. Only seeds well-formed DEFINITIVE entries
 *  the current lifetime hasn't already learned. Call once at SW boot. */
export async function rehydrateGenesisCache(): Promise<void> {
  try {
    const s = await chrome.storage.session.get(SESSION_KEY_GENESIS_CACHE);
    const raw = s?.[SESSION_KEY_GENESIS_CACHE] as
      | Record<string, unknown>
      | undefined;
    if (!raw || typeof raw !== "object") return;
    for (const [rpc, v] of Object.entries(raw)) {
      if (operatorGenesisCache.has(rpc)) continue; // a live probe already won
      const e = v as Partial<GenesisCacheEntry> | null;
      if (
        e &&
        typeof e.ok === "boolean" &&
        typeof e.observed === "string" &&
        typeof e.checkedAt === "number"
      ) {
        operatorGenesisCache.set(rpc, {
          ok: e.ok,
          observed: e.observed,
          checkedAt: e.checkedAt,
        });
      }
    }
  } catch {
    // best-effort — a read failure just means the first probe re-checks genesis
  }
}

/**
 * Verify an operator's chain genesis identity matches TESTNET_GENESIS_HASH.
 * Returns true on match (or cache-hit "true"); false on mismatch,
 * unreachable, or malformed response. A DEFINITIVE verdict is cached forever;
 * a "couldn't read" verdict (observed === null) expires after a short TTL so a
 * transient blip self-heals. The cached definitive false is the load-bearing
 * defense: one real mismatch and we never route RPC to that operator again.
 *
 * Preferred probe: `lyth_chainStats.genesisHash`, which is the chain
 * identity hash used by the registry and p2p binding. Fallback probe:
 * block-0's EVM header hash, compared against TESTNET_BLOCK0_HASH. The
 * two pins are separate because protocore does not define them as the
 * same hash.
 *
 * Used by:
 *  - probeFirstAliveOperator (defense-in-depth against orphan fork)
 *  - testnet-operators-health IPC (About-page table)
 *  - tx-mldsa.testnetJsonRpc (read/write dispatch skip-list)
 */
export async function verifyOperatorGenesis(
  rpc: string,
  timeoutMs: number = 3_000,
): Promise<boolean> {
  const cached = operatorGenesisCache.get(rpc);
  if (cached !== undefined) {
    // A DEFINITIVE read (observed a genesis / block-0 hash) is immutable per
    // chain → cache it forever (a real mismatch must never be re-trusted; a
    // real match never needs re-probing). But a NON-definitive read
    // (observed === null: the operator was unreachable, timed out, or runs an
    // old binary that doesn't expose the probe) is TRANSIENT — keep it only
    // for a short TTL so a momentary blip self-heals on the next probe instead
    // of de-trusting an otherwise-good operator for the whole SW lifetime.
    // This was the load-bearing wedge behind the perpetual OFFLINE: one bad
    // moment cached `false` forever.
    if (cached.observed !== null) return cached.ok;
    if (Date.now() - cached.checkedAt < GENESIS_OBSERVED_NULL_TTL_MS) {
      return cached.ok;
    }
    // TTL expired on a non-definitive entry — fall through and re-probe.
  }
  const result = await probeOperatorGenesis(rpc, timeoutMs);
  operatorGenesisCache.set(rpc, result);
  // A definitive verdict is immutable per chain — persist it so the next SW
  // wake skips the genesis round-trips instead of re-probing from an empty
  // in-memory cache. Non-definitive reads keep their short TTL and re-probe.
  if (result.observed !== null) persistGenesisCache();
  return result.ok;
}

/** TTL for a NON-definitive genesis-cache entry (observed === null:
 *  unreachable / timeout / probe-unsupported). Definitive reads (a real
 *  observed hash, match or mismatch) are cached forever; only the
 *  "couldn't read" verdict expires, so a transient outage self-heals. */
const GENESIS_OBSERVED_NULL_TTL_MS = 60_000;

/** Force-refresh a single operator's genesis check. Surfaced via the
 *  About-page probe so the user can re-evaluate after a regenesis. */
export function clearGenesisCache(rpc?: string): void {
  if (rpc === undefined) {
    operatorGenesisCache.clear();
    operatorWrongChainId.clear();
  } else {
    operatorGenesisCache.delete(rpc);
    operatorWrongChainId.delete(rpc);
  }
  // Mirror the eviction into the persisted blob so a force-refresh after a
  // regenesis can't leave a stale verdict to be rehydrated on the next wake.
  persistGenesisCache();
}

/** Snapshot of operators seen reachable-but-on-the-wrong-chain-id. Used by
 *  classifyNoOperatorReason (default) and injectable for unit tests. */
export function snapshotWrongChainOperators(): Set<string> {
  return new Set(operatorWrongChainId);
}

/** Snapshot of the current cache state. Used by
 *  testnet-operators-health to assemble the per-operator response
 *  without re-probing when the entry is fresh in-memory. */
export function snapshotGenesisCache(): Map<string, GenesisCacheEntry> {
  return new Map(operatorGenesisCache);
}

/**
 * Non-awaiting, no-RPC predicate: `true` ONLY when the active operator list is
 * non-empty AND every active operator already carries a sticky DEFINITIVE
 * verdict against it — either a genesis MISMATCH (`ok === false &&
 * observed !== null`, the exact test `classifyNoOperatorReason` uses) OR a
 * recorded wrong-chain-id. Any operator that is absent / `observed === null`
 * (the 60 s "couldn't read" TTL) / `ok === true` → returns `false`, so the
 * caller falls through to the real gated walk and a recovering operator is
 * still tried.
 *
 * This reads the SAME live cache the gate writes; it NEVER bypasses the gate.
 * It only lets a read fast-fail when the gate has ALREADY decided every
 * operator is untrusted — turning the exhaustive re-walk-per-read (the
 * re-genesis UI hang) into one cache read. The throw it enables serves zero
 * chain data (R1). Reads the live module sets (not snapshots) so it reflects
 * the current verdict at call time.
 */
export function allActiveOperatorsDefinitivelyUntrusted(): boolean {
  const ops = getActiveOperators();
  if (ops.length === 0) return false;
  for (const op of ops) {
    const e = operatorGenesisCache.get(op.rpc);
    const genesisMismatch = e !== undefined && e.ok === false && e.observed !== null;
    if (!(genesisMismatch || operatorWrongChainId.has(op.rpc))) return false;
  }
  return true;
}

/**
 * Classify why no operator is serviceable (probeFirstAliveOperator returned
 * null) for the chain-status banner — WITHOUT a new RPC. An ACTIVE operator is
 * "untrusted" (reachable but wrong) when EITHER it answered net_version with a
 * MISMATCHING chain id (in `wrongChainId`) OR its sticky genesis-cache entry
 * recorded a MISMATCHING hash (ok===false && observed!==null). Both mean the
 * operator answered but serves the wrong chain. An absent / observed:null
 * genesis entry with no wrong-chain mark (truly unreachable, or a block-0 the
 * probe couldn't read) -> "unreachable". ok===true (incl. the #18
 * probe-unsupported fail-open) is trusted. Untrusted is sticky and
 * intentionally OUTRANKS unreachable. Params default to the live sources but
 * are injectable for unit tests.
 */
export function classifyNoOperatorReason(
  activeOps: ReadonlyArray<{ rpc: string }> = getActiveOperators(),
  genesis: Map<string, GenesisCacheEntry> = snapshotGenesisCache(),
  wrongChainId: ReadonlySet<string> = operatorWrongChainId,
): "unreachable" | "untrusted" {
  for (const op of activeOps) {
    const e = genesis.get(op.rpc);
    const genesisMismatch =
      e !== undefined && e.ok === false && e.observed !== null;
    if (genesisMismatch || wrongChainId.has(op.rpc)) {
      return "untrusted";
    }
  }
  return "unreachable";
}

/** One-shot fetch + compare. Always returns a cache entry — never
 *  throws — so the cache write path is non-throwing too. */
async function probeOperatorGenesis(
  rpc: string,
  timeoutMs: number,
): Promise<GenesisCacheEntry> {
  const now = Date.now();

  const stats = await rpcCall(rpc, timeoutMs, "lyth_chainStats", []);
  if (stats.ok) {
    const result = readObject(stats.body, "result");
    const observed = normaliseHash(result?.genesisHash);
    if (observed !== null) {
      return {
        ok: observed === TESTNET_GENESIS_HASH.toLowerCase(),
        observed,
        checkedAt: now,
      };
    }
  }

  const block0 = await rpcCall(rpc, timeoutMs, "eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  if (!block0.ok) {
    return { ok: false, observed: null, checkedAt: now };
  }
  const body = block0.body as {
    result?: { hash?: unknown } | null;
  };
  // GAP #11 — older operator binaries did not expose block 0 via
  // eth_getBlockByNumber("0x0", false). That remains "probe not
  // supported" instead of orphan-fork evidence; newer binaries are
  // verified against TESTNET_BLOCK0_HASH.
  if (body?.result == null) {
    console.info(
      "[probe] genesis probes unsupported on operator (ok=true, pin skipped):",
      rpc,
    );
    return { ok: true, observed: null, checkedAt: now };
  }
  const observed = normaliseHash(body.result.hash);
  if (observed === null) {
    return { ok: false, observed: null, checkedAt: now };
  }
  return {
    ok: observed === TESTNET_BLOCK0_HASH.toLowerCase(),
    observed,
    checkedAt: now,
  };
}

async function rpcCall(
  rpc: string,
  timeoutMs: number,
  method: string,
  params: unknown[],
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function readObject(
  input: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function normaliseHash(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (!/^0[xX][0-9a-fA-F]{64}$/.test(input)) return null;
  return input.toLowerCase();
}
