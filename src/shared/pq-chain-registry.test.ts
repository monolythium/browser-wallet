import { describe, expect, it } from "vitest";
import {
  BRIDGE_ROUTES,
  POLICY_CHAINS,
  bridgeRoutesForChain,
  policyChainById,
} from "./pq-chain-registry.js";

describe("policy chain registry", () => {
  it("labels Monolythium as native PQ and NEAR testnet as PQ-attested", () => {
    expect(policyChainById("mono:testnet-69420")?.pqPosture).toBe("native-pq");
    expect(policyChainById("near:testnet")?.pqPosture).toBe("pq-attested");
    expect(policyChainById("near:testnet")?.walletMode).toBe("bridge-readonly");
  });

  it("does not mark NEAR as a native signing network", () => {
    const near = policyChainById("near:testnet");

    expect(near?.signatureSchemes).toContain("ed25519");
    expect(near?.signatureSchemes).not.toContain("ml-dsa-65");
    expect(near?.capabilities.signTransactions).toBe(false);
    expect(near?.capabilities.connectDapps).toBe(false);
  });

  it("keeps bridge routes bound to known policy chains", () => {
    for (const route of BRIDGE_ROUTES) {
      expect(policyChainById(route.fromChainId), route.fromChainId).not.toBeNull();
      expect(policyChainById(route.toChainId), route.toChainId).not.toBeNull();
      expect(route.pqPosture).toBe("pq-attested");
    }

    expect(bridgeRoutesForChain("near:testnet").map((r) => r.id)).toEqual([
      "mono-testnet-near-testnet-lyth-v1",
    ]);
  });

  it("uses stable unique ids", () => {
    const ids = POLICY_CHAINS.map((chain) => chain.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

