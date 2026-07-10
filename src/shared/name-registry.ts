// Client-side hierarchical name-registry (`0x110E`) helpers for the register /
// transfer flows (§22.8 / whitepaper Law §5.10).
//
// The chain (`mono-core` `name-registry-hierarchical`) re-validates every name
// on submit and is the sole authority — this module exists for fast UX feedback
// and accurate pricing, NOT as a security boundary. It mirrors the structural
// arm of the chain's `validate.rs` at `v0.4.0-testnet` (charset, length,
// category, forbidden prefixes) and re-uses the SDK's frozen encoders + cost
// curve so the previewed name/category/cost are byte-identical to what the tx
// signs.
//
// Scope: a normal EOA wallet can register only **Human** (`<x>.mono`) and
// **Agent** (`<x>.agent.<human>.mono`) names. Cluster needs active-operator
// authority, Contract needs the caller to BE a deployed contract, and System is
// closed (all three gated in `ops.rs::register_op`). The register form is
// therefore scoped to Human + Agent; the other categories are surfaced as
// "not registerable here" rather than silently accepted into a wasted-fee
// revert.

import {
  parseNameCategory,
  nameRegistrationCost,
  encodeNameRegisterCall,
  encodeNameProposeTransferCall,
  encodeNameAcceptTransferCall,
  nameRegistryAddressHex,
  NAME_FALLBACK_FEE_UNIT_LYTHOSHI,
  type NameCategory,
} from "@monolythium/core-sdk";

export {
  encodeNameRegisterCall,
  encodeNameProposeTransferCall,
  encodeNameAcceptTransferCall,
  nameRegistryAddressHex,
};
export type { NameCategory };

/**
 * The chain's visual-impersonation forbidden prefixes, copied **verbatim** from
 * `name-registry-hierarchical/src/validate.rs` `FORBIDDEN_PREFIXES`
 * (v0.4.0-testnet). A primary label starting with one of these reverts
 * `NameForbiddenPrefix` (`0xC8`) — they resemble raw `0x` addresses or bech32m
 * strings (each bech32m entry carries the `1` separator per ADR-0038, so a bare
 * `mono` stem like `monolythium`/`money` is NOT rejected).
 *
 * The SDK's {@link parseNameCategory} does NOT enforce this list (its docstring
 * says "the chain does"), so we mirror it here to spare the user a wasted-fee
 * revert. Frozen (Law §5.10 / ADR-0038); keep in lock-step with the chain.
 */
export const NAME_FORBIDDEN_PREFIXES = [
  "0x",
  "mono1",
  "monoa1",
  "monoc1",
  "monoi1",
  "monok1",
  "monom1",
  "monop1",
  "monor1",
  "monos1",
  "monox1",
] as const;

/** The categories a normal EOA wallet can register (see module header). */
export type RegisterableCategory = "human" | "agent";

export type NameValidationReason =
  | "empty"
  | "malformed"
  | "forbidden-prefix"
  | "not-registerable";

export interface NameValidationOk {
  ok: true;
  /** The exact (already-lowercase) name that will be signed. */
  canonical: string;
  category: NameCategory;
  registerableCategory: RegisterableCategory;
  /** Primary (left-most) label length — the U-curve pricing input. */
  primaryLabelLen: number;
  /** For agent names, the parent `<human>.mono` the caller must own; else null. */
  parentName: string | null;
}

export interface NameValidationErr {
  ok: false;
  reason: NameValidationReason;
  /** Human-readable, ready for inline display. */
  message: string;
}

export type NameValidationResult = NameValidationOk | NameValidationErr;

function firstForbiddenPrefix(label: string): string | null {
  for (const p of NAME_FORBIDDEN_PREFIXES) {
    if (label.startsWith(p)) return p;
  }
  return null;
}

function notRegisterableMessage(category: NameCategory): string {
  switch (category) {
    case "cluster":
      return "Cluster names (.cluster.mono) can only be registered by an active cluster operator.";
    case "contract":
      return "Contract names (.contract.mono) can only be registered by the deployed contract itself.";
    case "system":
      return "System names (.system.mono) are reserved and cannot be registered.";
    default:
      return "This name category cannot be registered from the wallet.";
  }
}

