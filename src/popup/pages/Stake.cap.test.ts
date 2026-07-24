// F-3.8 / #25 regression — the delegation-cap consumer must not render a
// fabricated cap. `readDelegationCap` returns a hardcoded 50% (capBps:5000)
// with via:"mock" when the chain is offline; the Stake page must treat that as
// "cap unknown" (null → badge hidden), not as a real chain value. The pure
// predicate `capBpsFromCapResult` encodes that gate; the full page is a React
// surface that the node test env can't render, so we pin the predicate (the
// page wires `setCapBps(capBpsFromCapResult(capR))`).

import { describe, expect, it } from "vitest";
import {
  capBpsFromCapResult,
  perWalletBpsFromCapResult,
  undelegateNotificationWeightBps,
} from "./Stake.js";
import { DELEGATION_PER_WALLET_CAP_BPS } from "../../shared/staking.js";

describe("capBpsFromCapResult — no-mock delegation cap (F-3.8/#25)", () => {
  it("adopts a concrete cap from a LIVE read", () => {
    expect(
      capBpsFromCapResult({ ok: true, via: "operator-1", data: { capBps: 2500 } }),
    ).toBe(2500);
    // The `via` for a live read is the outcome/operator tag (anything but "mock").
    expect(
      capBpsFromCapResult({ ok: true, via: "live", data: { capBps: 1500 } }),
    ).toBe(1500);
  });

  it("returns null for a via:\"mock\" read (offline) so the fabricated 50% is NOT shown", () => {
    expect(
      capBpsFromCapResult({ ok: true, via: "mock", data: { capBps: 5000 } }),
    ).toBeNull();
  });

  it("returns null for a failed read", () => {
    expect(capBpsFromCapResult({ ok: false })).toBeNull();
    expect(capBpsFromCapResult({ ok: false, via: "mock" })).toBeNull();
  });

  it("returns null when a live read carries no data (defensive)", () => {
    expect(capBpsFromCapResult({ ok: true, via: "operator-1" })).toBeNull();
  });
});

describe("perWalletBpsFromCapResult — the enforced per-wallet cap NEVER collapses to null (#44)", () => {
  it("adopts a live per-wallet cap", () => {
    expect(
      perWalletBpsFromCapResult({ ok: true, via: "operator-1", data: { perWalletBps: 4000 } }),
    ).toBe(4000);
  });

  it('returns the 5000 FLOOR on a via:"mock" read — unlike the display aggregate, the floor still binds', () => {
    // Contrast capBpsFromCapResult, which NULLS a mock read (badge hidden). The
    // per-wallet cap is a real protocol floor, so it must stay 5000, never null.
    expect(
      perWalletBpsFromCapResult({ ok: true, via: "mock", data: { perWalletBps: 5000 } }),
    ).toBe(DELEGATION_PER_WALLET_CAP_BPS);
    expect(
      capBpsFromCapResult({ ok: true, via: "mock", data: { capBps: 5000 } }),
    ).toBeNull(); // the display aggregate is nulled on mock — proving the two DIFFER
  });

  it("returns the 5000 floor on a failed read, absent data, or null field (fail-closed, never unlimited)", () => {
    expect(perWalletBpsFromCapResult({ ok: false })).toBe(DELEGATION_PER_WALLET_CAP_BPS);
    expect(perWalletBpsFromCapResult({ ok: true, via: "operator-1" })).toBe(DELEGATION_PER_WALLET_CAP_BPS);
    expect(
      perWalletBpsFromCapResult({ ok: true, via: "operator-1", data: { perWalletBps: null } }),
    ).toBe(DELEGATION_PER_WALLET_CAP_BPS);
  });

  it("fails closed to 5000 on an out-of-range live value", () => {
    expect(
      perWalletBpsFromCapResult({ ok: true, via: "operator-1", data: { perWalletBps: 0 } }),
    ).toBe(DELEGATION_PER_WALLET_CAP_BPS);
    expect(
      perWalletBpsFromCapResult({ ok: true, via: "operator-1", data: { perWalletBps: 99999 } }),
    ).toBe(DELEGATION_PER_WALLET_CAP_BPS);
  });
});

describe("undelegateNotificationWeightBps — never emit 0 for the toast %", () => {
  it("passes a known weight through unchanged", () => {
    expect(undelegateNotificationWeightBps(5000)).toBe(5000);
    expect(undelegateNotificationWeightBps(1)).toBe(1);
  });

  it("maps 0 (stale/absent cache row) to undefined — not a misleading 0%", () => {
    expect(undelegateNotificationWeightBps(0)).toBeUndefined();
  });
});
