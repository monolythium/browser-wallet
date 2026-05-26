import { describe, expect, it } from "vitest";

import type {
  WalletBridgeRouteDisclosure,
  WalletBridgeRouteReadiness,
} from "../bg.js";
import { buildBridgeRouteChoiceState } from "./useBridgeRouteSelection.js";

function route(
  routeId: string,
  overrides: Partial<WalletBridgeRouteDisclosure> = {},
): WalletBridgeRouteDisclosure {
  return {
    routeId,
    bridge: "Chainlink CCIP",
    protocol: "chainlink-ccip",
    asset: "USDC",
    feeToken: "LINK",
    sourceChain: "Ethereum",
    destinationChain: "Mono",
    verifier: {
      model: "CCIP DON",
      participantCount: 7,
      threshold: 5,
    },
    drainCapAtomic: "100000000000",
    finalityBlocks: 64,
    cooldownSeconds: 86_400,
    adminControl: "consensusOnly",
    circuitBreaker: "armed",
    insuranceAtomic: "50000000000",
    lastIncidentDate: null,
    ...overrides,
  };
}

const DISCOVERY_ONLY_READINESS: WalletBridgeRouteReadiness = {
  routeSelectionReady: false,
  quoteReady: false,
  submitReady: false,
  blockedReasons: ["bridge route selection requires transfer intent"],
  warnings: [],
};

