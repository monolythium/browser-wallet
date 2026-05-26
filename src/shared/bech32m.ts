// Bech32m address codec — thin shim over @monolythium/core-sdk.
//
// The SDK (mono-core-sdk) owns the bech32m polymod implementation and the
// canonical HRP table per whitepaper §22.7. This module is a wallet-side
// compatibility surface: existing call sites import bech32m helpers and an
// `AddressKind` union with `"eoa"` for the user-account case (the SDK uses
// `"user"`). Keeping the wallet's shape stable while the crypto delegates
// to the SDK is the trade — no duplicated polymod, no diverging HRP table.
//
// Reserved HRPs (monor / monop / monoi / monoa) are not exposed here. The
// wallet never originates them and the SDK rejects them in decode; if a
// user pastes one, `decodeBech32mTyped` surfaces an error rather than
// silently classifying it.

import {
  ADDRESS_KIND_HRPS,
  AddressError,
  addressToTypedBech32,
  typedBech32ToAddress,
  type AddressKind as SdkAddressKind,
} from "@monolythium/core-sdk";

const DEFAULT_HRP = "mono";

/**
 * Whitepaper §22.7 typed-HRP enumeration. The wallet keeps `"eoa"` for the
 * user-account case; the SDK calls the same kind `"user"`. The remaining
 * names match the SDK directly.
 */
export type AddressKind =
  | "eoa"
  | "smartAccount"
  | "contract"
  | "cluster"
  | "multisig"
  | "systemModule";

const WALLET_TO_SDK_KIND: Record<AddressKind, SdkAddressKind> = {
  eoa: "user",
  smartAccount: "smartAccount",
  contract: "contract",
  cluster: "cluster",
  multisig: "multisig",
  systemModule: "systemModule",
};

const SDK_TO_WALLET_KIND: Record<SdkAddressKind, AddressKind> = {
  user: "eoa",
  smartAccount: "smartAccount",
  contract: "contract",
  cluster: "cluster",
  multisig: "multisig",
  systemModule: "systemModule",
};

const HRP_BY_KIND: Record<AddressKind, string> = {
  eoa: ADDRESS_KIND_HRPS.user,
  smartAccount: ADDRESS_KIND_HRPS.smartAccount,
  contract: ADDRESS_KIND_HRPS.contract,
  cluster: ADDRESS_KIND_HRPS.cluster,
  multisig: ADDRESS_KIND_HRPS.multisig,
  systemModule: ADDRESS_KIND_HRPS.systemModule,
};

const KIND_BY_HRP: Record<string, AddressKind> = (() => {
  const out: Record<string, AddressKind> = {};
  for (const [k, hrp] of Object.entries(HRP_BY_KIND) as [AddressKind, string][]) {
    out[hrp] = k;
  }
  return out;
})();

/** Return the bech32m HRP string for an `AddressKind`. */
export function hrpForKind(kind: AddressKind): string {
  return HRP_BY_KIND[kind];
}

/** Return the `AddressKind` for a bech32m HRP, or null if the HRP is
 *  not one of the v4.1 chain-types the wallet originates. */
export function kindForHrp(hrp: string): AddressKind | null {
  return KIND_BY_HRP[hrp] ?? null;
}

/**
 * Encode a 20-byte `0x`-hex address as bech32m with the HRP for the
 * given `AddressKind`. Default kind is `"eoa"` — the user-account case.
 * Accepts both `0x` and `0X` prefixes (some upstreams send the latter).
 */
export function addressToBech32m(addr0x: string, kind: AddressKind = "eoa"): string {
  try {
    return addressToTypedBech32(WALLET_TO_SDK_KIND[kind], normalizeHexPrefix(addr0x));
  } catch (err) {
    throw normalizeError(err, "addressToBech32m");
  }
}

function normalizeHexPrefix(addr: string): string {
  return addr.startsWith("0X") ? `0x${addr.slice(2)}` : addr;
}

