// Bech32m address codec per BIP-350 + whitepaper §22.7.
//
// Wire format on Monolythium chains stays the 20-byte EVM-style address —
// the SDK signs and the chain stores `0x...`. But the user-facing display
// MUST be bech32m with HRP "mono" so users can't be tricked by lookalikes.
// This module is the single source of truth for that conversion.
//
// We deliberately don't pull in a third-party bech32 library: the algorithm
// fits in ~150 lines, and the polymod constant (0x2BC830A3, distinct from
// BIP-173's 1) is the kind of detail that's safer to own outright than to
// trust an upstream's "v1 vs v0 segwit" dispatch with.

const HRP = "mono";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

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

export function addressToBech32m(addr0x: string): string {
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
  return bech32mEncode(HRP, data5);
}

export function bech32mToAddress(bech: string): string {
  const decoded = bech32mDecode(bech);
  if (!decoded) {
    throw new Error(`bech32mToAddress: invalid bech32m string "${bech}"`);
  }
  if (decoded.hrp !== HRP) {
    throw new Error(
      `bech32mToAddress: wrong HRP "${decoded.hrp}", expected "${HRP}"`,
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
  return hex;
}

// Truncated form for compact display. Keeps the "mono1" prefix visible (so
// the user always sees the network) and the last 4 chars of the body (so
// the user can compare against a recipient quickly).
export function shortBech32m(addr0x: string, n = 8): string {
  const bech = addressToBech32m(addr0x);
  const prefix = HRP + "1";
  const body = bech.slice(prefix.length);
  if (n <= 0 || body.length <= n + 4 + 1) return bech;
  return prefix + body.slice(0, n) + "…" + body.slice(-4);
}
