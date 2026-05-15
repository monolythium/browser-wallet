// Regression-catchers for the Sprintnet operator defaults shape.
//
// These pin the *post-regenesis-2026-05-11* state of
// `SPRINTNET_OPERATOR_RPCS_DEFAULTS`, which is now sourced from the
// SDK-bundled chain registry (chain-registry commit 834a876 dropped
// the original operator-1 after its bls.key was destroyed during a
// debugging triple-wipe; the SDK registry snapshot inherits that
// exclusion).
//
// Labels follow the `operator-N` convention (1-indexed off the SDK
// list). The SDK registry doesn't carry a stable per-endpoint id, so the
// wallet renumbers from 1 for display purposes.
//
// The IP-exclusion assertion is the forcing function: if the original
// operator's key is regenerated and the SDK registry re-adds 192.0.2.7
// without paired chain-side re-attestation, this test fails — making
// the re-addition a deliberate, reviewed action rather than a silent
// regression.

import { describe, expect, it } from "vitest";
import { SPRINTNET_OPERATOR_RPCS_DEFAULTS } from "./networks.js";

describe("SPRINTNET_OPERATOR_RPCS_DEFAULTS (post-regenesis 2026-05-11)", () => {
  it("has 6 entries (the SDK registry excludes the dropped original operator)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS.length).toBe(6);
  });

  it("places operator-1 at position 0 (1-indexed off the SDK registry)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS[0]?.name).toBe("operator-1");
  });

  it("contains no entry pointing at the dropped operator's old IP (192.0.2.7)", () => {
    for (const entry of SPRINTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).not.toContain("192.0.2.7");
    }
  });
});
