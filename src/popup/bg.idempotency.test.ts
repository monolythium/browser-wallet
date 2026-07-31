// The idempotency key on the send transport.
//
// The key identifies one user CONFIRMATION, not one attempt. It is minted in
// the popup at Confirm and reused by any retry of that confirmation, so the
// service worker can recognise a repeat and re-broadcast the bytes it already
// signed rather than deriving a new nonce and signing a second transaction.
//
// These tests pin the wire contract only: the key reaches the envelope when
// supplied, and the envelope is byte-identical to today's when it is not.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bgWalletNameAccept,
  bgWalletNamePropose,
  bgWalletNameRegister,
  bgWalletSendTx,
} from "./bg";

let sent: Array<Record<string, unknown>>;

beforeEach(() => {
  sent = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: unknown, cb: (resp: unknown) => void) => {
        sent.push(msg as Record<string, unknown>);
        cb({ ok: true, txHash: "0xabc", via: "op-1" });
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

const BASE = {
  to: "0xdead",
  valueWeiHex: "0x1",
  chainIdHex: "0x10F2C",
} as const;

function payloadOf(i = 0): Record<string, unknown> {
  return sent[i]!.payload as Record<string, unknown>;
}

describe("wallet-send-tx carries the idempotency key", () => {
  it("forwards the key into the op payload when supplied", async () => {
    await bgWalletSendTx({ ...BASE, idempotencyKey: "confirm-1" });
    expect(payloadOf().idempotencyKey).toBe("confirm-1");
  });

  it("OMITS the field entirely when no key is supplied — the SW sees today's shape", async () => {
    // Not `undefined`: absent. A key that is present-but-undefined would change
    // the payload shape the service worker has always received.
    await bgWalletSendTx({ ...BASE });
    expect("idempotencyKey" in payloadOf()).toBe(false);
  });

  it("still routes through the send op and returns the unwrapped result", async () => {
    const r = await bgWalletSendTx({ ...BASE, idempotencyKey: "confirm-1" });
    expect(sent[0]!.op).toBe("wallet-send-tx");
    expect(r).toEqual({ ok: true, result: { txHash: "0xabc", via: "op-1" } });
  });

  it("two different confirmations carry different keys", async () => {
    await bgWalletSendTx({ ...BASE, idempotencyKey: "confirm-1" });
    await bgWalletSendTx({ ...BASE, idempotencyKey: "confirm-2" });
    expect(payloadOf(0).idempotencyKey).toBe("confirm-1");
    expect(payloadOf(1).idempotencyKey).toBe("confirm-2");
  });
});

// The name ops gained the same optional key. The property that matters for the
// extension is NOT that a supplied key arrives — it is that an UNSUPPLIED one
// leaves the wire untouched. A field present as `undefined` would be a changed
// payload shape for a service worker that has never seen it, so these assert
// absence with `in`, not equality with undefined.
describe("the name operations carry the key, and omit it when there is none", () => {
  const CHAIN = "0x10F2C";

  it("wallet-name-register: byte-identical payload when unkeyed", async () => {
    await bgWalletNameRegister("alice.mono", CHAIN);
    expect(payloadOf()).toEqual({ name: "alice.mono", chainIdHex: CHAIN });
    expect("idempotencyKey" in payloadOf()).toBe(false);
  });

  it("wallet-name-propose: byte-identical payload when unkeyed", async () => {
    await bgWalletNamePropose("alice.mono", "0xdead", CHAIN);
    expect(payloadOf()).toEqual({
      name: "alice.mono",
      recipientAddr0x: "0xdead",
      chainIdHex: CHAIN,
    });
    expect("idempotencyKey" in payloadOf()).toBe(false);
  });

  it("wallet-name-accept: byte-identical payload when unkeyed", async () => {
    await bgWalletNameAccept("alice.mono", CHAIN);
    expect(payloadOf()).toEqual({ name: "alice.mono", chainIdHex: CHAIN });
    expect("idempotencyKey" in payloadOf()).toBe(false);
  });

  it("forwards the key on all three when supplied, under the same op names", async () => {
    await bgWalletNameRegister("alice.mono", CHAIN, "confirm-r");
    await bgWalletNamePropose("alice.mono", "0xdead", CHAIN, "confirm-p");
    await bgWalletNameAccept("alice.mono", CHAIN, "confirm-a");
    expect(sent.map((m) => m.op)).toEqual([
      "wallet-name-register",
      "wallet-name-propose",
      "wallet-name-accept",
    ]);
    expect(payloadOf(0).idempotencyKey).toBe("confirm-r");
    expect(payloadOf(1).idempotencyKey).toBe("confirm-p");
    expect(payloadOf(2).idempotencyKey).toBe("confirm-a");
  });
});
