// Send-idempotency binding store.
//
// A binding pins ONE user confirmation to the signed bytes produced for it, so
// a retry of that confirmation re-broadcasts those exact bytes instead of
// re-deriving and re-signing. Re-signing would produce different bytes (ML-DSA
// is hedged), which in the pooled window is ReplaceUnderpriced — classified as a
// reject and thrown, reporting a landed send as failed.
//
// The pure map helpers are tested here without a chrome stub; the storage
// wrappers are exercised through a minimal stub at the end.

import { beforeEach, describe, expect, it } from "vitest";

import {
  SEND_BINDING_TTL_MS,
  STORAGE_KEY_SEND_BINDINGS,
  deleteSendBinding,
  pruneExpired,
  readSendBinding,
  readValidBinding,
  withBinding,
  withoutBinding,
  writeSendBinding,
  type SendBinding,
  type SendBindingMap,
} from "./send-binding";

const T0 = 1_700_000_000_000;

function bindingAt(ts: number): SendBinding {
  return { nonceHex: "0x7", wireHex: "0xdeadbeef", txHashHex: "0xabc", ts };
}

describe("SEND_BINDING_TTL_MS", () => {
  it("is 15 minutes — 3x the 5-minute pending-nonce window it must outlive", () => {
    expect(SEND_BINDING_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("readValidBinding — a binding is usable only inside its TTL", () => {
  it("returns the binding well inside the window", () => {
    const map: SendBindingMap = { k1: bindingAt(T0) };
    expect(readValidBinding(map, "k1", T0 + 1000)).toEqual(bindingAt(T0));
  });

  it("returns null for an unknown key", () => {
    expect(readValidBinding({}, "nope", T0)).toBeNull();
  });

  it("returns null once the TTL has elapsed — an orphan must not resurrect", () => {
    const map: SendBindingMap = { k1: bindingAt(T0) };
    expect(readValidBinding(map, "k1", T0 + SEND_BINDING_TTL_MS + 1)).toBeNull();
  });

  it("is still valid at exactly the TTL boundary", () => {
    const map: SendBindingMap = { k1: bindingAt(T0) };
    expect(readValidBinding(map, "k1", T0 + SEND_BINDING_TTL_MS)).not.toBeNull();
  });

  it("returns null for a malformed entry rather than handing back a partial", () => {
    // A truncated write must never produce a re-broadcast of nothing.
    const map = { k1: { nonceHex: "0x7" } } as unknown as SendBindingMap;
    expect(readValidBinding(map, "k1", T0)).toBeNull();
  });
});

describe("withBinding / withoutBinding — immutable map edits", () => {
  it("adds without mutating the input", () => {
    const map: SendBindingMap = {};
    const next = withBinding(map, "k1", bindingAt(T0));
    expect(next.k1).toEqual(bindingAt(T0));
    expect(map).toEqual({});
  });

  it("removes without mutating the input", () => {
    const map: SendBindingMap = { k1: bindingAt(T0), k2: bindingAt(T0) };
    const next = withoutBinding(map, "k1");
    expect(next).toEqual({ k2: bindingAt(T0) });
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("removing an absent key is a no-op, not a throw", () => {
    expect(withoutBinding({ k2: bindingAt(T0) }, "k1")).toEqual({
      k2: bindingAt(T0),
    });
  });
});

describe("pruneExpired — the TTL is a backstop, not the cleanup", () => {
  it("drops only entries past the TTL", () => {
    const map: SendBindingMap = {
      fresh: bindingAt(T0),
      stale: bindingAt(T0 - SEND_BINDING_TTL_MS - 1),
    };
    expect(pruneExpired(map, T0)).toEqual({ fresh: bindingAt(T0) });
  });

  it("drops malformed entries too", () => {
    const map = {
      good: bindingAt(T0),
      bad: { wireHex: "0x1" },
    } as unknown as SendBindingMap;
    expect(Object.keys(pruneExpired(map, T0))).toEqual(["good"]);
  });
});

describe("storage wrappers", () => {
  let local: Record<string, unknown>;

  beforeEach(() => {
    local = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) if (k in local) out[k] = local[k];
            cb(out);
          },
          set: (items: Record<string, unknown>, cb: () => void) => {
            Object.assign(local, items);
            cb();
          },
        },
      },
    };
  });

  it("writes to chrome.storage.local under the versioned key", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    expect(local[STORAGE_KEY_SEND_BINDINGS]).toEqual({ k1: bindingAt(T0) });
  });

  it("round-trips a written binding", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    expect(await readSendBinding("k1", T0 + 1)).toEqual(bindingAt(T0));
  });

  it("stores ONLY signed-transaction fields — never a password or mnemonic", async () => {
    // The binding is written to DISK. Pin its shape so no future field can
    // smuggle a secret into local storage.
    await writeSendBinding("k1", bindingAt(T0));
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap).k1!;
    expect(Object.keys(stored).sort()).toEqual([
      "nonceHex",
      "ts",
      "txHashHex",
      "wireHex",
    ]);
  });

  it("deletes eagerly — the entry is gone, not just expired", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    await deleteSendBinding("k1");
    expect(local[STORAGE_KEY_SEND_BINDINGS]).toEqual({});
    expect(await readSendBinding("k1", T0 + 1)).toBeNull();
  });

  it("a read past the TTL returns null even though the row is still on disk", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    expect(await readSendBinding("k1", T0 + SEND_BINDING_TTL_MS + 1)).toBeNull();
  });

  it("reading an absent store yields null, not a throw", async () => {
    expect(await readSendBinding("k1", T0)).toBeNull();
  });
});
