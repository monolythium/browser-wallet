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

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEND_BINDING_TTL_MS,
  STORAGE_KEY_SEND_BINDINGS,
  SendBindingMismatchError,
  completeSendBinding,
  deleteSendBinding,
  isCompleted,
  pruneExpired,
  readSendBinding,
  readValidBinding,
  withBinding,
  withSendBinding,
  withoutBinding,
  writeSendBinding,
  type SendBinding,
  type SendBindingMap,
} from "./send-binding";

const T0 = 1_700_000_000_000;

function bindingAt(ts: number): SendBinding {
  return {
    nonceHex: "0x7",
    wireHex: "0xdeadbeef",
    txHashHex: "0xabc",
    via: "",
    ts,
    from: "0xsender",
    chainIdHex: "0x10F2C",
  };
}

/** A record in the pre-`from`/`chainIdHex` shape — what is already on disk when
 *  this change lands. Used to prove those records stay valid and keep replaying,
 *  which is why the new fields are optional and unvalidated. */
function legacyBindingAt(ts: number): SendBinding {
  return { nonceHex: "0x7", wireHex: "0xdeadbeef", txHashHex: "0xabc", via: "", ts };
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
    // smuggle a secret into local storage. Every key here is a public chain
    // value or a public address.
    //
    // PAIRED with "a completion record carries the same fields" below. The two
    // must move together: updating only this one would leave a field that
    // survives the bind and vanishes at completion, which is the one state an
    // account-level lookup actually reads.
    await writeSendBinding("k1", bindingAt(T0));
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap).k1!;
    expect(Object.keys(stored).sort()).toEqual([
      "chainIdHex",
      "from",
      "nonceHex",
      "ts",
      "txHashHex",
      "via",
      "wireHex",
    ]);
  });

  it("a record written before the account fields existed is still valid", async () => {
    // Those fields are optional and unvalidated on purpose. If they were
    // required, every record already on disk would read as null — and null means
    // the caller signs afresh and derives a NEW nonce, which is the double-send
    // this store exists to prevent.
    await writeSendBinding("k1", legacyBindingAt(T0));
    const read = await readSendBinding("k1", T0 + 1);
    expect(read).not.toBeNull();
    expect(read!.wireHex).toBe("0xdeadbeef");
    expect(read!.from).toBeUndefined();
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

// Completion. D1 asked for eager deletion on completion; deleting the row
// outright would reopen the headline case (worker finished, died before
// replying, retry finds nothing and derives the next nonce). So completion
// discards the WIRE BYTES — D1's actual concern, an unbroadcast signed
// transaction on disk — and keeps the hash so a retry can be answered.
describe("completeSendBinding — drops the bytes, keeps the answer", () => {
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

  it("clears the wire bytes so no unbroadcast signed tx remains on disk", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    await completeSendBinding("k1", "0xlanded", "op-1", T0 + 5);
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap).k1!;
    expect(stored.wireHex).toBe("");
  });

  it("keeps the landed hash so a retry is answered, not re-sent", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    await completeSendBinding("k1", "0xlanded", "op-1", T0 + 5);
    const after = await readSendBinding("k1", T0 + 10);
    expect(after).not.toBeNull();
    expect(after!.txHashHex).toBe("0xlanded");
    expect(isCompleted(after!)).toBe(true);
  });

  it("a binding that has NOT completed is not reported as completed", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    expect(isCompleted((await readSendBinding("k1", T0 + 1))!)).toBe(false);
  });

  it("completing an unknown key is a no-op, not a resurrection", async () => {
    await completeSendBinding("ghost", "0xlanded", "op-1", T0);
    expect(await readSendBinding("ghost", T0)).toBeNull();
  });

  it("the completion stub still expires — the TTL reaps it", async () => {
    await writeSendBinding("k1", bindingAt(T0));
    await completeSendBinding("k1", "0xlanded", "op-1", T0);
    expect(await readSendBinding("k1", T0 + SEND_BINDING_TTL_MS + 1)).toBeNull();
  });

  it("a completion record carries the same fields, and still no secret", async () => {
    // PAIRED with "stores ONLY signed-transaction fields" above — see the note
    // there. Completion used to REBUILD the record field by field, so anything
    // not named in that literal was silently dropped. This assertion is what
    // proves the record is preserved rather than reconstructed.
    await writeSendBinding("k1", bindingAt(T0));
    await completeSendBinding("k1", "0xlanded", "op-1", T0);
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap).k1!;
    expect(Object.keys(stored).sort()).toEqual([
      "chainIdHex",
      "from",
      "nonceHex",
      "ts",
      "txHashHex",
      "via",
      "wireHex",
    ]);
  });

  it("the account fields SURVIVE completion — the stub is what a lookup reads", async () => {
    // The values, not just the keys. A completed stub is how "did my send land?"
    // is answered, so losing the account here would make that question
    // unanswerable for the one record that has the answer.
    await writeSendBinding("k1", bindingAt(T0));
    await completeSendBinding("k1", "0xlanded", "op-1", T0);
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap).k1!;
    expect(stored.from).toBe("0xsender");
    expect(stored.chainIdHex).toBe("0x10F2C");
    expect(stored.nonceHex).toBe("0x7");
    // …and completion still did its job.
    expect(stored.wireHex).toBe("");
    expect(stored.txHashHex).toBe("0xlanded");
  });
});

