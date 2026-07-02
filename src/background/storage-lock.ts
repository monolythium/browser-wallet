// Per-key serialization for `chrome.storage.local` read-modify-write paths.
//
// Why this exists
// ===============
// Several SW paths do an async read-modify-write on the SAME per-(address,chain)
// storage key — the pending-activity store, the durable local-claims store, the
// sent-address log, and the notification history. None were serialized, so two
// concurrent writers (a burst of broadcasts each firing
// `persistPendingRowBackground`, or the popup snapshot racing the headless poll)
// could BOTH read the same prior value and then last-write-wins clobber each
// other — dropping a just-added pending row or a just-recorded notification.
//
// MV3 runs a SINGLE service-worker instance, so every racing writer is a
// concurrent ASYNC op within one JS context (not a cross-process race). A per-key
// promise chain fully serializes them: each op runs only after the prior op for
// that key settles. This mirrors the existing `inflightProbes` `Map<string,
// Promise>` idiom in networks.ts (which COALESCES per-key probes); here we CHAIN
// instead so each op runs to completion before the next begins.
//
// Error-safe: a throwing op does NOT break the chain for later ops (the stored
// tail swallows the error; the caller still sees the real result/error). The
// in-memory Map is discarded on SW teardown, so a torn-down SW leaves no stuck
// lock (an interrupted in-flight write is the pre-existing best-effort risk,
// unchanged).

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` under a per-`key` lock: it executes only after the prior op for the
 *  same `key` has settled, and the next caller for `key` waits for `fn` in turn.
 *  Ops on DIFFERENT keys run concurrently.
 *
 *  GOVERNING RULE for callers: do the FULL read-modify-write INSIDE `fn`
 *  (re-read the freshest value, compute, write) — never write a value computed
 *  from a read taken before acquiring the lock, or a concurrent writer's update
 *  is still clobbered.
 *
 *  DEADLOCK SAFETY: never acquire the SAME key recursively from within `fn` — it
 *  would await itself. Distinct keys may be acquired sequentially (not nested).
 *
 *  The returned promise resolves/rejects with `fn`'s real result; a rejection
 *  does not break the chain for the next caller. */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // `prior` is always a swallowed tail (below) → it never rejects, so `fn`
  // always runs after the prior op settles (success OR failure).
  const prior = chains.get(key) ?? Promise.resolve();
  const run = prior.then(() => fn());
  // Store a non-throwing tail so one failing op never poisons the chain.
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  // Drain: once this is the last queued op for the key, drop the entry so the
  // Map can't grow unbounded across many distinct keys.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Test-only: number of keys with a live (still-queued) lock chain. Lets a test
 *  assert the Map drains after all ops settle (no unbounded growth). */
export function _activeLockKeyCount(): number {
  return chains.size;
}
