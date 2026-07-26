import { describe, expect, it } from "vitest";

import { TESTNET_FALLBACK_RPC } from "./testnet-fallback.js";

describe("TESTNET_FALLBACK_RPC", () => {
  it("uses the canonical encrypted Posture-C R5 gateway", () => {
    expect(TESTNET_FALLBACK_RPC).toBe("https://rpc.monolythium.com");
    expect(new URL(TESTNET_FALLBACK_RPC).protocol).toBe("https:");
  });
});
