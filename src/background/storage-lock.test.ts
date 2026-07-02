import { describe, it, expect } from "vitest";
import { withKeyLock, _activeLockKeyCount } from "./storage-lock.js";

/** A manually-resolvable promise for driving interleavings deterministically. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withKeyLock", () => {
  it("serializes concurrent ops on the SAME key (no overlap, FIFO)", async () => {
    const events: string[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    const op1 = withKeyLock("k", async () => {
      events.push("1:start");
      await gate1.promise;
      events.push("1:end");
      return 1;
    });
    // Queued while op1 holds the lock — must not start until op1 ends.
    const op2 = withKeyLock("k", async () => {
      events.push("2:start");
      await gate2.promise;
      events.push("2:end");
      return 2;
    });

    // Let microtasks flush; op2 must NOT have started yet.
    await Promise.resolve();
    expect(events).toEqual(["1:start"]);

    gate1.resolve();
    expect(await op1).toBe(1);
    // op2 starts only after op1 fully settled.
    await Promise.resolve();
    expect(events).toEqual(["1:start", "1:end", "2:start"]);

    gate2.resolve();
    expect(await op2).toBe(2);
    expect(events).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("a throwing op does NOT break the chain for later ops", async () => {
    const events: string[] = [];
    const failing = withKeyLock("k2", async () => {
      events.push("fail:start");
      throw new Error("boom");
    });
    const next = withKeyLock("k2", async () => {
      events.push("next:start");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom"); // caller sees the real error
    expect(await next).toBe("ok"); // chain survived
    expect(events).toEqual(["fail:start", "next:start"]);
  });

  it("ops on DIFFERENT keys run concurrently", async () => {
    const events: string[] = [];
    const gateA = deferred();
    const a = withKeyLock("A", async () => {
      events.push("A:start");
      await gateA.promise;
      events.push("A:end");
    });
    const b = withKeyLock("B", async () => {
      events.push("B:start");
    });

    await b; // B completes while A is still blocked on its gate
    expect(events).toContain("A:start");
    expect(events).toContain("B:start");
    expect(events).not.toContain("A:end");

    gateA.resolve();
    await a;
    expect(events).toContain("A:end");
  });

  it("interleaved read-modify-write on one key never loses an update (lost-update repro)", async () => {
    // Shared store guarded by the lock. Without the lock, two read-modify-writes
    // that both read [] would each write a 1-element array → last-write-wins loses
    // one. Under withKeyLock they serialize and BOTH land.
    let store: number[] = [];
    const rmw = (n: number) =>
      withKeyLock("store", async () => {
        const prev = store; // read
        await Promise.resolve(); // yield — invites interleaving
        store = [...prev, n]; // modify + write
      });

    await Promise.all([rmw(1), rmw(2), rmw(3), rmw(4), rmw(5)]);
    expect(store.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains the key map after all ops settle (no unbounded growth)", async () => {
    await withKeyLock("drain", async () => {});
    // After settle the drain microtask removes the key.
    await Promise.resolve();
    await Promise.resolve();
    expect(_activeLockKeyCount()).toBe(0);
  });
});
