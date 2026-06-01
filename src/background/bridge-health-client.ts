// v5 wiring — bridge circuit-breaker / drain health SW reader.
//
// SDK 0.3.10 (MB-2) ships two live bridge-risk reads the wallet didn't
// have before:
//
//   - `lyth_bridgeHealth(cursor?, limit?)`     → BridgeHealthResponse
//   - `lyth_bridgeDrainStatus(bridgeId, asset)` → BridgeDrainStatus
//
// These enrich the otherwise-static `BridgeRouteDisclosure` rows the
// wallet already renders (drainCapAtomic / circuitBreaker / insurance /
// lastIncidentDate) with the LIVE pause posture + remaining drain bucket.
// The bridge surface stays DISCLOSURE-ONLY — the SDK still exposes no
// live quote/submit primitive (BRIDGE_QUOTE_API_BLOCKED_REASON /
// BRIDGE_SUBMIT_API_BLOCKED_REASON), so nothing here is a write path.
//
// Both reads go through the genesis-pinned `sprintnetJsonRpc` fan-out
// (the same trust path as `bridge-routes-client.ts`) wrapped in
// `withChainFallback` so a not-deployed / offline operator collapses to
// a typed `mock-not-deployed` / `mock-offline` outcome rather than
// throwing into the popup. The popup branches on `out.kind === "live"`
// before showing any live-data badge.

import {
  withChainFallback,
  type ChainOutcome,
} from "../shared/chain-readiness.js";
import {
  bridgeDrainRemaining,
  type BridgeDrainStatus,
  type BridgeHealthResponse,
} from "@monolythium/core-sdk";
import { sprintnetJsonRpc } from "./tx-mldsa.js";

// Empty sentinel for `withChainFallback`'s required `mockValue` slot.
// A zero-record page is a legitimate "no bridges live yet" chain answer,
// so the popup renders the same shape whether the read was live or fell
// back; it distinguishes the two via `out.kind`.
const EMPTY_BRIDGE_HEALTH: BridgeHealthResponse = {
  schemaVersion: 1,
  source: "mock",
  precompile: "0x0000000000000000000000000000000000001008",
  records: [],
  nextCursor: null,
};

function isBridgeHealthResponse(input: unknown): input is BridgeHealthResponse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const r = input as Partial<BridgeHealthResponse>;
  return Array.isArray(r.records);
}

function isBridgeDrainStatus(input: unknown): input is BridgeDrainStatus {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const r = input as Partial<BridgeDrainStatus>;
  return (
    typeof r.bridgeId === "string" &&
    typeof r.capPerWindow === "string" &&
    typeof r.remaining === "string"
  );
}

/** Read a page of bridge-record circuit-breaker / pause posture
 *  (MB-2 `lyth_bridgeHealth`). Mirrors the `lythBridgeHealth(cursor,
 *  limit)` param assembly: only forward `cursor`/`limit` slots that are
 *  actually set so an operator on the default page-size keeps its
 *  server-side default. */
export async function readBridgeHealth(
  cursor?: string | null,
  limit?: number,
): Promise<ChainOutcome<BridgeHealthResponse>> {
  const params: unknown[] = [];
  if (cursor != null || limit != null) params.push(cursor ?? null);
  if (limit != null) params.push(limit);
  return withChainFallback<BridgeHealthResponse>(
    // Return the raw result and let `isValid` classify it: a thrown
    // error (transport / method-absent) routes to `mock-not-deployed`,
    // while a well-transported-but-wrong-shape response routes to
    // `mock-error` via the validator — the two are distinct provenance
    // states the popup can surface differently.
    async () => {
      const { result } = await sprintnetJsonRpc<BridgeHealthResponse>(
        "lyth_bridgeHealth",
        params,
      );
      return result;
    },
    {
      mockValue: EMPTY_BRIDGE_HEALTH,
      notLiveAs: "not-deployed",
      label: "lyth_bridgeHealth",
      timeoutMs: 5000,
      isValid: isBridgeHealthResponse,
    },
  );
}

/** Read the live per-route drain bucket for one `(bridgeId,
 *  wrappedAsset)` pair (MB-2 `lyth_bridgeDrainStatus`). `remaining` is
 *  the chain-computed `capPerWindow - drainedThisBucket` clamped at 0;
 *  `"0x0"` means "no per-asset cap" (the bridge default applies). */
export async function readBridgeDrainStatus(
  bridgeId: string,
  wrappedAsset: string,
): Promise<ChainOutcome<BridgeDrainStatus>> {
  const mockValue: BridgeDrainStatus = {
    schemaVersion: 1,
    source: "mock",
    precompile: "0x0000000000000000000000000000000000001008",
    bridgeId,
    wrappedAsset,
    capPerWindow: "0x0",
    windowBlocks: 0,
    currentBucket: 0,
    drainedThisBucket: "0x0",
    remaining: "0x0",
    bridgeDefault: { drainCapPerWindow: "0x0", drainWindowBlocks: 0 },
  };
  return withChainFallback<BridgeDrainStatus>(
    async () => {
      const { result } = await sprintnetJsonRpc<BridgeDrainStatus>(
        "lyth_bridgeDrainStatus",
        [bridgeId, wrappedAsset],
      );
      return result;
    },
    {
      mockValue,
      notLiveAs: "not-deployed",
      label: "lyth_bridgeDrainStatus",
      timeoutMs: 5000,
      isValid: isBridgeDrainStatus,
    },
  );
}

/** Compute the remaining drain headroom from raw cap + drained decimal
 *  strings, floored at 0; `null` when the cap is disabled. Re-exported
 *  from the SDK so the popup uses the chain-canonical arithmetic rather
 *  than rolling its own. */
export { bridgeDrainRemaining };
