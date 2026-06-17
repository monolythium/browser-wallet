// Monolythium Wallet — MRV app-contract-parity feature detect.
//
// The node ships the EVM-parity bits (the block_timestamp / chain_id /
// call_value host syscalls, the synthesized bare-deploy receipt sidecar, and
// the hardened metering) gated behind a foundation-signed milestone at height
// N. The plain deploy/call/constructor lane is ALREADY LIVE and is never gated
// on N — only the parity-dependent UX is.
//
// Downstream learns activation through the existing `lyth_capabilities` RPC,
// which exposes an address-keyed capability map. We read the entry keyed
// `mrv_app_contract_parity` and surface `{ active, activationHeight }`. This is
// the single feature-detect contract the wallet, DevKit, and Studio align on.
//
// Forward-compatibility: a pre-N node, or any older node that does not yet
// publish the capability at all, resolves to `{ active: false,
// activationHeight: null }`. The activation height (N) is NEVER hardcoded — it
// is always read from the live node — so parity-dependent UX lights up at N
// with no wallet re-release.

import type { CapabilitiesResponse, CapabilityDescriptor } from "@monolythium/core-sdk";

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
 * Pull the `mrv_app_contract_parity` entry out of a `lyth_capabilities`
 * response. The capability map is keyed by capability id (per the milestone
 * registry); we tolerate either keying-by-id or a descriptor whose
 * `capabilityId` matches, and we fall back to the inactive default whenever the
 * capability is absent (pre-N or older node).
 */
export function readMrvParityCapability(
  resp: CapabilitiesResponse | null | undefined,
): MrvParityCapability {
  if (resp === null || resp === undefined || typeof resp !== "object") {
    return MRV_PARITY_INACTIVE;
  }
  const map = resp.capabilities;
  if (map === null || map === undefined || typeof map !== "object") {
    return MRV_PARITY_INACTIVE;
  }
  const direct = map[MRV_APP_CONTRACT_PARITY_CAPABILITY_ID];
  const descriptor: CapabilityDescriptor | undefined =
    direct ??
    Object.values(map).find(
      (d): d is CapabilityDescriptor =>
        d !== undefined && d.capabilityId === MRV_APP_CONTRACT_PARITY_CAPABILITY_ID,
    );
  if (descriptor === undefined) {
    return MRV_PARITY_INACTIVE;
  }
  return {
    active: descriptor.active === true,
    activationHeight: normalizeActivationHeight(descriptor.activationHeight),
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
