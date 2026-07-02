// Typed AddressActivityKind discriminator.
//
// Replaces the P4.4 heuristic empty-state ("no rows → must be empty,
// render generic CTA"). The chain now emits `lyth_addressActivityKind`
// (chain commit d77e4fc) returning a typed kind that the wallet routes
// to a context-aware UX:
//
//   - "found"             → render entries normally
//   - "not_found"         → clean "no activity yet" empty state
//   - "indexer_disabled"  → "history unavailable on this network" +
//                            link to §22.5 / §30.5 explainer
//   - "pruned"            → "older activity has been pruned; showing
//                            recent N transactions" + retention info
//   - "private"           → honest empty state: private transfers exist
//                            but are opaque to the public indexer (no
//                            viewer surface yet; mono-core-sdk#27 has
//                            no builder)
//   - <unknown string>    → forward-compatible "history unavailable"
//
// The chain-side activity-kind reader (previously deferred) has now
// shipped + landed in SDK @0fd8a79).
//
// Whitepaper alignment:
//   §22.5  — agent precompile (zkML proof verification) — `kind = "private"`
//            renders the honest not-viewable-yet empty state (see
//            ActivityList; copy per issue #25).
//   §25.4  — Rule 9 (privacy denomination caller-origin guard) — private
//            activity is fundamentally opaque to the public indexer.
//   §30.5  — Foundation cluster transparency surface — "indexer_disabled"
//            wallet-side education links to the explainer.

import type { AddressActivityKind } from "@monolythium/core-sdk";

/** Wallet-side typed activity-kind. Mirrors the SDK type but normalises
 *  the forward-compatible "unknown" case to a `"unknown"` literal so
 *  callers don't have to handle arbitrary strings in render code. */
export type WalletActivityKind =
  | "found"
  | "not_found"
  | "indexer_disabled"
  | "pruned"
  | "private"
  | "unknown";

/** Wallet-side retention envelope. Mirrors `AddressActivityKindRetention`
 *  from the SDK but uses `string` for the bigint (since the wallet round-
 *  trips through chrome.storage which doesn't carry bigints). */
export interface WalletActivityRetention {
  /** Earliest retained block height, as a decimal string (no `0x`). */
  earliestRetained: string;
  /** Archive redirect hint, if the chain has one. */
  archiveRedirect: { hint: string } | null;
}

/** Wallet-side activity-kind envelope. */
export interface WalletActivityKindEnvelope {
  /** Schema version from the chain (forward-compat hint). */
  schemaVersion: number;
  /** Address the kind applies to (lowercase 0x). */
  address: string;
  /** Discriminated kind — see WalletActivityKind. */
  kind: WalletActivityKind;
  /** Retention envelope, present when kind === "pruned". */
  retention: WalletActivityRetention | null;
}

/** Default envelope when the chain method isn't available — defensive
 *  posture that lets the popup render the historical empty-state UX
 *  without branching. */
export const DEFAULT_ACTIVITY_KIND_ENVELOPE: WalletActivityKindEnvelope = {
  schemaVersion: 0,
  address: "",
  kind: "not_found",
  retention: null,
};

/** Validate and normalise a chain response into the wallet shape. Returns
 *  `null` for malformed payloads (caller falls back to the default). */
export function normaliseActivityKind(
  address: string,
  raw: unknown,
): WalletActivityKindEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  const schemaVersion =
    typeof r.schemaVersion === "number" ? r.schemaVersion : 0;
  const addressOut =
    typeof r.address === "string" ? r.address.toLowerCase() : address.toLowerCase();
  const kind = normaliseKindString(r.kind);
  let retention: WalletActivityRetention | null = null;
  if (r.retention !== undefined && r.retention !== null) {
    const retRaw = r.retention as Record<string, unknown>;
    const earliestRaw = retRaw.earliestRetained;
    let earliestRetained: string;
    if (typeof earliestRaw === "bigint") {
      earliestRetained = earliestRaw.toString();
    } else if (typeof earliestRaw === "string") {
      earliestRetained = earliestRaw;
    } else if (typeof earliestRaw === "number") {
      earliestRetained = String(earliestRaw);
    } else {
      // Pruned envelope without a retention boundary is anomalous; treat
      // as if there's no retention metadata.
      retention = null;
      return {
        schemaVersion,
        address: addressOut,
        kind,
        retention,
      };
    }
    let archiveRedirect: { hint: string } | null = null;
    if (retRaw.archiveRedirect !== undefined && retRaw.archiveRedirect !== null) {
      const ar = retRaw.archiveRedirect as Record<string, unknown>;
      if (typeof ar.hint === "string") {
        archiveRedirect = { hint: ar.hint };
      }
    }
    retention = { earliestRetained, archiveRedirect };
  }
  return { schemaVersion, address: addressOut, kind, retention };
}

/** Normalise an arbitrary `kind` string into the wallet enum. Unknown
 *  values (forward-compatible additions the chain might emit) collapse
 *  to `"unknown"`. */
export function normaliseKindString(raw: string): WalletActivityKind {
  switch (raw) {
    case "found":
    case "not_found":
    case "indexer_disabled":
    case "pruned":
    case "private":
      return raw;
    default:
      return "unknown";
  }
}

/** Human-readable label for a kind. Used by Monoscan-style dev tools
 *  + by the popup's diagnostic surfaces. Render-layer copy lives in the
 *  React components themselves (with the full sentence + CTA shape). */
export function activityKindLabel(kind: WalletActivityKind): string {
  switch (kind) {
    case "found":
      return "Activity available";
    case "not_found":
      return "No activity yet";
    case "indexer_disabled":
      return "History unavailable on this network";
    case "pruned":
      return "Older activity pruned";
    case "private":
      return "Private activity";
    case "unknown":
      return "History temporarily unavailable";
  }
}

/** Re-export the SDK type so consumers using `WalletActivityKind` don't
 *  need to know whether they need the SDK form or the wallet form. */
export type { AddressActivityKind };
