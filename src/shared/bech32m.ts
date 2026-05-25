// Bech32m address codec per BIP-350 + whitepaper §22.7.
//
// Wire format on Monolythium chains stays the 20-byte EVM-style address —
// the SDK signs and the chain stores `0x...`. But the user-facing display
// MUST be bech32m with a per-type HRP discriminator so users can't be
// tricked by lookalikes AND can't accidentally paste a cluster ID into
// an EOA recipient field (the HRP mismatch surfaces as a checksum
// rejection). This module is the single source of truth for that
// conversion.
//
// HRP table (whitepaper §22.7):
//   mono   — user EOA (the default)
//   monos  — smart account / policy account
//   monoc  — Rust/RISC-V contract account
//   monok  — DVT cluster identity
//   monom  — n-of-m multisig
//   monox  — system module / native-module address
//
// Reserved (decode succeeds for `kind`, but the wallet doesn't currently
// originate these): monor (recovery/SLH-DSA), monop (privacy-side),
// monoi (issuer), monoa (agent).
//
// We deliberately don't pull in a third-party bech32 library: the algorithm
// fits in ~150 lines, and the polymod constant (0x2BC830A3, distinct from
// BIP-173's 1) is the kind of detail that's safer to own outright than to
// trust an upstream's "v1 vs v0 segwit" dispatch with.

const DEFAULT_HRP = "mono";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

/**
 * Whitepaper §22.7 typed-HRP enumeration. The string value is the HRP
 * literal used in the bech32m encoding ("mono", "monok", etc.). Keep
 * the enum closed so a misspelled kind is a TypeScript error.
 */
export type AddressKind =
  | "eoa"
  | "smartAccount"
  | "contract"
  | "cluster"
  | "multisig"
  | "systemModule"
  | "reservedRecovery"
  | "reservedPrivacy"
  | "reservedIssuer"
  | "reservedAgent";

const HRP_BY_KIND: Record<AddressKind, string> = {
  eoa: "mono",
  smartAccount: "monos",
  contract: "monoc",
  cluster: "monok",
  multisig: "monom",
  systemModule: "monox",
  reservedRecovery: "monor",
  reservedPrivacy: "monop",
  reservedIssuer: "monoi",
  reservedAgent: "monoa",
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
 *  not one of the v4.1 chain-types. */
export function kindForHrp(hrp: string): AddressKind | null {
  return KIND_BY_HRP[hrp] ?? null;
}

// Generator polynomial coefficients shared with BIP-173.
const GEN: readonly number[] = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    high.push(c >> 5);
    low.push(c & 31);
  }
  return [...high, 0, ...low];
}

function createChecksum(hrp: string, data: readonly number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32M_CONST;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    out.push((mod >> (5 * (5 - i))) & 31);
  }
  return out;
}

function verifyChecksum(hrp: string, data: readonly number[]): boolean {
  return polymod([...hrpExpand(hrp), ...data]) === BECH32M_CONST;
}

// Re-pack a stream of `fromBits`-bit groups into `toBits`-bit groups.
// `pad` controls whether trailing partial groups become a final group
// (encode direction) or signal an error (decode direction).
function convertBits(
  data: readonly number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const v of data) {
    if (v < 0 || v >>> fromBits !== 0) return null;
    acc = ((acc << fromBits) | v) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

// Generic encode/decode at the bech32m layer — exported so tests can pin
// the polymod constant against a known external vector (BIP-350 "a1lqfn3a").
export function bech32mEncode(hrp: string, data5bit: readonly number[]): string {
  const combined = [...data5bit, ...createChecksum(hrp, data5bit)];
  let s = hrp + "1";
  for (const d of combined) {
    if (d < 0 || d >= 32) {
      throw new Error(`bech32mEncode: invalid 5-bit group ${d}`);
    }
    s += CHARSET[d];
  }
  return s;
}

export function bech32mDecode(
  bech: string,
): { hrp: string; data: number[] } | null {
  if (bech.length < 8 || bech.length > 1023) return null;
  // Spec disallows mixed case. Lowercase form is canonical.
  const lower = bech.toLowerCase();
  const upper = bech.toUpperCase();
  if (bech !== lower && bech !== upper) return null;
  const norm = lower;
  const pos = norm.lastIndexOf("1");
  if (pos < 1 || pos + 7 > norm.length) return null;
  const hrp = norm.slice(0, pos);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const data: number[] = [];
  for (let i = pos + 1; i < norm.length; i++) {
    const idx = CHARSET.indexOf(norm[i]!);
    if (idx === -1) return null;
    data.push(idx);
  }
  if (!verifyChecksum(hrp, data)) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}

// Public address codec — what render sites actually call.

/**
 * Encode a 20-byte `0x`-hex address as bech32m with the HRP for the
 * given `AddressKind`. Default kind is `"eoa"` for the user-account
 * case, which is by far the most common render site.
 */
export function addressToBech32m(addr0x: string, kind: AddressKind = "eoa"): string {
  const hex = addr0x.startsWith("0x") || addr0x.startsWith("0X")
    ? addr0x.slice(2)
    : addr0x;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(
      `addressToBech32m: expected 20-byte hex address, got "${addr0x}"`,
    );
  }
  const bytes: number[] = [];
  for (let i = 0; i < 40; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  const data5 = convertBits(bytes, 8, 5, true);
  if (!data5) {
    throw new Error("addressToBech32m: convertBits 8→5 failed");
  }
  return bech32mEncode(HRP_BY_KIND[kind], data5);
}

/**
 * Decode a bech32m string into a `0x`-hex address. The `expectedKind`
 * parameter (default: `"eoa"`) restricts the accepted HRP so a paste
 * of a cluster ID into an EOA recipient field fails at the address
 * layer with a typed error rather than silently routing funds to the
 * wrong account kind.
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
  const decoded = bech32mDecode(bech);
  if (!decoded) {
    throw new Error(`bech32mToAddress: invalid bech32m string "${bech}"`);
  }
  const kind = kindForHrp(decoded.hrp);
  if (kind === null) {
    throw new Error(
      `bech32mToAddress: unrecognized HRP "${decoded.hrp}"`,
    );
  }
  if (expectedKind !== null && kind !== expectedKind) {
    throw new Error(
      `bech32mToAddress: wrong HRP "${decoded.hrp}", expected "${HRP_BY_KIND[expectedKind]}"`,
    );
  }
  const bytes = convertBits(decoded.data, 5, 8, false);
  if (!bytes || bytes.length !== 20) {
    throw new Error(
      `bech32mToAddress: decoded ${bytes?.length ?? 0} bytes, expected 20`,
    );
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return { addr0x: hex, kind };
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

/**
 * Render-time helper that suppresses the `DEFAULT_HRP` token from
 * unused. Re-exporting for clarity in test fixtures.
 */
export { DEFAULT_HRP };
