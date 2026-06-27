// Monolythium Wallet — network constants and chain capabilities.
//
// Chain markers indicating which signing path the wallet should use.
// ML-DSA-65 is mandatory on Monolythium Testnet (chain_id 69420);
// other Ethereum-compatible chains keep the legacy secp256k1 path.

import { MONOLYTHIUM_TESTNET_CHAIN_ID, getRpcEndpoints } from "@monolythium/core-sdk";
import {
  STORAGE_KEY_OPERATOR_OVERRIDE,
  validateOperatorList,
  type OperatorEntry,
} from "../shared/operators.js";
import { isHardenedBuild } from "../shared/build-mode.js";
import { hardenedOperators } from "../shared/hardened-dial.js";
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

// T4-04 (Item D) — the per-execution-unit PRICE de-trust ceiling
// (`MAX_EXECUTION_UNIT_PRICE_LYTHOSHI`) moved to `shared/operator-bounds.ts`,
// next to its `clampToSaneBound` consumer, so the popup can import the ceiling
// for display (P3-004) without pulling in this background RPC graph. Value +
// semantics unchanged; the clamp sites import it from the shared module.

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
      // Hardened builds ignore the stored override (it would brick RPC under
      // the strict connect-src) and always dial the allowlisted defaults.
      activeOperators = hardenedOperators(
        TESTNET_OPERATOR_RPCS_DEFAULTS,
        validated,
        isHardenedBuild(),
      );
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
  // Hardened builds never apply an override in memory (it would brick RPC under
  // the strict connect-src). The override is still persisted so a later dev
  // build honors it; in a hardened build the in-memory set stays the defaults.
  activeOperators = hardenedOperators(
    TESTNET_OPERATOR_RPCS_DEFAULTS,
    override,
    isHardenedBuild(),
  );
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
  /** True when the operator answered with a -32047 "chain quarantined" error
   *  (same chain, self-quarantined on a checkpoint state-root mismatch).
   *  Distinct from a different-genesis (observed !== null) and from plain
   *  unreachable (no flag). In-memory only — observed is null on quarantine,
   *  so this entry is never persisted (the persist gate is `observed !== null`). */
  quarantined?: boolean;
}

const operatorGenesisCache = new Map<string, GenesisCacheEntry>();

// C2: coalesce concurrent genesis probes to the SAME operator. During the first
// cold walk (or a 60 s-TTL re-probe) N concurrent reads would each launch an
// independent probe to a given rpc — the cache only dedups AFTER the first
// settles. This collapses them to one in-flight probe per rpc. Cleared on
// settle; cache TTL / verdict semantics are unchanged.
const inflightProbes = new Map<string, Promise<GenesisCacheEntry>>();

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
// C6 (R3): bumped to v2 — the persisted blob is now pin-QUALIFIED
// (`{ pin, entries }`). A pre-C6 v1 blob (un-qualified) lives at the old key and
// is never read, so it can never be rehydrated as trusted.
export const SESSION_KEY_GENESIS_CACHE = "mono.session.genesis-cache.v2";

/** Identity the persisted genesis blob is qualified by. If EITHER pin changes
 *  (a re-pin build), a blob persisted under the old identity is DROPPED on
 *  rehydrate → full re-probe against the new pin, so a stale-pin verdict can
 *  never be silently re-trusted (R3). */
function currentGenesisPinTag(): string {
  return `${TESTNET_GENESIS_HASH.toLowerCase()}|${TESTNET_BLOCK0_HASH.toLowerCase()}`;
}

/** Best-effort persist the DEFINITIVE subset of the genesis cache. Overwrites
 *  the whole blob (a handful of operators) so an eviction in clearGenesisCache
 *  is mirrored too. Synchronous guard covers a missing chrome.storage in tests. */
