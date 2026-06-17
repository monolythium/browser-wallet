import { describe, expect, it } from "vitest";

import {
  MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
  MRV_PARITY_INACTIVE,
  isMrvParityActive,
  readMrvParityCapability,
} from "./mrv-capabilities";

// The node publishes runtime-feature gates under the `runtimeFeatures` map
// (sibling to the address-keyed `capabilities` map), keyed by feature id with
// value `{ active, activationHeight }`.
function capResponse(gate: Record<string, unknown> | null) {
  return {
    blockNumber: 1000n,
    capabilities: {},
    nativeModuleForwarders: {},
    runtimeFeatures: gate === null ? {} : { [MRV_APP_CONTRACT_PARITY_CAPABILITY_ID]: gate },
  } as unknown as Parameters<typeof readMrvParityCapability>[0];
}

describe("readMrvParityCapability", () => {
  it("returns the inactive default for null / undefined responses", () => {
    expect(readMrvParityCapability(null)).toEqual(MRV_PARITY_INACTIVE);
    expect(readMrvParityCapability(undefined)).toEqual(MRV_PARITY_INACTIVE);
  });

  it("returns the inactive default when the feature is absent (pre-N / older node)", () => {
    expect(readMrvParityCapability(capResponse(null))).toEqual(MRV_PARITY_INACTIVE);
  });

  it("returns the inactive default when runtimeFeatures is absent entirely", () => {
    const resp = {
      blockNumber: 1000n,
      capabilities: {},
      nativeModuleForwarders: {},
    } as unknown as Parameters<typeof readMrvParityCapability>[0];
    expect(readMrvParityCapability(resp)).toEqual(MRV_PARITY_INACTIVE);
  });

  it("reads an active gate with its activation height", () => {
    const cap = readMrvParityCapability(
      capResponse({ active: true, activationHeight: 5000n }),
    );
    expect(cap).toEqual({ active: true, activationHeight: 5000 });
  });

  it("treats a pre-activation gate as inactive with a null height", () => {
    const cap = readMrvParityCapability(
      capResponse({ active: false, activationHeight: null }),
    );
    expect(cap).toEqual({ active: false, activationHeight: null });
  });

  it("ignores a same-id descriptor in the address-keyed capabilities map", () => {
    // Regression: the gate lives in `runtimeFeatures`, never `capabilities`.
    const resp = {
      blockNumber: 1000n,
      capabilities: {
        "0xsomeaddress": {
          address: `0x${"22".repeat(20)}`,
          capabilityId: MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
          capabilityName: "decoy",
          kind: "gateable",
          active: true,
          activationHeight: 4242n,
        },
      },
      nativeModuleForwarders: {},
      runtimeFeatures: {},
    } as unknown as Parameters<typeof readMrvParityCapability>[0];
    expect(readMrvParityCapability(resp)).toEqual(MRV_PARITY_INACTIVE);
  });
});

describe("isMrvParityActive", () => {
  it("is false when the capability is inactive", () => {
    expect(isMrvParityActive(MRV_PARITY_INACTIVE, 9999)).toBe(false);
  });

  it("is false when the activation height is unknown", () => {
    expect(isMrvParityActive({ active: true, activationHeight: null }, 9999)).toBe(false);
  });

  it("is false before the activation height N", () => {
    expect(isMrvParityActive({ active: true, activationHeight: 5000 }, 4999)).toBe(false);
  });

  it("is true at and after the activation height N", () => {
    expect(isMrvParityActive({ active: true, activationHeight: 5000 }, 5000)).toBe(true);
    expect(isMrvParityActive({ active: true, activationHeight: 5000 }, 5001)).toBe(true);
  });

  it("is false when the current height is unknown", () => {
    expect(isMrvParityActive({ active: true, activationHeight: 5000 }, null)).toBe(false);
    expect(isMrvParityActive({ active: true, activationHeight: 5000 }, undefined)).toBe(false);
  });
});
