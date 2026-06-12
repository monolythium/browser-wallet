// Mount-time hydration orchestration for the popup.
//
// Perf: on every popup open the mount bootstrap (App's refreshKeystoreStatus)
// must hydrate the active account, the active vault summary, and the chain
// state before the home screen is fully populated. These three loads are
// MUTUALLY INDEPENDENT — none consumes another's result, and chain state is
// not keyed by the active account — so running them serially (the prior
// shape) paid three round-trip latencies for no reason. Running them
// concurrently collapses the gate to a single round-trip latency.
//
// Isolation: Promise.allSettled (not Promise.all) so a single load's IPC
// rejection cannot strand the others. The prior serial `await a; await b; await
// c` dropped every later load the instant an earlier one threw — this is
// strictly more resilient.
//
// Contract preserved: this still resolves only after ALL applicable loads have
// settled, so every caller of refreshKeystoreStatus stays fully hydrated — the
// home screen flips from "Loading…" straight to a complete render (real
// account, real vault label, real chain), just faster. It deliberately does
// NOT paint early / defer loads: an early paint would flash the demo-fixture
// account (ACCOUNTS[0]) before the real one resolves — the exact "placeholder
// wrong values" the parallelization is meant to remove.
//
// Extracted + exported (rather than inlined in App) so the parallel + resilient
// + algo-gated contract is unit-testable without rendering the whole App tree.

/** The three independent hydration loads, passed as already-bound thunks so
 *  this stays a pure orchestration unit (no App-state coupling). */
export interface MountHydrationLoads {
  /** Patch `acc` with the real unlocked v3 identity. mldsa only — slhdsa has
   *  no v3 vault to load. */
  loadActiveAccount: () => Promise<void>;
  /** Track the active vault summary (multisig detection + chip label). mldsa
   *  only, same reason. */
  loadActiveVaultSummary: () => Promise<void>;
  /** Active chain id + chain list. Always run (independent of the keystore
   *  algo). */
  loadChainState: () => Promise<void>;
}

/**
 * Run the post-keystore mount hydration loads concurrently with per-load
 * isolation. `algo` gates the two v3-vault loads to mldsa keystores; chain
 * state always runs. Resolves once every applicable load has settled.
 */
export async function runMountHydrationLoads(
  algo: string,
  loads: MountHydrationLoads,
): Promise<void> {
  const isMldsa = algo === "mldsa";
  await Promise.allSettled([
    isMldsa ? loads.loadActiveAccount() : Promise.resolve(),
    isMldsa ? loads.loadActiveVaultSummary() : Promise.resolve(),
    loads.loadChainState(),
  ]);
}