function persistGenesisCache(): void {
  try {
    const entries: Record<string, GenesisCacheEntry> = {};
    for (const [rpc, e] of operatorGenesisCache) {
      if (e.observed !== null) entries[rpc] = e;
    }
    // C6 (R3): qualify the blob with the current pin identity so a re-pin drops
    // it on rehydrate instead of trusting a stale-pin verdict.
    void chrome.storage.session
      .set({
        [SESSION_KEY_GENESIS_CACHE]: { pin: currentGenesisPinTag(), entries },
      })
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
    const blob = s?.[SESSION_KEY_GENESIS_CACHE] as
      | { pin?: unknown; entries?: unknown }
      | undefined;
    if (!blob || typeof blob !== "object") return;
    // C6 (R3): only trust a blob persisted under the CURRENT pin. A re-pin (or
    // any malformed / pin-less blob) → drop it entirely → full re-probe against
    // the live pin. A stale-pin verdict can NEVER be rehydrated as trusted.
    if (blob.pin !== currentGenesisPinTag()) return;
    const raw = blob.entries as Record<string, unknown> | undefined;
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
    // C6 (R3): a definitive MISMATCH is sticky forever — it keeps the wallet
    // paused until the operator/pin is resolved and must never be silently
    // re-trusted. A definitive PASS is bounded by a re-probe TTL so an operator
    // that passed once then SILENTLY FORKED within this SW lifetime is
    // re-detected within a bounded window; within the TTL the cached pass is
    // trusted. A NON-definitive "couldn't read" keeps its existing short TTL.
    if (cached.observed !== null) {
      if (cached.ok === false) return false;
      if (Date.now() - cached.checkedAt < GENESIS_POSITIVE_TTL_MS) return true;
      // positive verdict aged out → fall through and re-probe.
    } else if (Date.now() - cached.checkedAt < GENESIS_OBSERVED_NULL_TTL_MS) {
      return cached.ok;
    }
    // TTL expired (positive or non-definitive) — fall through and re-probe.
  }
  // Share one in-flight probe per rpc across concurrent callers (C2).
  let pending = inflightProbes.get(rpc);
  if (pending === undefined) {
    pending = probeOperatorGenesis(rpc, timeoutMs).finally(() => {
      inflightProbes.delete(rpc);
    });
    inflightProbes.set(rpc, pending);
  }
  const result = await pending;
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

/** C6 (R3): re-probe TTL for a DEFINITIVE positive ("passed") verdict. A pass is
 *  bounded (not forever) so an operator that passed once then silently forked
 *  while the SW is alive is re-detected within this window. A definitive MISMATCH
 *  stays sticky (no TTL) — it correctly keeps the wallet paused until resolved. */
const GENESIS_POSITIVE_TTL_MS = 60_000;

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
 * C7: pure-cache, no-RPC check — is this ONE operator definitively untrusted (a
 * sticky genesis MISMATCH, or a recorded wrong-chain-id)? Used to gate the
 * liveness block-poll's cached-operator fast-path so the CONNECTING / LIVE
 * indicator never reflects a re-genesis'd operator that would still answer
 * `eth_blockNumber`, WITHOUT re-adding a genesis round-trip to the health fast
 * path. Unknown / `observed:null` / trusted → false (the caller proceeds
 * normally; recovery is preserved).
 */
export function operatorDefinitivelyUntrusted(rpc: string): boolean {
  const e = operatorGenesisCache.get(rpc);
  const genesisMismatch =
    e !== undefined && e.ok === false && e.observed !== null;
  return genesisMismatch || operatorWrongChainId.has(rpc);
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
): "unreachable" | "untrusted" | "regenesis" | "quarantined" {
  // C5: split the genesis-MISMATCH case out of the generic "untrusted". An
  // operator that answered with the right chain id but a DIFFERENT genesis hash
  // (ok===false && observed!==null, NOT in wrongChainId) means the network
  // re-genesised — an actionable "update the wallet pin" signal, distinct from
  // an operator pointed at another chain id ("untrusted"). `regenesis` outranks
  // `untrusted` (it is the operator-actionable cause); both outrank
  // `unreachable`. The fund-path gate is unchanged — this only labels WHY no
  // operator is serviceable, with NO new RPC.
  //
  // "quarantined" (every active op self-quarantined on a checkpoint state-root
  // mismatch — same chain, refusing RPC) is surfaced ONLY when the WHOLE fleet
  // is quarantined, so the banner reads "OPERATOR QUARANTINED" instead of a
  // generic OFFLINE. A single quarantined op with a healthy failover never
  // reaches here (the poll resolves healthy). Reuses the per-op quarantine flag
  // the genesis probe already records; still NO new RPC.
  let sawWrongChain = false;
  let allQuarantined = activeOps.length > 0;
  for (const op of activeOps) {
    if (wrongChainId.has(op.rpc)) {
      sawWrongChain = true;
      allQuarantined = false;
      continue;
    }
    const e = genesis.get(op.rpc);
    const genesisMismatch =
      e !== undefined && e.ok === false && e.observed !== null;
    if (genesisMismatch) {
      return "regenesis";
    }
    if (e?.quarantined !== true) allQuarantined = false;
  }
  if (sawWrongChain) return "untrusted";
  if (allQuarantined) return "quarantined";
  return "unreachable";
}

/** One-shot fetch + compare. Always returns a cache entry — never
 *  throws — so the cache write path is non-throwing too. */
/** True when a JSON-RPC body is an operator self-quarantine error
 *  (CheckpointStateRootMismatch / "chain quarantined"). A quarantined node
 *  knowingly serves stale/forked state and rejects RPC, so it must NOT be
 *  fail-open-trusted (pin-skipped) or selected as the active operator — it
 *  rejects the liveness eth_blockNumber the same way, which otherwise shows a
 *  false OFFLINE while the healthy operators sit unused. Resolves to a
 *  non-definitive verdict (short TTL) so the operator self-heals once it
 *  clears the quarantine. */
function isQuarantineError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as { error?: { message?: unknown } }).error;
  if (typeof err !== "object" || err === null) return false;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && /quarantin/i.test(msg);
}

