// Transport-layer retry for the MV3 service-worker idle/teardown race.
//
// All popup→SW calls funnel through the private `send()` helper, which does a
// single 100 ms retry when sendMessage fails with an SW-idle/teardown error
// (SW_IDLE_ERROR_MARKERS). Regression guard for the bug where the
// async-listener variant — "A listener indicated an asynchronous response by
// returning true, but the message channel closed before a response was
// received" — escaped the retry (the marker list had only "message port
// closed") and surfaced as an "Uncaught (in promise)" in the side panel.
//
// Driven through a real read helper (`bgKeystoreStatus` → send("keystore-status"))
// with a hand-stubbed chrome.runtime, so the test exercises the actual retry
// path rather than a private predicate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bgKeystoreStatus,
  bgMultisigExecute,
  bgVaultRemove,
  bgWalletNameAccept,
  bgWalletNamePropose,
  bgWalletNameRegister,
  bgWalletSendTx,
  bgWalletSubmitMrvNativePlan,
} from "./bg";

type Outcome = { error: string } | { result: unknown };

let outcomes: Outcome[];
let calls: number;
let lastError: { message: string } | undefined;

beforeEach(() => {
  outcomes = [];
  calls = 0;
  lastError = undefined;
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      // Chrome only exposes lastError synchronously inside the callback; the
      // stub mirrors that — set before cb(), cleared after.
      get lastError() {
        return lastError;
      },
      sendMessage: (_msg: unknown, cb: (resp: unknown) => void) => {
        const outcome = outcomes[calls] ?? { error: "no outcome configured" };
        calls += 1;
        if ("error" in outcome) {
          lastError = { message: outcome.error };
          cb(undefined);
          lastError = undefined;
        } else {
          lastError = undefined;
          cb(outcome.result);
        }
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

const CHANNEL_CLOSED =
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received";

describe("popup→SW transport retry (MV3 idle/teardown race)", () => {
  it("retries the async-listener 'message channel closed' error and resolves on the second attempt", async () => {
    const ok = { hasVault: true, unlocked: true } as unknown;
    outcomes = [{ error: CHANNEL_CLOSED }, { result: ok }];

    const res = await bgKeystoreStatus();

    expect(res).toEqual(ok);
    expect(calls).toBe(2); // failed once (idle race), retried, succeeded
  });

  it("still retries the legacy 'message port closed' phrasing", async () => {
    const ok = { hasVault: false } as unknown;
    outcomes = [
      { error: "The message port closed before a response was received." },
      { result: ok },
    ];

    await expect(bgKeystoreStatus()).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });

  it("does NOT retry a non-idle error — it propagates so the caller can handle it", async () => {
    outcomes = [{ error: "weak_password or some real application error" }];

    await expect(bgKeystoreStatus()).rejects.toThrow(/real application error/);
    expect(calls).toBe(1); // single attempt, no transport retry
  });

  it("if the retry also races, the rejection still propagates (no infinite retry)", async () => {
    outcomes = [{ error: CHANNEL_CLOSED }, { error: CHANNEL_CLOSED }];

    await expect(bgKeystoreStatus()).rejects.toThrow(/message channel closed/);
    expect(calls).toBe(2); // exactly one retry, then give up
  });
});

// DA-009 — the retry is a blanket policy: it resends ANY op whose response was
// lost, including a destructive one. For a removal that already succeeded, the
// resend is a second destroy request for a vault that no longer exists.
//
// This narrows the policy per-op, mirroring the COALESCED_POPUP_OPS allowlist in
// the same file. The success path is deliberately unchanged — the exclusion
// lives in the catch, so a call that never fails never reaches it.
describe("DA-009 — the destructive vault op is excluded from the blanket retry", () => {
  it("does NOT resend vault-remove when the SW drops the response", async () => {
    // Second outcome is a success the retry WOULD have consumed. If the
    // exclusion regresses, `calls` becomes 2 and this resolves instead.
    outcomes = [{ error: CHANNEL_CLOSED }, { result: { ok: true } }];

    await expect(bgVaultRemove("pw", "vault-1")).rejects.toThrow(
      /message channel closed/,
    );
    expect(calls).toBe(1);
  });

  it("does not resend it for the legacy 'message port closed' phrasing either", async () => {
    outcomes = [
      { error: "The message port closed before a response was received." },
      { result: { ok: true } },
    ];

    await expect(bgVaultRemove("pw", "vault-1")).rejects.toThrow(/message port/);
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: a normal removal still resolves on the first attempt", async () => {
    const ok = {
      ok: true,
      removedId: "vault-1",
      newActiveVaultId: "vault-2",
      newActiveAddress: "0xabc",
      affectedMultisigLabels: [],
    } as unknown;
    outcomes = [{ result: ok }];

    await expect(bgVaultRemove("pw", "vault-1")).resolves.toEqual(ok);
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: an application-level refusal is delivered verbatim", async () => {
    // `{ ok: false }` is a resolved reply, not a transport error — it never
    // reached the retry before this change and must not now be swallowed.
    const refusal = { ok: false, reason: "wrong_password", failCount: 2 } as unknown;
    outcomes = [{ result: refusal }];

    await expect(bgVaultRemove("pw", "vault-1")).resolves.toEqual(refusal);
    expect(calls).toBe(1);
  });

  it("CONTROL: an ordinary read op still retries — the policy narrowed, it did not disappear", async () => {
    const ok = { hasVault: true, unlocked: true } as unknown;
    outcomes = [{ error: CHANNEL_CLOSED }, { result: ok }];

    await expect(bgKeystoreStatus()).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });
});

// The send op is the same defect as the removal above, on the money path, and
// worse: a resend is not a duplicate. submitTrackedTx picks the nonce with
// nextNonceHex = max(committed, pending + 1) and records the used nonce on the
// SUCCESS path only. So sign N -> broadcast -> record N -> worker dies before
// replying -> the resend computes N+1 and broadcasts a SECOND VALID
// transaction. Two different nonces, two different hashes; the chain cannot
// dedupe them.
//
// PARTIAL MITIGATION ONLY. This stops the automatic, invisible resend. It does
// NOT close the path: the user sees a failure, presses send again, and the
// manual retry computes N+1 exactly as the automatic one did. The win is that a
// human now gets the chance to check their activity first. The real fix is an
// idempotency token and is planned separately.
describe("the send op is excluded from the blanket retry (partial mitigation)", () => {
  it("does NOT resend wallet-send-tx when the SW drops the response", async () => {
    // The second outcome is a success the retry WOULD have consumed — that is
    // the second broadcast. If the exclusion regresses, `calls` becomes 2.
    outcomes = [
      { error: CHANNEL_CLOSED },
      { result: { ok: true, txHash: "0xsecond", via: "op-2" } },
    ];

    await expect(
      bgWalletSendTx({
        to: "0xdead",
        valueWeiHex: "0x1",
        chainIdHex: "0x10F2C",
      }),
    ).rejects.toThrow(/message channel closed/);
    expect(calls).toBe(1);
  });

  it("does not resend it for the legacy 'message port closed' phrasing either", async () => {
    outcomes = [
      { error: "The message port closed before a response was received." },
      { result: { ok: true, txHash: "0xsecond", via: "op-2" } },
    ];

    await expect(
      bgWalletSendTx({ to: "0xdead", valueWeiHex: "0x1", chainIdHex: "0x10F2C" }),
    ).rejects.toThrow(/message port/);
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: a normal send resolves on the first attempt", async () => {
    outcomes = [{ result: { ok: true, txHash: "0xabc", via: "operator-1" } }];

    await expect(
      bgWalletSendTx({ to: "0xdead", valueWeiHex: "0x1", chainIdHex: "0x10F2C" }),
    ).resolves.toEqual({
      ok: true,
      result: { txHash: "0xabc", via: "operator-1" },
    });
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: an application-level refusal is delivered verbatim", async () => {
    // A resolved `{ ok: false }` is not a transport error and never reached the
    // retry. Insufficient funds, a rejected passkey elevation, a chain refusal —
    // all must still arrive at the caller untouched.
    const refusal = { ok: false, reason: "insufficient funds" } as unknown;
    outcomes = [{ result: refusal }];

    await expect(
      bgWalletSendTx({ to: "0xdead", valueWeiHex: "0x1", chainIdHex: "0x10F2C" }),
    ).resolves.toEqual(refusal);
    expect(calls).toBe(1);
  });

  it("CONTROL: a read op still retries alongside the send exclusion", async () => {
    const ok = { hasVault: true, unlocked: true } as unknown;
    outcomes = [{ error: CHANNEL_CLOSED }, { result: ok }];

    await expect(bgKeystoreStatus()).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });
});

// The remaining submit ops, classified rather than blanket-excluded.
//
// The retry is the trigger; the PENDING-NONCE TRACKER is the cause. It turns a
// retry from "same nonce, chain-rejected" into "next nonce, accepted". So an op
// only needs excluding when it BOTH rides the retry AND takes its nonce from
// `nextNonceHex`. An op that resubmits at the same nonce is fail-safe: the chain
// rejects or dedupes it, and its retry is a genuine recovery worth keeping.
//
// Excluded here (all reach nextNonceHex through submitTrackedTx with no
// preferredNonceHex): multisig-execute, wallet-name-register / -propose /
// -accept.
//
// Deliberately NOT excluded — see the controls at the end:
//   wallet-mrv-submit-plan  — passes preferredNonceHex from the plan's
//                             build-time nonce, so a retry reuses that nonce.
//   native-multisig-send    — reads only the MONOM account's committed nonce and
//                             bypasses submitTrackedTx entirely.
describe("tracker-backed submit ops are excluded; fail-safe ones are not", () => {
  const NAME_ARGS = ["alice.mono", "0x10F2C"] as const;

  it("does NOT resend multisig-execute", async () => {
    outcomes = [{ error: CHANNEL_CLOSED }, { result: { ok: true } }];
    await expect(
      bgMultisigExecute({ vaultId: "v1", proposalId: "p1" }),
    ).rejects.toThrow(/message channel closed/);
    expect(calls).toBe(1);
  });

  it("does NOT resend wallet-name-register", async () => {
    outcomes = [{ error: CHANNEL_CLOSED }, { result: { ok: true } }];
    await expect(bgWalletNameRegister(...NAME_ARGS)).rejects.toThrow(
      /message channel closed/,
    );
    expect(calls).toBe(1);
  });

  it("does NOT resend wallet-name-propose", async () => {
    outcomes = [{ error: CHANNEL_CLOSED }, { result: { ok: true } }];
    await expect(
      bgWalletNamePropose("alice.mono", "0xdead", "0x10F2C"),
    ).rejects.toThrow(/message channel closed/);
    expect(calls).toBe(1);
  });

  it("does NOT resend wallet-name-accept", async () => {
    outcomes = [{ error: CHANNEL_CLOSED }, { result: { ok: true } }];
    await expect(bgWalletNameAccept(...NAME_ARGS)).rejects.toThrow(
      /message channel closed/,
    );
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: an excluded op still resolves on the first attempt", async () => {
    const ok = { ok: true, txHash: "0xabc", via: "operator-1" } as unknown;
    outcomes = [{ result: ok }];
    await expect(bgWalletNameRegister(...NAME_ARGS)).resolves.toEqual(ok);
    expect(calls).toBe(1);
  });

  it("SUCCESS PATH UNCHANGED: an excluded op still delivers a refusal verbatim", async () => {
    const refusal = { ok: false, reason: "name already taken" } as unknown;
    outcomes = [{ result: refusal }];
    await expect(bgMultisigExecute({ vaultId: "v1", proposalId: "p1" })).resolves.toEqual(refusal);
    expect(calls).toBe(1);
  });

  it("CONTROL: wallet-mrv-submit-plan STILL retries — it reuses the plan's nonce, so it is fail-safe", async () => {
    // Excluding this would trade a working recovery for a dropped submit and
    // gain nothing: the resend carries the same build-time nonce, so the chain
    // rejects or dedupes it rather than accepting a second transaction.
    const ok = { ok: true, txHash: "0xabc", via: "op-1" } as unknown;
    outcomes = [{ error: CHANNEL_CLOSED }, { result: ok }];
    await expect(
      bgWalletSubmitMrvNativePlan({
        plan: { nonce: "0x7" } as never,
        chainIdHex: "0x10F2C",
      }),
    ).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("CONTROL: a read op still retries — the policy narrowed, it did not disappear", async () => {
    const ok = { hasVault: true, unlocked: true } as unknown;
    outcomes = [{ error: CHANNEL_CLOSED }, { result: ok }];
    await expect(bgKeystoreStatus()).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });
});
