import { describe, expect, it } from "vitest";

import {
  MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
  MRV_PARITY_INACTIVE,
  isMrvParityActive,
  readMrvParityCapability,
} from "./mrv-capabilities";

function capResponse(descriptor: Record<string, unknown> | null) {
  return {
    blockNumber: 1000n,
    capabilities:
      descriptor === null
        ? {}
        : { [MRV_APP_CONTRACT_PARITY_CAPABILITY_ID]: descriptor },
    nativeModuleForwarders: {},
  } as unknown as Parameters<typeof readMrvParityCapability>[0];
}

describe("readMrvParityCapability", () => {
  it("returns the inactive default for null / undefined responses", () => {
    expect(readMrvParityCapability(null)).toEqual(MRV_PARITY_INACTIVE);
    expect(readMrvParityCapability(undefined)).toEqual(MRV_PARITY_INACTIVE);
  });

  it("returns the inactive default when the capability is absent (pre-N / older node)", () => {
    expect(readMrvParityCapability(capResponse(null))).toEqual(MRV_PARITY_INACTIVE);
  });

  it("reads an active capability keyed by id with its activation height", () => {
    const cap = readMrvParityCapability(
      capResponse({
        address: `0x${"11".repeat(20)}`,
        capabilityId: MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
        capabilityName: "MRV app-contract parity",
        kind: "gateable",
        active: true,
        activationHeight: 5000n,
      }),
    );
    expect(cap).toEqual({ active: true, activationHeight: 5000 });
  });

  it("treats a pre-activation descriptor as inactive with a null height", () => {
    const cap = readMrvParityCapability(
      capResponse({
        address: `0x${"11".repeat(20)}`,
        capabilityId: MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
        capabilityName: "MRV app-contract parity",
        kind: "gateable",
        active: false,
        activationHeight: null,
      }),
    );
    expect(cap).toEqual({ active: false, activationHeight: null });
  });

  it("matches a descriptor whose capabilityId aligns even under a different map key", () => {
    const resp = {
      blockNumber: 1000n,
      capabilities: {
        "0xsomeaddress": {
          address: `0x${"22".repeat(20)}`,
          capabilityId: MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
          capabilityName: "MRV app-contract parity",
          kind: "gateable",
          active: true,
          activationHeight: 4242n,
        },
      },
      nativeModuleForwarders: {},
    } as unknown as Parameters<typeof readMrvParityCapability>[0];
    expect(readMrvParityCapability(resp)).toEqual({ active: true, activationHeight: 4242 });
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