async function probeOperatorGenesis(
  rpc: string,
  timeoutMs: number,
): Promise<GenesisCacheEntry> {
  const now = Date.now();

  const stats = await rpcCall(rpc, timeoutMs, "lyth_chainStats", []);
  if (stats.ok) {
    if (isQuarantineError(stats.body)) {
      return { ok: false, observed: null, checkedAt: now, quarantined: true };
    }
    const result = readObject(stats.body, "result");
    const observed = normaliseHash(result?.genesisHash);
    if (observed !== null) {
      return {
        ok: observed === TESTNET_GENESIS_HASH.toLowerCase(),
        observed,
        checkedAt: now,
      };
    }
  } else {
    // Fail fast on an UNREACHABLE operator. `stats.ok === false` means the
    // chainStats call had a TRANSPORT failure (timeout / connection refused) —
    // the operator is down. The block-0 fallback below exists only for an
    // operator that ANSWERED chainStats (stats.ok) but is too old to expose
    // `genesisHash`; against a dead operator it would just time out a SECOND
    // time, DOUBLING an unreachable op's probe latency (~timeoutMs → ~2×). That
    // doubled latency is what dragged the balance consensus + the first liveness
    // poll past their budgets when a fake/offline operator was in the set, so a
    // dead operator now costs one timeout, not two. (A real operator missing
    // chainStats replies with a method-not-found ERROR, i.e. stats.ok === true,
    // so it still reaches the block-0 fallback.)
    return { ok: false, observed: null, checkedAt: now };
  }

  const block0 = await rpcCall(rpc, timeoutMs, "eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  if (!block0.ok) {
    return { ok: false, observed: null, checkedAt: now };
  }
  if (isQuarantineError(block0.body)) {
    return { ok: false, observed: null, checkedAt: now, quarantined: true };
  }
  const body = block0.body as {
    result?: { hash?: unknown } | null;
  };
  // GAP #11 — older operator binaries did not expose block 0 via
  // eth_getBlockByNumber("0x0", false). That remains "probe not
  // supported" instead of orphan-fork evidence; newer binaries are
  // verified against TESTNET_BLOCK0_HASH.
  if (body?.result == null) {
    // Fail-CLOSED (was fail-open). An operator that exposes NEITHER
    // lyth_chainStats.genesisHash NOR a block-0 hash proves nothing about its
    // chain identity, so it must NOT be trusted — otherwise a fake / partial
    // endpoint that merely answers net_version (right chain id) + eth_blockNumber
    // is selected as alive and shows a false LIVE while serving an unverified
    // chain. The live fleet all expose lyth_chainStats.genesisHash (checked
    // 2026-06-15), so no honest operator is bricked by this (F-3.1 / #18 /
    // S3-01).
    console.info(
      "[probe] operator exposes no genesis proof — UNTRUSTED (fail-closed):",
      rpc,
    );
    return { ok: false, observed: null, checkedAt: now };
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