/**
 * Validate + classify a name for registration, scoped to Human / Agent.
 *
 * Runs the SDK's structural `parseNameCategory` (charset `[a-z0-9-]`, label
 * length 1..=63, whole ≤80, `.mono` suffix, structural reserves) then layers
 * the chain's forbidden-prefix gate — on the primary label and, for agent
 * names, on the parent human label too (matching `validate.rs`). Returns an
 * `ok:false` with a display-ready message on any failure; never throws.
 */
export function validateRegisterableName(name: string): NameValidationResult {
  if (name.length === 0) {
    return { ok: false, reason: "empty", message: "Enter a name." };
  }
  // Canonicalization (§22.7): names are lowercase. The chain's charset rejects
  // uppercase anyway, but a clearer message than "invalid character" helps.
  if (name !== name.toLowerCase()) {
    return {
      ok: false,
      reason: "malformed",
      message: "Names are lowercase — use only a-z, 0-9, and hyphens.",
    };
  }

  let parsed: { category: NameCategory; primaryLabelLen: number };
  try {
    parsed = parseNameCategory(name);
  } catch (e) {
    return {
      ok: false,
      reason: "malformed",
      message: (e as Error).message || "That isn't a valid .mono name.",
    };
  }

  const parts = name.split(".");
  const primary = parts[0] ?? "";
  const hit = firstForbiddenPrefix(primary);
  if (hit !== null) {
    return {
      ok: false,
      reason: "forbidden-prefix",
      message: `Names can't start with "${hit}" — it's reserved to avoid resembling an address.`,
    };
  }

  if (parsed.category === "human") {
    return {
      ok: true,
      canonical: name,
      category: "human",
      registerableCategory: "human",
      primaryLabelLen: parsed.primaryLabelLen,
      parentName: null,
    };
  }

  if (parsed.category === "agent") {
    // parts = [label, "agent", human, "mono"]; the chain re-checks the human
    // label for a forbidden prefix (validate.rs), so we do too.
    const humanLabel = parts[2] ?? "";
    const humanHit = firstForbiddenPrefix(humanLabel);
    if (humanHit !== null) {
      return {
        ok: false,
        reason: "forbidden-prefix",
        message: `The parent name can't start with "${humanHit}" — it's reserved.`,
      };
    }
    return {
      ok: true,
      canonical: name,
      category: "agent",
      registerableCategory: "agent",
      primaryLabelLen: parsed.primaryLabelLen,
      parentName: `${humanLabel}.mono`,
    };
  }

  // cluster / contract / system — structurally valid but not wallet-registerable.
  return {
    ok: false,
    reason: "not-registerable",
    message: notRegisterableMessage(parsed.category),
  };
}

/**
 * The fee unit the chain applies to the U-curve, mirroring
 * `ops.rs::effective_fee_unit_lythoshi`: the live block base price when
 * non-zero, else the `1e12` fallback (only on a genesis / tx-less devnet whose
 * base fee reads 0). On a live chain the base price floors at the economic
 * minimum, so this is effectively fixed there — the caller re-quotes right
 * before signing regardless (the tx `value` must equal the cost exactly).
 */
export function nameFeeUnitLythoshi(baseFeeLythoshi: bigint): bigint {
  return baseFeeLythoshi > 0n
    ? baseFeeLythoshi
    : NAME_FALLBACK_FEE_UNIT_LYTHOSHI;
}

/**
 * Exact registration cost in lythoshi — the value the register / accept tx must
 * carry. Wraps the SDK's `nameRegistrationCost` (`base × modX10 × feeUnit / 10`,
 * byte-identical to the chain's `registration_cost_lythoshi_with_unit`).
 * Throws {@link Error} (SDK `NameRegistryError`) for a `system` category or an
 * out-of-range primary-label length — callers validate first, so this is a
 * belt-and-suspenders guard.
 */
export function quoteNameCostLythoshi(
  category: NameCategory,
  primaryLabelLen: number,
  baseFeeLythoshi: bigint,
): bigint {
  return nameRegistrationCost(
    category,
    primaryLabelLen,
    nameFeeUnitLythoshi(baseFeeLythoshi),
  );
}
