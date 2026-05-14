// Regression-catchers for the Sprintnet operator defaults shape.
//
// These pin the *post-regenesis-2026-05-11* state of
// `SPRINTNET_OPERATOR_RPCS_DEFAULTS`, which is now sourced from the
// SDK-bundled chain registry (chain-registry commit 834a876 dropped
// val-1 after its bls.key was destroyed during a debugging triple-wipe;
// the SDK registry snapshot inherits that exclusion).
//
// Labels switched from `val-N` to `operator-N` (1-indexed off the SDK
// list) in the 2026-05-14 upstream sync — the SDK registry no longer
// carries a val-N identifier per endpoint, so the wallet renumbers from
// 1 for display.
//
// The IP-exclusion assertion is the forcing function: if val-1's
// operator key is regenerated and the SDK registry re-adds 192.0.2.7
// without paired chain-side re-attestation, this test fails — making
// the re-addition a deliberate, reviewed action rather than a silent
// regression.

import { describe, expect, it } from "vitest";
import { SPRINTNET_OPERATOR_RPCS_DEFAULTS } from "./networks.js";

describe("SPRINTNET_OPERATOR_RPCS_DEFAULTS (post-regenesis 2026-05-11)", () => {
  it("has 6 entries (the SDK registry excludes the dropped val-1)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS.length).toBe(6);
  });

  it("places operator-1 at position 0 (1-indexed off the SDK registry)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS[0]?.name).toBe("operator-1");
  });

  it("contains no entry pointing at val-1's old IP (192.0.2.7)", () => {
    for (const entry of SPRINTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).not.toContain("192.0.2.7");
    }
  });
});
