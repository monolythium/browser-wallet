// Regression-catchers for the Sprintnet operator defaults shape.
//
// These pin the *post-regenesis-2026-05-11* state of
// `SPRINTNET_OPERATOR_RPCS_DEFAULTS` (chain-registry commit 834a876
// dropped val-1 after its bls.key was destroyed during a debugging
// triple-wipe). The third assertion is a forcing function: if val-1
// is ever re-added to the defaults without paired chain-side
// re-attestation, this test fails — making the re-addition a
// deliberate, reviewed action rather than a silent regression.

import { describe, expect, it } from "vitest";
import { SPRINTNET_OPERATOR_RPCS_DEFAULTS } from "./networks.js";

describe("SPRINTNET_OPERATOR_RPCS_DEFAULTS (post-regenesis 2026-05-11)", () => {
  it("has 6 entries (val-2 through val-7; val-1 dropped)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS.length).toBe(6);
  });

  it("places val-2 at position 0 (fsn1 host, replaces dropped val-1)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS[0]?.name).toBe("val-2");
  });

  it("contains no entry pointing at val-1's old IP (192.0.2.7)", () => {
    // Forcing function: if val-1's operator key is regenerated and the
    // entry is re-added, this assertion must be deliberately updated in
    // the same commit — surfacing the re-attestation decision rather
    // than letting it slip in unreviewed.
    for (const entry of SPRINTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).not.toContain("192.0.2.7");
    }
  });
});
