// Monolythium Wallet — EIP-712 / EIP-191 byte helpers.
//
// Pure utilities, no vault concept: hex/utf8 decoding for personal_sign
// payloads and the EIP-712 v4 typed-data digest. Extracted from the
// (deleted) legacy secp256k1 keystore so the v4 ML-DSA module and the SW
// approval-digest preview can share them without importing v3 vault code.
// Depends only on keccak-256.

import { keccak_256 } from "@noble/hashes/sha3.js";

/** Decode a personal_sign payload: a `0x`-prefixed even-length hex string
 *  becomes raw bytes, anything else is UTF-8. Matches the lenient wallet
 *  behaviour dapp libraries expect. */
export function hexOrUtf8ToBytes(s: string): Uint8Array {
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const rest = s.slice(2);
    const len = rest.length / 2;
    if (!Number.isInteger(len)) {
      // Fall back to utf8 if it's not even hex.
      return new TextEncoder().encode(s);
    }
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = parseInt(rest.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new TextEncoder().encode(s);
}

/**
 * Compute the 32-byte EIP-712 v4 digest for a typed-data envelope. Pure
 * function — exported so the popup can preview the digest before the user
 * commits and so tests can assert against fixtures.
 */
export function computeTypedDataDigest(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Uint8Array {
  const domainHash = hashStruct("EIP712Domain", envelope.domain, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const messageHash = hashStruct(envelope.primaryType, envelope.message, {
    EIP712Domain: domainTypeFor(envelope.domain),
    ...envelope.types,
  });
  const out = new Uint8Array(2 + 32 + 32);
  out[0] = 0x19;
  out[1] = 0x01;
  out.set(domainHash, 2);
  out.set(messageHash, 34);
  return keccak_256(out);
}

// Build the `EIP712Domain` type list to match the populated keys in `domain`.
// EIP-712 spec: only the fields actually present in `domain` are encoded, so
// the type list shrinks accordingly.
function domainTypeFor(
  domain: Record<string, unknown>,
): Array<{ name: string; type: string }> {
  const candidates: Array<{ name: string; type: string }> = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ];
  return candidates.filter((c) => domain[c.name] !== undefined);
}

function hashStruct(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const enc = encodeData(primaryType, data, types);
  return keccak_256(enc);
}

function encodeType(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): string {
  const deps = collectTypeDeps(primaryType, types, new Set());
  deps.delete(primaryType);
  const sorted = [primaryType, ...Array.from(deps).sort()];
  return sorted
    .map((t) => {
      const fields = types[t] ?? [];
      return `${t}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
}

function collectTypeDeps(
  type: string,
  types: Record<string, Array<{ name: string; type: string }>>,
  found: Set<string>,
): Set<string> {
  const base = type.replace(/\[.*\]/g, "");
  if (found.has(base)) return found;
  if (!types[base]) return found;
  found.add(base);
  for (const f of types[base]) {
    collectTypeDeps(f.type, types, found);
  }
  return found;
}

function typeHash(
  primaryType: string,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  return keccak_256(new TextEncoder().encode(encodeType(primaryType, types)));
}

function encodeData(
  primaryType: string,
  data: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  const fields = types[primaryType] ?? [];
  const head: Uint8Array[] = [typeHash(primaryType, types)];
  for (const f of fields) {
    head.push(encodeValue(f.type, data[f.name], types));
  }
  return concat(head);
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, Array<{ name: string; type: string }>>,
): Uint8Array {
  // Arrays
  const arr = type.match(/^(.+)\[(\d*)\]$/);
  if (arr) {
    const inner = arr[1]!;
    const items = Array.isArray(value) ? value : [];
    const parts = items.map((v) => encodeValue(inner, v, types));
    return keccak_256(concat(parts));
  }
  // Nested struct
  if (types[type]) {
    return hashStruct(type, (value as Record<string, unknown>) ?? {}, types);
  }
  if (type === "string") {
    const s = typeof value === "string" ? value : String(value ?? "");
    return keccak_256(new TextEncoder().encode(s));
  }
  if (type === "bytes") {
    const b = parseBytes(value);
    return keccak_256(b);
  }
  if (type === "bool") {
    return leftPad32(new Uint8Array([value ? 1 : 0]));
  }
  if (type === "address") {
    const s = typeof value === "string" ? value : "0x0";
    return leftPad32(parseHexBytes(s));
  }
  if (type.startsWith("bytes")) {
    // bytesN — right-pad to 32.
    const b = parseBytes(value);
    return rightPad32(b);
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return leftPad32(intToBytesBE(value));
  }
  // Fallback: treat as string
  const fallback = typeof value === "string" ? value : String(value ?? "");
  return keccak_256(new TextEncoder().encode(fallback));
}

function parseBytes(v: unknown): Uint8Array {
  if (typeof v === "string") return parseHexBytes(v);
  if (v instanceof Uint8Array) return v;
  return new Uint8Array(0);
}

function parseHexBytes(s: string): Uint8Array {
  const r = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (r.length === 0) return new Uint8Array(0);
  const padded = r.length % 2 === 1 ? "0" + r : r;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function intToBytesBE(v: unknown): Uint8Array {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") n = BigInt(v);
  else if (typeof v === "string") {
    n = v.startsWith("0x") || v.startsWith("0X")
      ? BigInt(v)
      : BigInt(v.length === 0 ? "0" : v);
  } else n = 0n;
  if (n < 0n) {
    // Two's-complement for signed types; sufficient for typical EIP-712 payloads.
    n = (1n << 256n) + n;
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return parseHexBytes(hex);
}

function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(b.length - 32);
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

function rightPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(0, 32);
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
