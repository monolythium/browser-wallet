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
import { bgKeystoreStatus, bgVaultRemove } from "./bg";

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