describe("buildBridgeRouteChoiceState", () => {
  it("uses SDK ranking to pick the deterministic accepted route", () => {
    const paused = route("paused", { circuitBreaker: "paused" });
    const shortCooldown = route("short-cooldown", { cooldownSeconds: 60 });
    const healthy = route("healthy");

    const state = buildBridgeRouteChoiceState([
      paused,
      shortCooldown,
      healthy,
    ]);

    expect(state.selected?.route?.routeId).toBe("healthy");
    expect(state.candidates.map((candidate) => candidate.route?.routeId)).toEqual([
      "healthy",
      "short-cooldown",
      "paused",
    ]);
    expect(state.candidates.map((candidate) => candidate.state)).toEqual([
      "selected",
      "candidate",
      "blocked",
    ]);
    expect(state.candidates[1]?.assessment?.warnings).toContain(
      "cooldown is under one hour",
    );
    expect(state.candidates[2]?.assessment?.blockedReasons).toContain(
      "route circuit breaker is paused",
    );
    expect(state.blockedReasons).toEqual([]);
    expect(state.transferPreview.status).toBe("intent-blocked");
    expect(state.transferPreview.intent).toMatchObject({
      asset: "USDC",
      amountAtomic: "",
      sourceChain: "Ethereum",
      destinationChain: "Mono",
      recipient: "",
      allowedRouteIds: ["healthy"],
    });
    expect(state.transferPreview.blockedReasons).toEqual(
      expect.arrayContaining([
        "transfer amount missing or zero",
        "transfer recipient missing",
      ]),
    );
    expect(state.transferPreview.quoteBlockedReasons).toContain(
      "standalone SDK exposes route-intent selection only; no live bridge quote helper or API route is available",
    );
    expect(state.transferPreview.submitBlockedReasons).toContain(
      "standalone SDK exposes no live bridge submit helper or API route",
    );
  });

  it("surfaces SDK cooldown and floor failures without selecting a route", () => {
    const state = buildBridgeRouteChoiceState([
      route("under-disclosed", {
        cooldownSeconds: 0,
        drainCapAtomic: "0",
        insuranceAtomic: "0",
      }),
    ]);

    expect(state.selected).toBeNull();
    expect(state.blockedReasons).toContain(
      "no SDK-ranked bridge route satisfies the v4.1 disclosure floor",
    );
    expect(state.candidates[0]?.state).toBe("blocked");
    expect(state.candidates[0]?.assessment?.blockedReasons).toEqual(
      expect.arrayContaining([
        "route cooldown missing",
        "per-asset drain cap missing or zero",
        "slashable insurance pool missing or zero",
      ]),
    );
    expect(state.transferPreview.status).toBe("route-blocked");
    expect(state.transferPreview.intent).toBeNull();
    expect(state.transferPreview.blockedReasons).toEqual(
      expect.arrayContaining([
        "no SDK-ranked bridge route satisfies the v4.1 disclosure floor",
        "quote preview requires an SDK-selected route",
      ]),
    );
  });

  it("keeps discovery catalogue routes behind quote and submit guards", () => {
    const state = buildBridgeRouteChoiceState(
      [
        route("catalogue-only", {
          bridgeId: "catalogue-bridge-arb-usdc",
          wrappedAsset: "mrc:wrapped-usdc",
        }),
      ],
      DISCOVERY_ONLY_READINESS,
    );

    expect(state.selected?.route?.routeId).toBe("catalogue-only");
    expect(state.selected?.bridgeId).toBe("catalogue-bridge-arb-usdc");
    expect(state.selected?.wrappedAsset).toBe("mrc:wrapped-usdc");
    expect(state.selected?.readiness).toEqual(DISCOVERY_ONLY_READINESS);
    expect(state.catalogueReadiness).toEqual(DISCOVERY_ONLY_READINESS);
    expect(state.transferPreview.status).toBe("intent-blocked");
    expect(state.transferPreview.intent).toMatchObject({
      allowedRouteIds: ["catalogue-only"],
    });
    expect(state.transferPreview.readiness).toEqual(DISCOVERY_ONLY_READINESS);
    expect(state.transferPreview.quoteDisabled).toBe(true);
    expect(state.transferPreview.submitDisabled).toBe(true);
    expect(state.transferPreview.blockedReasons).toContain(
      "bridge route selection requires transfer intent",
    );
    expect(state.transferPreview.quoteBlockedReasons).toEqual([
      "catalogue readiness reports quote disabled",
      "standalone SDK exposes route-intent selection only; no live bridge quote helper or API route is available",
    ]);
    expect(state.transferPreview.submitBlockedReasons).toEqual([
      "catalogue readiness reports submit disabled",
      "standalone SDK exposes no live bridge submit helper or API route",
    ]);
  });

  it("reads route-level catalogue readiness aliases for display-only rows", () => {
    const state = buildBridgeRouteChoiceState([
      {
        route_id: "catalogue-usdc-mainnet",
        bridge_id: "bridge-catalogue-1",
        wrapped_asset: "mrc:wrapped-usdc",
        route_selection_ready: false,
        quote_ready: false,
        submit_ready: false,
        blocked_reasons: ["bridge route selection requires transfer intent"],
      },
    ]);

    expect(state.sdkRouteCount).toBe(0);
    expect(state.displayOnlyCount).toBe(1);
    expect(state.candidates[0]?.bridgeId).toBe("bridge-catalogue-1");
    expect(state.candidates[0]?.wrappedAsset).toBe("mrc:wrapped-usdc");
    expect(state.candidates[0]?.readiness).toEqual({
      routeSelectionReady: false,
      quoteReady: false,
      submitReady: false,
      blockedReasons: ["bridge route selection requires transfer intent"],
      warnings: [],
    });
    expect(state.transferPreview.quoteBlockedReasons).toEqual([
      "live bridge quote is blocked until a route satisfies the SDK disclosure floor",
    ]);
  });

  it("keeps older disclosure records display-only instead of defaulting SDK fields", () => {
    const state = buildBridgeRouteChoiceState([
      {
        trustModel: "committee",
        liquidityFloor: "1000",
      },
    ]);

    expect(state.sdkRouteCount).toBe(0);
    expect(state.displayOnlyCount).toBe(1);
    expect(state.selected).toBeNull();
    expect(state.candidates[0]?.state).toBe("display-only");
    expect(state.candidates[0]?.parseFailure).toBe(
      "missing or invalid SDK route field: routeId",
    );
    expect(state.blockedReasons).toContain(
      "no SDK-shaped bridge route disclosures supplied",
    );
  });

  it("does not construct an intent or quote boundary when no disclosures exist", () => {
    const state = buildBridgeRouteChoiceState([]);

    expect(state.candidates).toEqual([]);
    expect(state.transferPreview.status).toBe("no-disclosure");
    expect(state.transferPreview.intent).toBeNull();
    expect(state.transferPreview.selection).toBeNull();
    expect(state.transferPreview.blockedReasons).toEqual([
      "no route disclosures supplied",
    ]);
  });
});
