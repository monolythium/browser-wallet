import { describe, expect, it, vi } from "vitest";
import {
  runMountHydrationLoads,
  type MountHydrationLoads,
} from "./mount-hydration";

// Deferred resolver so a test can control exactly when a load settles and
// assert ordering / concurrency rather than relying on microtask timing.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function spyLoads(impls?: Partial<MountHydrationLoads>): {
  loads: MountHydrationLoads;
  loadActiveAccount: ReturnType<typeof vi.fn>;
  loadActiveVaultSummary: ReturnType<typeof vi.fn>;
  loadChainState: ReturnType<typeof vi.fn>;
} {
  const loadActiveAccount = vi.fn(
    impls?.loadActiveAccount ?? (() => Promise.resolve()),
  );
  const loadActiveVaultSummary = vi.fn(
    impls?.loadActiveVaultSummary ?? (() => Promise.resolve()),
  );
  const loadChainState = vi.fn(
    impls?.loadChainState ?? (() => Promise.resolve()),
  );
  return {
    loads: { loadActiveAccount, loadActiveVaultSummary, loadChainState },
    loadActiveAccount,
    loadActiveVaultSummary,
    loadChainState,
  };
}

describe("runMountHydrationLoads", () => {
  it("mldsa: fires all three loads", async () => {
    const s = spyLoads();
    await runMountHydrationLoads("mldsa", s.loads);
    expect(s.loadActiveAccount).toHaveBeenCalledTimes(1);
    expect(s.loadActiveVaultSummary).toHaveBeenCalledTimes(1);
    expect(s.loadChainState).toHaveBeenCalledTimes(1);
  });

  it("non-mldsa (slhdsa): skips the v3-vault loads, still loads chain state", async () => {
    const s = spyLoads();
    await runMountHydrationLoads("slhdsa", s.loads);
    expect(s.loadActiveAccount).not.toHaveBeenCalled();
    expect(s.loadActiveVaultSummary).not.toHaveBeenCalled();
    expect(s.loadChainState).toHaveBeenCalledTimes(1);
  });

  it("runs the loads concurrently, not serially", async () => {
    // Each load blocks on its own deferred. If the orchestration were serial,
    // only the first would have started before any resolves. Concurrent means
    // all three are in-flight simultaneously.
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const s = spyLoads({
      loadActiveAccount: () => a.promise,
      loadActiveVaultSummary: () => b.promise,
      loadChainState: () => c.promise,
    });
    const done = runMountHydrationLoads("mldsa", s.loads);
    // All three started before any settled → concurrent.
    expect(s.loadActiveAccount).toHaveBeenCalledTimes(1);
    expect(s.loadActiveVaultSummary).toHaveBeenCalledTimes(1);
    expect(s.loadChainState).toHaveBeenCalledTimes(1);
    a.resolve();
    b.resolve();
    c.resolve();
    await expect(done).resolves.toBeUndefined();
  });

  it("isolates a single load's rejection — the others still run and it does not throw", async () => {
    const s = spyLoads({
      loadActiveAccount: () => Promise.reject(new Error("account IPC failed")),
    });
    // allSettled, not all: the rejection must NOT prevent the sibling loads
    // from firing, and the orchestration must resolve (never reject).
    await expect(
      runMountHydrationLoads("mldsa", s.loads),
    ).resolves.toBeUndefined();
    expect(s.loadActiveVaultSummary).toHaveBeenCalledTimes(1);
    expect(s.loadChainState).toHaveBeenCalledTimes(1);
  });

  it("resolves only after every applicable load has settled", async () => {
    const c = deferred();
    let settled = false;
    const s = spyLoads({ loadChainState: () => c.promise });
    const done = runMountHydrationLoads("mldsa", s.loads).then(() => {
      settled = true;
    });
    // chain state still pending → orchestration not yet resolved.
    await Promise.resolve();
    expect(settled).toBe(false);
    c.resolve();
    await done;
    expect(settled).toBe(true);
  });
});