// ── withSendBinding — the shared bind/replay lifecycle ──────────────────────
//
// One implementation for both submit paths. The binding property is NEGATIVE
// and it is the whole point: when a live binding exists, `submit` must NEVER be
// reached, because reaching it means signing again. Asserting the returned hash
// would pass even if it had re-signed to the same mock value, so these assert
// the producing function was not called at all.

describe("withSendBinding — never re-signs when a binding already exists", () => {
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

  const KEY = "confirm-1";

  /** Signed bytes for the transaction the user FIRST confirmed (recipient A).
   *  Same value the fixture below has always carried, named so the row-3
   *  regression can assert on the bytes rather than on a call count. */
  const WIRE_PAYING_A = "0xdeadbeef";
  /** Signed bytes for the EDITED transaction (recipient B) — deliberately
   *  distinct, so "which transaction went out" is decidable from the wire. */
  const WIRE_PAYING_B = "0xfeedface";

  /** Intent digests for the two transactions. Opaque strings here on purpose —
   *  `withSendBinding` only ever compares them, so the suite stays free of the
   *  digest's construction and of anything it might one day import. */
  const DIGEST_A = "v1|0xsender|0xrecipient-a|0x1||0x10f2c";
  const DIGEST_B = "v1|0xsender|0xrecipient-b|0x1||0x10f2c";

  const fields = {
    nonceHex: "0x7",
    wireHex: WIRE_PAYING_A,
    txHashHex: "0xabc",
    from: "0xsender",
    chainIdHex: "0x10F2C",
    digest: DIGEST_A,
  };

  /** A `submit` that binds then reports success, and counts its own calls. */
  function submitter(txHash = "0xfresh") {
    return vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields);
      return { txHash, via: "op-1", nonceHex: fields.nonceHex };
    });
  }

  /** The predicate's real structural contract, restated here rather than
   *  imported: the point of injecting it is that this module never pulls in the
   *  transport layer, and importing it for a test would undo that. */
  const bytesMayBeLive = (err: unknown) =>
    !!err &&
    typeof err === "object" &&
    (err as { bytesMayBeLive?: boolean }).bytesMayBeLive === true;

  /** A failure the fan-out marked because an outcome was `transient` — the bytes
   *  may already be on the network. */
  function transientFailure(message = "no operator accepted the broadcast") {
    const e = new Error(message) as Error & { bytesMayBeLive?: boolean };
    e.bytesMayBeLive = true;
    return e;
  }

  it("signs and binds when there is nothing bound yet", async () => {
    const submit = submitter();
    const rebroadcast = vi.fn();
    const r = await withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast, bytesMayBeLive, submit });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(rebroadcast).not.toHaveBeenCalled();
    expect(r.txHash).toBe("0xfresh");
    // Completed in the same call: bytes dropped, hash kept.
    const stored = (local[STORAGE_KEY_SEND_BINDINGS] as SendBindingMap)[KEY]!;
    expect(stored.wireHex).toBe("");
    expect(stored.txHashHex).toBe("0xfresh");
    expect(stored.from).toBe("0xsender");
  });

  it("REPLAYS stored bytes without calling submit — nothing is signed again", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    const submit = submitter("0xshould-never-be-produced");
    const rebroadcast = vi.fn(async (_w: string, h: string) => ({
      txHash: h,
      via: "op-replay",
    }));

    const r = await withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast, bytesMayBeLive, submit });

    expect(submit).not.toHaveBeenCalled();
    expect(rebroadcast).toHaveBeenCalledWith("0xdeadbeef", "0xabc");
    expect(r).toEqual({ txHash: "0xabc", via: "op-replay", nonceHex: "0x7" });
  });

  it("answers from a COMPLETED stub without broadcasting or signing", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    await completeSendBinding(KEY, "0xlanded", "op-1", T0);
    const submit = submitter();
    const rebroadcast = vi.fn();

    const r = await withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast, bytesMayBeLive, submit });

    expect(submit).not.toHaveBeenCalled();
    expect(rebroadcast).not.toHaveBeenCalled();
    expect(r).toEqual({ txHash: "0xlanded", via: "op-1", nonceHex: "0x7" });
  });

  it("signs afresh once the binding has expired — an orphan must not resurrect", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    const submit = submitter();
    const rebroadcast = vi.fn();

    await withSendBinding({
      key: KEY,
      expectedDigest: DIGEST_A,
      now: () => T0 + SEND_BINDING_TTL_MS + 1,
      rebroadcast,
      bytesMayBeLive,
      submit,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(rebroadcast).not.toHaveBeenCalled();
  });

  it("drops the binding when the submit throws, so nothing is replayed later", async () => {
    const boom = new Error("no operator took it");
    const submit = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields); // bound before broadcast, as the real hook does
      throw boom;
    });

    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast: vi.fn(), bytesMayBeLive, submit }),
    ).rejects.toThrow(boom);

    // The bytes are worthless and the nonce unspent — a later attempt must sign
    // afresh rather than re-broadcast a transaction the chain never saw.
    expect(await readSendBinding(KEY, T0)).toBeNull();
  });

  // ── The failure was NOT a decline ─────────────────────────────────────────
  //
  // A `transient` fan-out outcome means the signed bytes were already handed to
  // an operator. One operator admitting is enough for the transaction to be live,
  // so discarding the binding here loses the only record of it and the retry
  // signs a SECOND transaction at the next nonce.
  //
  // These assert the STORED STATE, not the predicate: the property is that the
  // bytes survive a failure whose outcome was unknown.

  it("KEEPS the binding when the failure says the bytes may already be live", async () => {
    const boom = transientFailure();
    const submit = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields);
      throw boom;
    });

    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast: vi.fn(), bytesMayBeLive, submit }),
    ).rejects.toThrow(boom);

    const kept = await readSendBinding(KEY, T0);
    expect(kept).not.toBeNull();
    // The bytes specifically — a stub would be useless to a retry.
    expect(kept!.wireHex).toBe("0xdeadbeef");
  });

  it("a kept binding REPLAYS the stored bytes on the next attempt — never re-signs", async () => {
    // The point of keeping it: the retry must reach `rebroadcast`, not `submit`.
    const boom = transientFailure();
    const failing = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields);
      throw boom;
    });
    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast: vi.fn(), bytesMayBeLive, submit: failing }),
    ).rejects.toThrow(boom);

    const retry = submitter("0xsecond-signature-that-must-not-happen");
    const rebroadcast = vi.fn(async (_w: string, h: string) => ({
      txHash: h,
      via: "op-replay",
    }));
    const r = await withSendBinding({
      key: KEY,
      expectedDigest: DIGEST_A,
      now: () => T0,
      rebroadcast,
      bytesMayBeLive,
      submit: retry,
    });

    expect(retry).not.toHaveBeenCalled();
    expect(rebroadcast).toHaveBeenCalledWith("0xdeadbeef", "0xabc");
    expect(r.txHash).toBe("0xabc");
  });

  it("still deletes when the failure was a genuine decline", async () => {
    // Every operator refused admission: the bytes are dead and the nonce unspent,
    // so keeping them would replay a doomed transaction at a stale nonce.
    const declined = new Error("insufficient balance") as Error & {
      bytesMayBeLive?: boolean;
    };
    const submit = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields);
      throw declined;
    });

    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast: vi.fn(), bytesMayBeLive, submit }),
    ).rejects.toThrow(declined);

    expect(await readSendBinding(KEY, T0)).toBeNull();
  });

  it("keeps it when the marker is present alongside a decline-shaped message", async () => {
    // A MIXED fan-out — some rejects, at least one transient — still marks. The
    // decision must follow the marker, never the message.
    const mixed = transientFailure("insufficient balance");
    const submit = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind(fields);
      throw mixed;
    });

    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast: vi.fn(), bytesMayBeLive, submit }),
    ).rejects.toThrow(mixed);

    expect(await readSendBinding(KEY, T0)).not.toBeNull();
  });

  // DELIBERATELY INVERTED by §0. This test previously asserted that a record
  // written before the account fields existed still REPLAYS — the reasoning
  // being that invalidating an old record makes the caller sign afresh, which is
  // the double-send this store exists to prevent.
  //
  // The digest changes that calculus for this one field. An old record carries
  // no digest, so the store cannot prove its bytes pay whoever the caller is
  // asking to pay. "Cannot prove" must not read as "matches" on the path that
  // decides whether signed bytes go on the wire — that is exactly how the §0
  // hand test replayed a transaction paying A while the screen showed B.
  //
  // The cost is real and bounded: for up to SEND_BINDING_TTL_MS after an
  // upgrade, a retry of an in-flight send is refused rather than replayed, and
  // the user starts a new send. The other optional fields (`from`,
  // `chainIdHex`) keep their old, unchecked semantics — they only scope a
  // lookup and never gate a broadcast.
  it("REFUSES a record written before the digest existed — cannot prove, so does not replay", async () => {
    // The realistic cross-upgrade case: bytes on disk in the old shape.
    await writeSendBinding(KEY, legacyBindingAt(T0));
    const submit = submitter();
    const rebroadcast = vi.fn(async (_w: string, h: string) => ({
      txHash: h,
      via: "op-replay",
    }));

    await expect(
      withSendBinding({ key: KEY, expectedDigest: DIGEST_A, now: () => T0, rebroadcast, bytesMayBeLive, submit }),
    ).rejects.toBeInstanceOf(SendBindingMismatchError);

    // Neither re-broadcast nor re-signed under the old key.
    expect(rebroadcast).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // And dropped, so the next confirmation can bind normally instead of
    // hitting this same refusal for the rest of the TTL.
    expect(await readSendBinding(KEY, T0)).toBeNull();
  });

  // A completed stub still answers from its hash — but only for the transaction
  // it was completed FOR. The digest is checked BEFORE `isCompleted`, so an
  // edited retry cannot be handed the landed hash of a different transaction and
  // be told its send succeeded.
  it("REFUSES a completed stub when the transaction changed", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    await completeSendBinding(KEY, "0xlanded", "op-1", T0);
    const submit = submitter();
    const rebroadcast = vi.fn();

    await expect(
      withSendBinding({
        key: KEY,
        expectedDigest: DIGEST_B,
        now: () => T0,
        rebroadcast,
        bytesMayBeLive,
        submit,
      }),
    ).rejects.toBeInstanceOf(SendBindingMismatchError);

    expect(rebroadcast).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  // ── The replay branch's failure handling — PINNED DELIBERATELY ───────────
  //
  // A failed replay leaves the record untouched: no completion write, no
  // deletion decision, error propagates. That asymmetry with the submit branch
  // is intended, and these pin it so it cannot be "tidied up" into symmetry.
  //
  // Copying the submit branch's `bytesMayBeLive` rule here would be a
  // double-send: that predicate describes the CURRENT broadcast attempt, and
  // its unmarked cases include "no operator reachable" / "quarantined" /
  // "genesis mismatch" — all of which mean nothing was sent JUST NOW and say
  // nothing about the earlier broadcast these bytes already had.
  it("KEEPS the binding untouched when a replay throws — even on a genuine-looking failure", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    const before = await readSendBinding(KEY, T0);

    const submit = submitter("0xshould-never-be-produced");
    // Unmarked, i.e. `bytesMayBeLive` is FALSE — the shape that makes the
    // submit branch delete. On this branch it must NOT.
    const rebroadcast = vi.fn(async () => {
      throw new Error("no Monolythium Testnet operator reachable");
    });

    await expect(
      withSendBinding({
        key: KEY,
        expectedDigest: DIGEST_A,
        now: () => T0,
        rebroadcast,
        bytesMayBeLive,
        submit,
      }),
    ).rejects.toThrow("no Monolythium Testnet operator reachable");

    // Never re-signed — the whole point of the binding.
    expect(submit).not.toHaveBeenCalled();

    // And the record is byte-for-byte what it was: bytes still there for the
    // next attempt, `ts` NOT refreshed so the TTL still runs from the original
    // bind, digest intact.
    const after = await readSendBinding(KEY, T0);
    expect(after).toEqual(before);
    expect(after!.wireHex).toBe(WIRE_PAYING_A);
    expect(after!.ts).toBe(T0);
  });

  it("KEEPS the binding when a replay throws with bytes that may be live", async () => {
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });
    const rebroadcast = vi.fn(async () => {
      throw transientFailure();
    });

    await expect(
      withSendBinding({
        key: KEY,
        expectedDigest: DIGEST_A,
        now: () => T0,
        rebroadcast,
        bytesMayBeLive,
        submit: submitter(),
      }),
    ).rejects.toThrow();

    // Same outcome as the unmarked case — this branch does not consult the
    // predicate at all, and that is the property being pinned.
    const after = await readSendBinding(KEY, T0);
    expect(after!.wireHex).toBe(WIRE_PAYING_A);
    expect(after!.ts).toBe(T0);
  });

  // ── §0 / row 3 — the WYSIWYS regression ──────────────────────────────────
  //
  // The hand test: a send to A failed, the user pressed "Try again", changed the
  // recipient to B, and confirmed. The wallet re-broadcast the bytes paying A
  // while the screen showed B. The recipient was read out of the stored
  // `wireHex` itself, so this asserts on the BYTES rather than on a call count —
  // a count would pass if the wrong bytes went out under a different shape.
  //
  // The assertion is deliberately written to hold in BOTH worlds, so it needs no
  // rewrite once the guard lands: whatever the call does with a changed
  // transaction, A's bytes must never reach the wire. Today it resolves and
  // hands them over; that is the failure this pins.
  it("REFUSES to replay when the transaction changed under the same key", async () => {
    // Bound to a transaction paying A.
    await writeSendBinding(KEY, { ...fields, via: "", ts: T0 });

    // The caller now intends a transaction paying B — different signed bytes.
    const submitPayingB = vi.fn(async (bind: (f: typeof fields) => Promise<void>) => {
      await bind({ ...fields, wireHex: WIRE_PAYING_B, txHashHex: "0xhash-b" });
      return { txHash: "0xhash-b", via: "op-1", nonceHex: fields.nonceHex };
    });
    const rebroadcast = vi.fn(async (_w: string, h: string) => ({
      txHash: h,
      via: "op-replay",
    }));

    // Tolerated either way: today it resolves, after the guard it rejects. The
    // assertion below is the invariant, not the control flow.
    await withSendBinding({
      key: KEY,
      // The whole point: same key, DIFFERENT transaction.
      expectedDigest: DIGEST_B,
      now: () => T0,
      rebroadcast,
      bytesMayBeLive,
      submit: submitPayingB,
    }).catch(() => undefined);

    // A's bytes must never be re-broadcast for a request that is not A's.
    for (const call of rebroadcast.mock.calls) {
      expect(call[0]).not.toBe(WIRE_PAYING_A);
    }
  });
});
