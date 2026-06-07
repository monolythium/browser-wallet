// F-3.8 / #25 regression — the delegation-cap consumer must not render a
// fabricated cap. `readDelegationCap` returns a hardcoded 50% (capBps:5000)
// with via:"mock" when the chain is offline; the Stake page must treat that as
// "cap unknown" (null → badge hidden), not as a real chain value. The pure
// predicate `capBpsFromCapResult` encodes that gate; the full page is a React
// surface that the node test env can't render, so we pin the predicate (the
// page wires `setCapBps(capBpsFromCapResult(capR))`).

import { describe, expect, it } from "vitest";
import { capBpsFromCapResult } from "./Stake.js";

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