/**
 * Decode a bech32m string into a `0x`-hex address. `expectedKind`
 * (default: `"eoa"`) restricts the accepted HRP so a paste of a cluster
 * ID into an EOA recipient field fails at the address layer with a
 * typed error rather than silently routing to the wrong account kind.
 *
 * Pass `expectedKind = null` to accept any v4.1 chain-type HRP and
 * surface the decoded `kind` via `decodeBech32mTyped`.
 */
export function bech32mToAddress(
  bech: string,
  expectedKind: AddressKind | null = "eoa",
): string {
  return decodeBech32mTyped(bech, expectedKind).addr0x;
}

/**
 * Decode a bech32m string into both the `0x`-hex address bytes and the
 * `AddressKind` (derived from the HRP). Throws when the HRP is not a
 * recognized v4.1 chain-type, when the checksum fails, or — when
 * `expectedKind !== null` — when the decoded kind doesn't match.
 */
export function decodeBech32mTyped(
  bech: string,
  expectedKind: AddressKind | null = null,
): { addr0x: string; kind: AddressKind } {
  const sdkExpected =
    expectedKind === null ? undefined : WALLET_TO_SDK_KIND[expectedKind];
  try {
    const typed = typedBech32ToAddress(bech, sdkExpected);
    return { addr0x: typed.hex, kind: SDK_TO_WALLET_KIND[typed.kind] };
  } catch (err) {
    throw normalizeError(err, "decodeBech32mTyped", bech);
  }
}

/**
 * Returns true if the input passes bech32m decode against a v4.1
 * chain-type HRP. Used by `bech32m-typo-detect.ts` to scan candidate
 * substitutions for the one that flips the checksum back to valid.
 */
export function tryDecodeBech32m(
  bech: string,
): { hrp: string; addr0x: string; kind: AddressKind } | null {
  try {
    const typed = typedBech32ToAddress(bech);
    return {
      hrp: HRP_BY_KIND[SDK_TO_WALLET_KIND[typed.kind]],
      addr0x: typed.hex,
      kind: SDK_TO_WALLET_KIND[typed.kind],
    };
  } catch {
    return null;
  }
}

// Truncated form for compact display. Keeps the HRP+`1` prefix visible
// (so the user always sees the network AND the address type) and the
// last 4 chars of the body (so the user can compare against a recipient
// quickly).
export function shortBech32m(
  addr0x: string,
  n = 8,
  kind: AddressKind = "eoa",
): string {
  const bech = addressToBech32m(addr0x, kind);
  const prefix = HRP_BY_KIND[kind] + "1";
  const body = bech.slice(prefix.length);
  if (n <= 0 || body.length <= n + 4 + 1) return bech;
  return prefix + body.slice(0, n) + "…" + body.slice(-4);
}

// Render-time wrapper: convert 0x-shaped EVM addresses to bech32m for
// display, pass through anything that isn't 0x-shaped (demo strings,
// empty/null, already-bech32m). Never throws — render sites must keep
// rendering even if upstream hands us a malformed address.
export function bech32mDisplay(
  addr: string | null | undefined,
  kind: AddressKind = "eoa",
): string {
  if (!addr) return "—";
  if (!(addr.startsWith("0x") || addr.startsWith("0X"))) return addr;
  try {
    return addressToBech32m(addr, kind);
  } catch {
    return addr;
  }
}

export { DEFAULT_HRP };

// SDK's AddressError is the typed envelope; wallet callers historically
// catch a plain Error with a string message. Re-throw as Error so the
// shim doesn't surface SDK-specific types at the API boundary.
function normalizeError(err: unknown, fn: string, input?: string): Error {
  if (err instanceof AddressError) {
    const where = input !== undefined ? ` "${input}"` : "";
    return new Error(`${fn}: ${err.message}${where}`);
  }
  if (err instanceof Error) return err;
  return new Error(`${fn}: ${String(err)}`);
}
