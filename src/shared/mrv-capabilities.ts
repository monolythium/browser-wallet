// Monolythium Wallet — MRV app-contract-parity feature detect.
//
// The node ships the EVM-parity bits (the block_timestamp / chain_id /
// call_value host syscalls, the synthesized bare-deploy receipt sidecar, and
// the hardened metering) gated behind a foundation-signed milestone at height
// N. The plain deploy/call/constructor lane is ALREADY LIVE and is never gated
// on N — only the parity-dependent UX is.
//
// Downstream learns activation through the existing `lyth_capabilities` RPC.
// Runtime-feature gates that are not bound to a precompile address live in a
// `runtimeFeatures` map (a sibling to the address-keyed `capabilities` map).
// We read the entry keyed `mrv_app_contract_parity` and surface
// `{ active, activationHeight }`. This is the single feature-detect contract
// the wallet, DevKit, and Studio align on.
//
// Forward-compatibility: a pre-N node, or any older node that does not yet
// publish the `runtimeFeatures` map (or the feature within it), resolves to
// `{ active: false, activationHeight: null }`. The activation height (N) is
// NEVER hardcoded — it is always read from the live node — so parity-dependent
// UX lights up at N with no wallet re-release.
//
// The `runtimeFeatures` map is read structurally: the pinned published SDK
// `CapabilitiesResponse` type predates the field, so a structural read keeps
// the wallet type-checking today while remaining correct once the SDK that
// declares the field ships.

import type { CapabilitiesResponse } from "@monolythium/core-sdk";

/**
 * Structural view of one `runtimeFeatures` entry. Mirrors the node's
 * `RuntimeFeatureGate` (`{ active, activationHeight }`); kept local so the
 * reader does not depend on the SDK type declaring the field yet.
 */
interface RuntimeFeatureGateView {
  active?: boolean;
  activationHeight?: number | bigint | null;
}

/** Stable capability id the parity milestone publishes in `lyth_capabilities`. */
export const MRV_APP_CONTRACT_PARITY_CAPABILITY_ID = "mrv_app_contract_parity" as const;

/** Feature-detect result shape every surface aligns on. */
export interface MrvParityCapability {
  /** Whether the node reports the parity capability as dispatchable. */
  active: boolean;
  /** Milestone activation height (N). `null` pre-N / on older nodes. */
  activationHeight: number | null;
}

/** Forward-compatible default: parity off, no known activation height. */
export const MRV_PARITY_INACTIVE: MrvParityCapability = {
  active: false,
  activationHeight: null,
};

/**
 * Pull the `mrv_app_contract_parity` gate out of a `lyth_capabilities`
 * response. Runtime-feature gates live in the `runtimeFeatures` map keyed by
 * feature id (NOT the address-keyed `capabilities` map). Falls back to the
 * inactive default whenever the map or the feature is absent (pre-N or older
 * node).
 */
export function readMrvParityCapability(
  resp: CapabilitiesResponse | null | undefined,
): MrvParityCapability {
  if (resp === null || resp === undefined || typeof resp !== "object") {
    return MRV_PARITY_INACTIVE;
  }
  // Structural read: the pinned SDK type predates `runtimeFeatures`.
  const runtimeFeatures = (
    resp as {
      runtimeFeatures?: Record<string, RuntimeFeatureGateView | undefined> | null;
    }
  ).runtimeFeatures;
  if (runtimeFeatures === null || runtimeFeatures === undefined || typeof runtimeFeatures !== "object") {
    return MRV_PARITY_INACTIVE;
  }
  const gate = runtimeFeatures[MRV_APP_CONTRACT_PARITY_CAPABILITY_ID];
  if (gate === null || gate === undefined || typeof gate !== "object") {
    return MRV_PARITY_INACTIVE;
  }
  return {
    active: gate.active === true,
    activationHeight: normalizeActivationHeight(gate.activationHeight),
  };
}

/**
 * The shared helper the CONTRACT defines: parity is "active for this height"
 * when the node reports it active AND the current chain height has reached the
 * milestone activation height. A missing activation height (or an inactive
 * capability) is never active.
 *
 * Mirrors the SDK's `isMrvParityActive(currentHeight)` so all surfaces evaluate
 * activation identically.
 */
export function isMrvParityActive(
  capability: MrvParityCapability,
  currentHeight: number | null | undefined,
): boolean {
  if (!capability.active) return false;
  if (capability.activationHeight === null) return false;
  if (typeof currentHeight !== "number" || !Number.isFinite(currentHeight)) return false;
  return currentHeight >= capability.activationHeight;
}

function normalizeActivationHeight(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(asNumber) || asNumber < 0) return null;
  return asNumber;
}
